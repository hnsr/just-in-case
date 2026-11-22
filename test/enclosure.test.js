import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { createCutterOutline } from '../src/cutter-outline.js'
import { buildEnclosure, initGeometry } from '../src/geometry.js'
import { defaultProject, evaluateProject, makeChild, makeFeature, newProject, parseProject, projectJSON } from '../src/project.js'
import { makePrimitive } from '../src/definitions.js'
import { enclosureSTL } from '../src/stl.js'

const geometry = await initGeometry()

function inspectSTL(buffer) {
  const view = new DataView(buffer)
  const triangleCount = view.getUint32(80, true)
  assert.equal(buffer.byteLength, 84 + triangleCount * 50)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  const edges = new Map()
  let volume = 0

  for (let offset = 84; offset < buffer.byteLength; offset += 50) {
    const vertices = [12, 24, 36].map((distance) => [0, 1, 2].map((axis) => {
      const v = view.getFloat32(offset + distance + axis * 4, true)
      assert(Number.isFinite(v))
      min[axis] = Math.min(min[axis], v)
      max[axis] = Math.max(max[axis], v)
      return v
    }))
    const keys = vertices.map((vertex) => vertex.join(','))
    assert.equal(new Set(keys).size, 3, 'triangle vertices must be distinct')
    for (let i = 0; i < 3; i++) {
      const a = keys[i]
      const b = keys[(i + 1) % 3]
      const key = a < b ? a + '/' + b : b + '/' + a
      const [count, direction] = edges.get(key) ?? [0, 0]
      edges.set(key, [count + 1, direction + (a < b ? 1 : -1)])
    }
    const [[ax, ay, az], [bx, by, bz], [cx, cy, cz]] = vertices
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
  }
  for (const [count, direction] of edges.values()) {
    assert.equal(count, 2, 'every STL edge must have two incident triangles')
    assert.equal(direction, 0, 'adjacent faces must use opposite edge directions')
  }
  assert(volume > 0, 'mesh must enclose positive volume')
  const snap = (v) => Number(v.toFixed(4))
  return { min: min.map(snap), max: max.map(snap), volume, triangleCount }
}

function build(project) {
  const { root, issues } = evaluateProject(project)
  if (issues.length) throw new Error(issues[0].message)
  return buildEnclosure(geometry, root)
}

function cutout(side, shape, width, height, offset, z) {
  return { type: 'cutout', properties: { side, shape }, parameters: { width, height, offset, z } }
}

function floorCutter() {
  const cutter = makeChild('repeater')
  cutter.properties.operation = 'cut'
  cutter.parameters.primitive = makePrimitive('cylinder')
  cutter.placement.z = -3
  return cutter
}

function hasVertex(mesh, x, y, z) {
  const { vertices, stride } = mesh
  for (let i = 0; i < vertices.length; i += stride) {
    if (Math.hypot(vertices[i] - x, vertices[i + 1] - y, vertices[i + 2] - z) < 0.001) return true
  }
  return false
}

test('the default base and lid export as closed meshes on the print bed', () => {
  const model = build(defaultProject())
  const base = inspectSTL(enclosureSTL(model, 'base'))
  const lid = inspectSTL(enclosureSTL(model, 'upper'))
  const both = inspectSTL(enclosureSTL(model, 'both'))
  assert.deepEqual(base.min, [-50, -35, 0])
  assert.deepEqual(base.max, [50, 35, 30])
  assert.deepEqual(lid.min, [-50, -35, 0])
  assert.deepEqual(lid.max, [50, 35, 5.6])
  assert.deepEqual(both.min, [-104, -35, 0])
  assert.deepEqual(both.max, [104, 35, 30])
  assert.equal(both.triangleCount, base.triangleCount + lid.triangleCount)
})

test('ports on all four walls remove material and screw posts add it', () => {
  const project = newProject()
  project.root.parameters.radius = 0
  project.root.parameters.lip = 0
  const baseVolume = () => inspectSTL(enclosureSTL(build(project), 'base')).volume
  for (const [side, shape] of [['Front', 'Rectangle'], ['Right', 'Circle'], ['Back', 'Rectangle'], ['Left', 'Circle']]) {
    const before = baseVolume()
    project.root.features.push(cutout(side, shape, 8, 5, 8, 12))
    assert(baseVolume() < before - 90, side + ' port must cut through its wall')
  }
  const portsOnly = baseVolume()
  project.root.children.push(makeChild('pcb-screw-mount'))
  assert(baseVolume() > portsOnly)
  assert.deepEqual(inspectSTL(enclosureSTL(build(project), 'upper')).max, [50, 35, 2.4])
})

test('legacy screw posts open as a positioned PCB screw mount', () => {
  const source = {
    version: 1,
    name: 'Old electronics enclosure',
    body: { width: 100, depth: 70, height: 30, wall: 2.4, floor: 2.4, radius: 5 },
    lid: { thickness: 2.4, lip: 3.2, clearance: 0.25 },
    cutouts: [
      { side: 'Front', shape: 'Rectangle', width: 16, height: 8, offset: -21, z: 12 },
      { side: 'Right', shape: 'Circle', width: 11, height: 8, offset: 9, z: 14 },
    ],
    mounts: { enabled: true, height: 6, diameter: 7, hole: 2.7, inset: 12 },
  }
  const migrated = parseProject(JSON.stringify(source))
  assert.equal(migrated.version, 2)
  assert.equal(migrated.name, source.name)
  assert.deepEqual(migrated.root.features, defaultProject().root.features)
  const [mount] = migrated.root.children
  assert.equal(mount.type, 'pcb-screw-mount')
  assert.deepEqual(mount.parameters, { pitchX: 76, pitchY: 46, height: 6, diameter: 7, pilotDiameter: 2.7, pilotDepth: 6 })
  assert.deepEqual(parseProject(projectJSON(migrated)), migrated)
  const model = build(migrated)
  assert(hasVertex(model.base, 38 + 3.5, 23, 8.4))
  inspectSTL(enclosureSTL(model, 'both'))
  source.mounts.enabled = false
  assert.equal(parseProject(JSON.stringify(source)).root.children.length, 0)
  assert.throws(() => parseProject('{"version":3}'), /version 1 or 2/)
  assert.throws(() => parseProject('['), /valid JSON/)
})

test('PCB screw mounts can be placed and rotated independently with blind pilot holes', () => {
  const project = newProject()
  const a = makeChild('pcb-screw-mount')
  const b = makeChild('pcb-screw-mount')
  Object.assign(a.parameters, { pitchX: 12, pitchY: 10, height: 5, pilotDepth: 3 })
  Object.assign(b.parameters, { pitchX: 12, pitchY: 10 })
  Object.assign(a.placement, { x: -22, angle: 90 })
  Object.assign(b.placement, { x: 22, y: -3 })
  project.root.children.push(a, b)
  const model = build(project)
  assert(hasVertex(model.base, -27 + 3.5, 6, 7.4), 'first post follows the rotated hole pattern')
  assert(hasVertex(model.base, -27 + 1.35, 6, 4.4), 'the pilot stops above the floor')
  assert(hasVertex(model.base, 28 + 3.5, 2, 8.4), 'second post retains its separate placement')
  assert(model.base.runs.some(({ path }) => path === 'root.children.0'))
  assert(model.base.runs.some(({ path }) => path === 'root.children.1'))
  inspectSTL(enclosureSTL(model, 'base'))
})

test('screw closure pairs the base and lid at corner and asymmetric custom positions', () => {
  const project = newProject()
  const feature = makeFeature('screw-closure', project.root)
  project.root.features.push(feature)
  const corners = build(project)
  for (const x of [-38, 38]) {
    for (const y of [-23, 23]) {
      assert(hasVertex(corners.base, x + 4, y, 30))
      assert(hasVertex(corners.upper, x + 1.7, -y, 0))
    }
  }

  feature.properties.layout = 'custom'
  feature.parameters.positions = [{ x: -12, y: -16 }, { x: 23, y: 4 }]
  feature.parameters.counterboreDepth = 1.2
  const custom = build(parseProject(projectJSON(project)))
  for (const { x, y } of feature.parameters.positions) {
    assert(hasVertex(custom.base, x + 4, y, 30), 'the boss touches the inside lid plane')
    assert(hasVertex(custom.base, x + 1.35, y, 23), 'the pilot ends at the configured depth')
    assert(hasVertex(custom.upper, x + 1.7, -y, 2.4), 'the exit hole lines up in assembled coordinates')
    assert(hasVertex(custom.upper, x + 3.1, -y, 0))
    assert(hasVertex(custom.upper, x + 3.1, -y, 1.2), 'the counterbore opens on the outside face')
  }
  inspectSTL(enclosureSTL(custom, 'base'))
  inspectSTL(enclosureSTL(custom, 'upper'))
})

test('screw closures reject duplicate features, unsupported roots, and obstructions', () => {
  const project = newProject()
  const feature = makeFeature('screw-closure', project.root)
  project.root.features.push(feature, structuredClone(feature))
  assert.throws(() => build(project), /only one screw closure/)
  project.root.features.pop()
  for (const unavailable of [newProject('split'), newProject('lidded', false)]) {
    unavailable.root.features.push(structuredClone(feature))
    assert.throws(() => build(unavailable), /requires a lidded enclosure with a lid/)
  }
  feature.parameters.insetX = 3
  assert.throws(() => build(project), /must clear the inner walls/)
  feature.parameters.insetX = 12
  feature.parameters.counterboreDepth = 2
  assert.throws(() => build(project), /material|below the counterbore/)
  feature.parameters.counterboreDepth = 0

  const obstruction = makeChild('repeater')
  obstruction.parameters.count = 1
  Object.assign(obstruction.placement, { x: 38, y: 23 })
  project.root.children.push(obstruction)
  assert.throws(() => build(project), /overlaps another object or cut on the base/)
  Object.assign(obstruction.placement, { part: 'upper', y: -23 })
  assert.throws(() => build(project), /overlaps another object or cut on the lid/)
})

test('split halves stay closed and a seam cutout subtracts from both', () => {
  const project = newProject('split')
  project.root.parameters.seam = 14
  const before = build(project)
  project.root.features.push(cutout('Right', 'Circle', 8, 8, 12, 14))
  const model = build(project)
  const base = inspectSTL(enclosureSTL(model, 'base'))
  const upper = inspectSTL(enclosureSTL(model, 'upper'))
  assert.deepEqual(base.min, [-50, -35, 0])
  assert.deepEqual(base.max, [50, 35, 14])
  assert.deepEqual(upper.min, [-50, -35, 0])
  assert.deepEqual(upper.max, [50, 35, 21.6])
  assert(base.volume < inspectSTL(enclosureSTL(before, 'base')).volume)
  assert(upper.volume < inspectSTL(enclosureSTL(before, 'upper')).volume)
})

test('a lidded enclosure can be instantiated as a base-only project', () => {
  const project = newProject('lidded', false)
  const model = build(parseProject(projectJSON(project)))
  assert.equal(model.upper, null)
  assert.deepEqual(inspectSTL(enclosureSTL(model, 'base')).max, [50, 35, 30])
  assert.throws(() => enclosureSTL(model, 'both'), /requested parts/)
})

test('press-fit clips join the selected part and a cut repeater makes holes', () => {
  const project = newProject('split')
  const initial = build(project)
  const pcb = makeChild('pcb-mount')
  pcb.placement.part = 'upper'
  project.root.children.push(pcb)
  const mounted = build(project)
  assert(inspectSTL(enclosureSTL(mounted, 'upper')).volume > inspectSTL(enclosureSTL(initial, 'upper')).volume)
  assert.deepEqual(mounted.base.triangles, initial.base.triangles)
  const repeated = floorCutter()
  repeated.parameters.count = 3
  repeated.parameters.stepX = 12
  project.root.children.push(repeated)
  const cut = build(project)
  const removed = inspectSTL(enclosureSTL(mounted, 'base')).volume - inspectSTL(enclosureSTL(cut, 'base')).volume
  assert(Math.abs(removed - 3 * Math.PI * 2.5 ** 2 * 2.4) < 1)
  assert.deepEqual(parseProject(projectJSON(project)), project)
})

test('nested placements inherit rotation and position from the parent', () => {
  const project = newProject()
  const parent = makeChild('repeater')
  parent.parameters.count = 1
  parent.placement = { part: 'base', x: 13, y: -7, z: 0, angle: 90 }
  const child = makeChild('repeater', false)
  child.parameters.count = 1
  child.parameters.primitive = makePrimitive('box')
  child.parameters.primitive.parameters = { width: 4, depth: 2, height: 2 }
  child.placement.x = 4
  parent.children.push(child)
  project.root.children.push(parent)

  const { vertices, stride } = build(project).base
  const vertexNear = (x, y, z) => {
    for (let i = 0; i < vertices.length; i += stride) {
      if (Math.hypot(vertices[i] - x, vertices[i + 1] - y, vertices[i + 2] - z) < 0.001) return true
    }
    return false
  }
  assert(vertexNear(12, -1, 4.35))
  assert(!vertexNear(19, -8, 4.35))
})

test('individual repeats can translate and rotate a primitive', () => {
  const project = newProject()
  const pattern = makeChild('repeater')
  Object.assign(pattern.parameters, { count: 2, stepX: 12, turnZ: 90 })
  pattern.parameters.primitive.parameters = { width: 8, depth: 2, height: 3 }
  project.root.children.push(pattern)
  const { vertices, stride } = build(project).base
  const extents = [[], []]
  for (let i = 0; i < vertices.length; i += stride) {
    if (Math.abs(vertices[i + 2] - 5.35) < 0.001) {
      const copy = vertices[i] < -9 ? 0 : 1
      extents[copy].push(Math.abs(vertices[i + 1]))
    }
  }
  assert.deepEqual(extents.map((axis) => Math.max(...axis)), [1, 4])
  pattern.parameters.primitive = makePrimitive('sphere')
  inspectSTL(enclosureSTL(build(project), 'base'))
})

test('preview faces identify their object after nesting, cutting, and splitting the parts', () => {
  const project = newProject('split')
  const clip = makeChild('pcb-mount')
  clip.placement.part = 'upper'
  const parent = makeChild('repeater')
  parent.placement.y = -9
  const nested = makeChild('repeater', false)
  nested.placement.y = 20
  parent.children.push(nested)
  project.root.children.push(clip, parent, floorCutter())
  const { base, upper } = build(project)

  function sourcePaths(mesh) {
    let cursor = 0
    const paths = new Set()
    for (const { path, start, count } of mesh.runs) {
      assert.equal(start, cursor)
      assert(count > 0 && count % 3 === 0)
      cursor += count
      paths.add(path)
    }
    assert.equal(cursor, mesh.triangles.length)
    return [...paths].sort()
  }

  assert.deepEqual(sourcePaths(base), ['root', 'root.children.1', 'root.children.1.children.0', 'root.children.2'])
  assert.deepEqual(sourcePaths(upper), ['root', 'root.children.0'])
  for (const { path, start, count } of base.runs) {
    if (path !== 'root.children.2') continue
    for (const index of base.triangles.subarray(start, start + count)) {
      const z = base.vertices[index * base.stride + 2]
      assert(z >= -0.001 && z <= project.root.parameters.floor + 0.001, 'cut faces belong to the floor holes')
    }
  }
})

test('a configured repeater can switch from adding to cutting without changing its pattern', () => {
  const project = newProject()
  const baseVolume = () => inspectSTL(enclosureSTL(build(project), 'base')).volume
  const emptyVolume = baseVolume()
  const repeater = makeChild('repeater')
  repeater.placement.z = -1
  project.root.children.push(repeater)
  assert.equal(repeater.properties.operation, 'add')
  assert(baseVolume() > emptyVolume)

  const { parameters, placement } = structuredClone(repeater)
  repeater.properties.operation = 'cut'
  assert(baseVolume() < emptyVolume)
  const saved = parseProject(projectJSON(project)).root.children[0]
  assert.equal(saved.properties.operation, 'cut')
  assert.deepEqual(saved.parameters, parameters)
  assert.deepEqual(saved.placement, placement)
})

test('preview cutters retain their full shape and ancestor placement even when they miss material', () => {
  const project = newProject()
  const clean = build(project)
  const outside = floorCutter()
  outside.parameters.count = 2
  outside.placement.x = 85
  const extension = makeChild('repeater', false)
  extension.parameters.count = 1
  extension.placement.x = 12
  outside.children.push(extension)
  const bracket = makeChild('repeater')
  bracket.parameters.count = 1
  Object.assign(bracket.placement, { part: 'upper', x: 12, y: -8, angle: 90 })
  const nested = makeChild('repeater', false)
  nested.properties.operation = 'cut'
  nested.parameters.count = 1
  nested.parameters.primitive.parameters = { width: 2, depth: 1, height: 3 }
  Object.assign(nested.placement, { x: 1, z: 3 })
  bracket.children.push(nested)
  project.root.children.push(outside, bracket)
  const model = build(project)

  function bounds({ vertices, stride }) {
    return [0, 1, 2].map((axis) => {
      const values = Array.from({ length: vertices.length / stride }, (_, i) => vertices[i * stride + axis])
      return [Math.min(...values), Math.max(...values)].map((value) => Number(value.toFixed(3)))
    })
  }

  const missedCutter = model.cutters.get('root.children.0')
  assert.equal(missedCutter.part, 'base')
  assert.deepEqual(bounds(missedCutter), [[82.5, 99.5], [-2.5, 2.5], [-0.65, 5.35]])
  const cleanBase = inspectSTL(enclosureSTL(clean, 'base'))
  const missedBase = inspectSTL(enclosureSTL(model, 'base'))
  assert.deepEqual(missedBase.min, cleanBase.min)
  assert.deepEqual(missedBase.max, cleanBase.max)
  assert(Math.abs(missedBase.volume - cleanBase.volume) < 0.001)
  assert(model.base.runs.every(({ path }) => path === 'root'))
  const nestedCutter = model.cutters.get('root.children.1.children.0')
  assert.equal(nestedCutter.part, 'upper')
  assert.deepEqual(bounds(nestedCutter), [[11.5, 12.5], [-8, -6], [5.35, 8.35]])
  assert.equal(model.cutters.size, 2)
})

test('cutter outlines draw box edges and update a smooth sphere silhouette as the camera orbits', () => {
  const outline = createCutterOutline()
  new THREE.Group().add(outline.line)
  const camera = new THREE.OrthographicCamera()
  const { Manifold } = geometry

  function useSolid(solid) {
    const { vertProperties, triVerts } = solid.getMesh()
    solid.delete()
    outline.set(new THREE.BufferGeometry()
      .setAttribute('position', new THREE.BufferAttribute(vertProperties, 3))
      .setIndex(new THREE.BufferAttribute(triVerts, 1)))
  }

  camera.position.set(2, 3, 5)
  camera.lookAt(0, 0, 0)
  useSolid(Manifold.cube([2, 2, 2]))
  outline.update(camera, 3)
  assert.equal(outline.line.geometry.drawRange.count, 24)

  useSolid(Manifold.sphere(3, 24))
  outline.update(camera, 3)
  const { count } = outline.line.geometry.drawRange
  const firstView = outline.line.geometry.attributes.position.array.slice(0, count * 3)
  assert(count > 0 && count < 150)
  camera.position.set(-5, 2, 3)
  camera.lookAt(0, 0, 0)
  outline.update(camera, 3)
  const secondView = outline.line.geometry.attributes.position.array.slice(0, outline.line.geometry.drawRange.count * 3)
  assert.notDeepEqual(secondView, firstView)
})

test('formulas resolve variables across object, feature, primitive, and placement parameters', () => {
  const project = defaultProject()
  project.variables = [{ name: 'caseWidth', value: 'board + 2 * wall' }, { name: 'board', value: 90 }, { name: 'wall', value: 5 }]
  project.root.parameters.width = '= caseWidth'
  project.root.features[0].parameters.width = '2^3 * wall / 2'
  const child = makeChild('repeater')
  child.placement.x = '-(caseWidth / 5)'
  child.parameters.count = '10 % 3'
  child.parameters.primitive.parameters.height = 'wall'
  project.root.children.push(child)
  const { root, issues } = evaluateProject(project)
  assert.deepEqual(issues, [])
  assert.equal(root.parameters.width, 100)
  assert.equal(root.features[0].parameters.width, 20)
  const resolvedChild = root.children.at(-1)
  assert.equal(resolvedChild.placement.x, -20)
  assert.equal(resolvedChild.parameters.count, 1)
  assert.equal(resolvedChild.parameters.primitive.parameters.height, 5)
  assert.equal(parseProject(projectJSON(project)).root.parameters.width, '= caseWidth')
  assert.doesNotThrow(() => build(project))

  project.variables[1].value = 'caseWidth'
  assert(evaluateProject(project).issues.some(({ message }) => /Circular reference/.test(message)))
  project.variables[1].value = 'missing + 1'
  assert(evaluateProject(project).issues.some(({ message }) => /Unknown variable/.test(message)))
  project.variables[1].value = '1/0'
  assert.throws(() => parseProject(projectJSON(project)), /Division by zero/)
  project.variables[1].value = '1; alert(1)'
  assert.throws(() => parseProject(projectJSON(project)), /Unexpected token/)
})

test('bad placements, kissing cutouts, and colliding parts are rejected before export', () => {
  const project = defaultProject()
  project.root.features = [0, 8].map((offset) => cutout('Front', 'Circle', 8, 8, offset, 12))
  assert.throws(() => build(project), /shared edge/)
  project.root.features[1].parameters.offset = 7
  assert.doesNotThrow(() => build(project))

  const object = makeChild('repeater')
  object.placement.z = 2
  project.root.children.push(object)
  assert.throws(() => build(project), /disconnected/)
  object.placement.z = 0
  object.placement.x = -50
  assert.throws(() => build(project), /outside the assembled case/)

  const split = newProject('split')
  const base = makeChild('repeater')
  const upper = makeChild('repeater')
  base.parameters.primitive.parameters.height = 18
  upper.parameters.primitive.parameters.height = 18
  upper.placement.part = 'upper'
  split.root.children.push(base, upper)
  assert.throws(() => build(split), /intersect when assembled/)
})

test('the preview keeps an out-of-bounds lid repeater at its draft placement until it fits', () => {
  const project = newProject()
  const repeater = makeChild('repeater')
  repeater.placement = { part: 'upper', x: 49, y: -20, z: 0, angle: 90 }
  project.root.children.push(repeater)
  const preview = () => {
    const { root, issues } = evaluateProject(project)
    assert.deepEqual(issues, [])
    return buildEnclosure(geometry, root, { previewInvalidPlacements: true })
  }

  const draft = preview()
  const [issue] = draft.invalidPlacements
  assert.equal(draft.invalidPlacements.length, 1)
  assert.equal(issue.part, 'upper')
  assert.equal(issue.field, 'root.children.0.placement')
  assert.match(issue.message, /Geometry repeater.*lid.*outside the assembled case/)
  assert.match(issue.hint, /Decrease X offset/)
  assert(hasVertex(issue.mesh, 51.5, 12.5, 7.35), 'the guide preserves lid coordinates and the rotated copies')
  assert(draft.upper.runs.every(({ path }) => path === 'root'))
  assert.throws(() => enclosureSTL(draft, 'both'), /outside the assembled case/)
  assert.throws(() => build(project), /outside the assembled case/)

  repeater.placement.x = 12
  repeater.placement.z = -4
  assert.match(preview().invalidPlacements[0].hint, /Increase Z offset/)
  repeater.placement.z = 0
  const fixed = preview()
  assert.deepEqual(fixed.invalidPlacements, [])
  assert(fixed.upper.runs.some(({ path }) => path === 'root.children.0'))
  inspectSTL(enclosureSTL(fixed, 'both'))
})

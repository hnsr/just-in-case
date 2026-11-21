import assert from 'node:assert/strict'
import test from 'node:test'
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
  project.root.features.push(makeFeature('screw-posts', project.root))
  assert(baseVolume() > portsOnly)
  assert.deepEqual(inspectSTL(enclosureSTL(build(project), 'upper')).max, [50, 35, 2.4])
})

test('v1 JSON migrates to the editable hierarchy and preserves both print meshes', () => {
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
  assert.deepEqual(migrated.root, defaultProject().root)
  assert.deepEqual(parseProject(projectJSON(migrated)), migrated)
  assert.deepEqual(enclosureSTL(build(migrated), 'both'), enclosureSTL(build(defaultProject()), 'both'))
  source.mounts.enabled = false
  assert.equal(parseProject(JSON.stringify(source)).root.features.length, 2)
  assert.throws(() => parseProject('{"version":3}'), /version 1 or 2/)
  assert.throws(() => parseProject('['), /valid JSON/)
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
  const repeated = makeChild('repeater', 'cut')
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
  const child = makeChild('repeater', 'add', false)
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
  assert.equal(root.children[0].placement.x, -20)
  assert.equal(root.children[0].parameters.count, 1)
  assert.equal(root.children[0].parameters.primitive.parameters.height, 5)
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

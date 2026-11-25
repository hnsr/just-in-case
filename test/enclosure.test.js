import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { createCutterOutline } from '../src/cutter-outline.js'
import { buildEnclosure, buildSample, initGeometry } from '../src/geometry.js'
import { defaultProject, evaluateProject, evaluateSample, makeChild, newProject, parseProject, projectJSON, screwClosureDraftIssues } from '../src/project.js'
import { LOCATOR_HEIGHT, LOCATOR_RECESS_DEPTH, LOCATOR_SLOT_TRAVEL, cornerFasteners, makePrimitive } from '../src/definitions.js'
import { enclosureSTL, sampleSTL } from '../src/stl.js'

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

function snapFitMount() {
  const mount = makeChild('pcb-corner-mount')
  mount.properties.fastening = 'snap-fit'
  Object.assign(mount.parameters, { seatSize: 6, clipOverhang: 0.35 })
  return mount
}

function hasVertex(mesh, x, y, z) {
  const { vertices, stride } = mesh
  for (let i = 0; i < vertices.length; i += stride) {
    if (Math.hypot(vertices[i] - x, vertices[i + 1] - y, vertices[i + 2] - z) < 0.001) return true
  }
  return false
}

function raycastSurface({ vertices, stride, triangles }) {
  const surface = new THREE.BufferGeometry()
    .setAttribute('position', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(vertices, stride), 3, 0))
    .setIndex(new THREE.BufferAttribute(triangles, 1))
  return new THREE.Mesh(surface, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
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

test('ports on all four walls remove material and PCB corner mounts add it', () => {
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
  project.root.children.push(makeChild('pcb-corner-mount'))
  assert(baseVolume() > portsOnly)
  assert.deepEqual(inspectSTL(enclosureSTL(build(project), 'upper')).max, [50, 35, 2.4])
})

test('a raised cable duct prints with staggered teeth from end to end and from seat to rim', () => {
  const project = newProject()
  const duct = makeChild('cable-duct')
  duct.parameters.baseHeight = 10
  project.root.children.push(duct)
  const model = build(parseProject(projectJSON(project)))
  const surface = raycastSurface(model.base)
  const seat = project.root.parameters.floor + duct.parameters.baseHeight
  const firstHit = (start, direction) => new THREE.Raycaster(new THREE.Vector3(...start), new THREE.Vector3(...direction))
    .intersectObject(surface)[0].point
  const closeTo = (actual, expected) => assert(Math.abs(actual - expected) < 0.001, actual + ' is not close to ' + expected)

  closeTo(firstHit([-4, 0, project.root.parameters.floor + 0.1], [0, 0, 1]).z, seat)
  closeTo(firstHit([-4, 0, seat + 12], [0, 0, -1]).z, seat)
  for (let i = 0; i < 12; i++) {
    const x = -19 + 38 * i / 11
    const side = i % 2 === 0 ? 1 : -1
    closeTo(firstHit([x, 0, seat + 0.01], [0, side, 0]).y, side * 2.1)
    closeTo(firstHit([x, 0, seat + 4.4], [0, side, 0]).y, side * 1.75)
    closeTo(firstHit([x, 0, seat + 4.4], [0, -side, 0]).y, -side * 2.8)
    closeTo(firstHit([x, side * 2.6, seat + 12], [0, 0, -1]).z, seat + 5.65)
  }
  closeTo(firstHit([-19, 0, seat + 4.2], [0, 1, 0]).y, 1.95)
  closeTo(firstHit([-19, 0, seat + 5.4], [0, 1, 0]).y, 2.31)
  for (const side of [1, -1]) {
    const endBevel = firstHit([-side * 19.99, 0, seat + 4.4], [0, side, 0]).y * side
    assert(endBevel > 1.75 && endBevel < 2.8, 'the end tooth reaches the duct end and has a beveled corner')
    closeTo(firstHit([-side * 17.8, 0, seat + 4.4], [0, side, 0]).y, side * 2.8)
  }
  closeTo(firstHit([-24, 0, seat + 2.5], [1, 0, 0]).x, 47.6)
  inspectSTL(enclosureSTL(model, 'both'))
  surface.geometry.dispose()
  surface.material.dispose()
})

test('cable ducts can be placed independently on the enclosure floor', () => {
  const project = newProject('screw-fastened')
  const first = makeChild('cable-duct', true, project.root)
  project.root.children.push(first)
  const second = makeChild('cable-duct', true, project.root)
  assert.notEqual(first.placement.y, second.placement.y)
  project.root.children.push(second)
  project.variables.push({ name: 'cable', value: 6 }, { name: 'exitHeight', value: 15 })
  Object.assign(second.placement, { x: 30, y: 8, angle: 90 })
  Object.assign(second.parameters, { cableDiameter: 'cable', baseHeight: 'exitHeight - 2.4 - cable / 2' })
  second.properties.fit = 'snug'
  const checked = evaluateProject(project)
  assert.deepEqual(checked.issues, [])
  assert.equal(checked.root.children[1].parameters.baseHeight, 9.6)
  assert.equal(checked.root.children[1].properties.fit, 'snug')
  const { base } = build(project)
  assert(hasVertex(base, 37, 28, 12), 'the second seat is rotated and lifted to the prescribed cable center')
  second.parameters.baseWidth = 12
  assert(evaluateProject(project).issues.some(({ field }) => field.endsWith('.baseWidth')))
})

test('a nested cable duct follows its parent, joins its support, and can be hidden or exported', () => {
  const project = newProject()
  const support = makeChild('repeater')
  Object.assign(support.placement, { x: 12, y: -6, angle: 90 })
  Object.assign(support.parameters.primitive.parameters, { width: 26, depth: 20, height: 4 })
  const duct = makeChild('cable-duct', false)
  duct.parameters.baseLength = 20
  Object.assign(duct.placement, { x: 2, y: 1, z: 4 })
  support.children.push(duct)
  project.root.children.push(support)
  const path = 'root.children.0.children.0'
  const root = evaluateProject(project).root
  const model = buildEnclosure(geometry, root, { hiddenPaths: new Set([path]) })
  assert(hasVertex(model.base, 4, 6, 8.35))
  assert(model.base.runs.some((run) => run.path === path))
  assert(!hasVertex(model.visibleParts.base, 4, 6, 8.35))
  inspectSTL(enclosureSTL(model, 'both'))
  const sample = buildSample(geometry, evaluateSample(project, path))
  assert.deepEqual(inspectSTL(sampleSTL(sample)).max, [7, 10, 7.65])

  duct.placement.z = 12
  const draft = buildEnclosure(geometry, evaluateProject(project).root, { preview: true })
  assert.equal(draft.previewIssues[0].field, path + '.placement')
  assert(draft.previewGuides.some(({ mesh }) => hasVertex(mesh, 4, 6, 16.35)))
})

test('a cable duct follows invalid base height and placement as a draft and clears the warning when moved', () => {
  const project = newProject('split')
  const duct = makeChild('cable-duct')
  project.root.children.push(duct)
  const draft = () => buildEnclosure(geometry, evaluateProject(project).root, { preview: true })
  duct.parameters.baseHeight = 42
  let model = draft()
  assert.equal(model.previewIssues[0].field, 'root.children.0.placement')
  assert.match(model.previewIssues[0].message, /extends outside/)
  assert(model.previewGuides.some(({ part, mesh }) => part === 'base' && hasVertex(mesh, 20, 7, 44.4)))
  assert.throws(() => enclosureSTL(model, 'base'), /extends outside/)
  assert.throws(() => build(project), /extends outside/)

  duct.parameters.baseHeight = 14
  duct.placement.y = 24
  model = draft()
  assert.match(model.previewIssues[0].message, /intersects the opposite half/)
  assert(model.previewGuides.length > 0)
  duct.placement.y = 33
  assert.match(draft().previewIssues[0].message, /extends outside/)
  duct.placement.y = 0
  model = draft()
  assert.deepEqual(model.previewIssues, [])
  assert.deepEqual(model.previewGuides, [])
  assert(model.base.height > project.root.parameters.seam)
  inspectSTL(enclosureSTL(model, 'both'))
})

test('a branch sample retains nested cuts and print orientation while unrelated settings are invalid', () => {
  const project = newProject()
  project.root.parameters.width = 'unknownWidth'
  project.variables.push({ name: 'width', value: 12 }, { name: 'unused', value: '1 / 0' })
  const parent = makeChild('repeater')
  Object.assign(parent.placement, { part: 'upper', angle: 90 })
  parent.parameters.primitive.parameters.height = 'unrelated'
  project.root.children.push(parent)
  const target = makeChild('repeater', false)
  Object.assign(target.placement, { x: 12, y: -4, z: 4 })
  Object.assign(target.parameters.primitive.parameters, { width: 'width', depth: 8, height: 3 })
  parent.children.push(target)
  const hole = makeChild('repeater', false)
  hole.properties.operation = 'cut'
  hole.placement.z = -1
  Object.assign(hole.parameters.primitive.parameters, { width: 2, depth: 4, height: 5 })
  const bump = makeChild('repeater', false)
  Object.assign(bump.placement, { x: 4, z: 2.5 })
  Object.assign(bump.parameters.primitive.parameters, { width: 2, depth: 2, height: 2 })
  const reference = makeChild('repeater', false)
  reference.properties.reference = true
  reference.parameters.primitive.parameters.height = 'unknownReferenceHeight'
  target.children.push(hole, bump, reference)

  const path = 'root.children.0.children.0'
  const sample = buildSample(geometry, evaluateSample(project, path))
  const stl = inspectSTL(sampleSTL(sample))
  assert.deepEqual(stl.min, [-4, -6, 0])
  assert.deepEqual(stl.max, [4, 6, 4.5])
  assert(Math.abs(stl.volume - (12 * 8 * 3 - 2 * 4 * 3 + 2 * 2 * 1.5)) < 0.001)
  assert.equal(sample.floatingPieces, 0)
  assert.throws(() => evaluateSample(project, path + '.children.0'), /adds material/)
  assert.throws(() => evaluateSample(project, path + '.children.2'), /adds material/)

  parent.properties.operation = 'cut'
  assert.throws(() => evaluateSample(project, path), /adds material/)
  parent.properties.operation = 'add'
  hole.parameters.primitive.parameters.height = 'unknownHoleHeight'
  assert.throws(() => evaluateSample(project, path), /Unknown variable/)
})

test('samples flag raised separate pieces and keep independent pieces that already touch the bed', () => {
  const project = newProject()
  const pattern = makeChild('repeater')
  Object.assign(pattern.parameters, { count: 3, stepX: 8, stepZ: 2 })
  project.root.children.push(pattern)
  const sample = () => buildSample(geometry, evaluateSample(project, 'root.children.0'))
  assert.equal(sample().floatingPieces, 2)
  assert.deepEqual(inspectSTL(sampleSTL(sample())).min, [-10.5, -2.5, 0])
  pattern.parameters.stepZ = 0
  assert.equal(sample().floatingPieces, 0)
  assert(Math.abs(inspectSTL(sampleSTL(sample())).volume - 375) < 0.001)
})

test('a cable duct sample keeps its full pedestal and skips enclosure clearance checks', () => {
  const project = newProject('split')
  project.root.parameters.floor = 'missingFloor'
  const duct = makeChild('cable-duct')
  Object.assign(duct.placement, { x: 70, angle: 90 })
  duct.parameters.baseHeight = 20
  project.root.children.push(duct)
  project.root.features.push(cutout('Right', 'Circle', 6, 6, 0, 12))
  const path = 'root.children.0'
  const sample = buildSample(geometry, evaluateSample(project, path))
  const stl = inspectSTL(sampleSTL(sample))
  assert.deepEqual(stl.min, [-7, -20, 0])
  assert.deepEqual(stl.max, [7, 20, 25.65])
  assert.equal(sample.floatingPieces, 0)
  assert.throws(() => evaluateSample(project, 'root.features.0'), /non-root object/)
  duct.parameters.baseWidth = 10
  assert.throws(() => evaluateSample(project, path), /base at least 11.2 mm wide/)
})

test('cable duct fit presets adjust the sample grip and the opening under the lip', () => {
  const project = newProject()
  const duct = makeChild('cable-duct')
  project.root.children.push(duct)
  const direction = new THREE.Vector3(0, 1, 0)
  for (const [fit, gap] of [['easy', 5], ['standard', 4.9], ['snug', 4.8]]) {
    duct.properties.fit = fit
    const sample = buildSample(geometry, evaluateSample(project, 'root.children.0'))
    const surface = raycastSurface(sample.mesh)
    const hitY = (x, z) => new THREE.Raycaster(new THREE.Vector3(x, 0, z), direction).intersectObject(surface)[0].point.y
    const seat = duct.parameters.baseHeight
    assert(Math.abs(hitY(-19, seat + 2.5) + 2.8 - gap) < 0.001)
    assert(Math.abs(hitY(-19, seat + 4.4) + 2.8 - (gap - 0.35)) < 0.001)
    assert.equal(sample.floatingPieces, 0)
    assert.deepEqual(inspectSTL(sampleSTL(sample)).max, [20, 7, 7.65])
    surface.geometry.dispose()
    surface.material.dispose()
  }
})

test('project files require the current format version', () => {
  const project = defaultProject()
  const currentVersion = project.version
  assert.deepEqual(parseProject(projectJSON(project)), project)
  for (const version of [1, 2, currentVersion + 1, undefined]) {
    assert.throws(() => parseProject(projectJSON({ ...project, version })),
      { message: 'Choose a Just in Case project with format version ' + currentVersion + '.' })
  }
  assert.throws(() => parseProject('['), /valid JSON/)
})

test('screw corner mounts locate both edges and keep four blind holes at the board insets when rotated', () => {
  const project = newProject()
  const a = makeChild('pcb-corner-mount')
  const b = makeChild('pcb-corner-mount')
  const dimensions = { boardWidth: 18, boardDepth: 16, holeInsetX: 3, holeInsetY: 3 }
  Object.assign(a.parameters, dimensions, { baseHeight: 5 })
  Object.assign(b.parameters, dimensions)
  Object.assign(a.placement, { x: -22, angle: 90 })
  Object.assign(b.placement, { x: 22, y: -3 })
  project.root.children.push(a, b)
  const model = build(project)
  const surface = raycastSurface(model.base)
  const down = new THREE.Vector3(0, 0, -1)
  const zAt = (x, y) => new THREE.Raycaster(new THREE.Vector3(x, y, 20), down).intersectObject(surface)[0].point.z
  const near = (actual, expected) => assert(Math.abs(actual - expected) < 0.001)
  for (const x of [-27, -17]) {
    for (const y of [-6, 6]) near(zAt(x, y), 3.4)
  }
  near(zAt(-26, 5), 7.4)
  near(zAt(-30.5, 6), 9)
  near(zAt(-27, 9.5), 9)
  near(zAt(28, 2), 3.4)
  near(zAt(27, 1), 8.4)
  assert(model.base.runs.some(({ path }) => path === 'root.children.0'))
  assert(model.base.runs.some(({ path }) => path === 'root.children.1'))
  inspectSTL(enclosureSTL(model, 'base'))
  const sample = buildSample(geometry, evaluateSample(project, 'root.children.0'))
  assert.equal(sample.floatingPieces, 0)
  assert.deepEqual(inspectSTL(sampleSTL(sample)).max, [9.8, 10.8, 6.65])
  surface.geometry.dispose()
  surface.material.dispose()
})

test('snap-fit corner samples have four seats, two fixed catches, and relief beside the flexible fingers', () => {
  const project = newProject()
  const mount = snapFitMount()
  project.root.children.push(mount)
  const sample = buildSample(geometry, evaluateSample(project, 'root.children.0'))
  assert.equal(sample.floatingPieces, 0)
  const surface = raycastSurface(sample.mesh)
  const cast = (start, direction) => new THREE.Raycaster(new THREE.Vector3(...start), new THREE.Vector3(...direction))
    .intersectObject(surface).map(({ point }) => point)
  const near = (actual, expected) => assert(Math.abs(actual - expected) < 0.001)
  for (const x of [-17, 17]) {
    for (const y of [-12, 12]) near(cast([x, y, 12], [0, 0, -1])[0].z, 6.05)
    for (const y of [-14.8, 14.8]) near(cast([x, y, 6.1], [0, 0, 1])[0].z, 8)
  }
  for (const x of [-16, 16]) {
    const section = cast([x, -18, 4], [0, 1, 0])
    for (const y of [-16.35, -15.25, -14.6, 16.8]) assert(section.some((point) => Math.abs(point.y - y) < 0.001))
    assert(!cast([Math.sign(x) * 17.8, -18, 7], [0, 1, 0]).some(({ y }) => y < -14))
  }
  inspectSTL(sampleSTL(sample))
  surface.geometry.dispose()
  surface.material.dispose()
})

test('PCB corner mount validation uses the selected mode and rejects intersecting seats or misplaced holes', () => {
  const project = newProject()
  const mount = makeChild('pcb-corner-mount')
  project.root.children.push(mount)
  assert.deepEqual(evaluateProject(project).issues, [])
  mount.parameters.holeInsetX = 1
  mount.parameters.baseHeight = 1
  assert.deepEqual(evaluateProject(project).issues.map(({ field }) => field.split('.').at(-1)), ['holeInsetX', 'baseHeight'])
  const snap = snapFitMount()
  Object.assign(mount.parameters, snap.parameters, { seatSize: 20, pilotDiameter: 'unused' })
  mount.properties.fastening = 'snap-fit'
  assert.throws(() => evaluateSample(project, 'root.children.0'), /Reduce the corner seat size/)
  mount.parameters.seatSize = 6
  assert.deepEqual(evaluateProject(project).issues, [])
})

test('the screw-fastened enclosure has a flat lid and four integral corner bosses with matching holes', () => {
  const project = newProject('screw-fastened', false)
  const p = project.root.parameters
  const { positions, x, y, collarRadius, recessRadius } = cornerFasteners(p)
  assert.deepEqual(project.root.features, [])
  assert.equal(p.lip, undefined)

  const model = build(parseProject(projectJSON(project)))
  const base = inspectSTL(enclosureSTL(model, 'base'))
  const lid = inspectSTL(enclosureSTL(model, 'upper'))
  assert.equal(model.layout.height, p.height + p.thickness)
  assert.equal(base.max[2], p.height + LOCATOR_HEIGHT)
  assert.equal(lid.max[2], p.thickness)
  const baseSurface = raycastSurface(model.base)
  const fromBelow = new THREE.Vector3(0, 0, 1)
  const fromAbove = new THREE.Vector3(0, 0, -1)
  const cast = (point, direction, surface) => new THREE.Raycaster(new THREE.Vector3(...point), direction)
    .intersectObject(surface)
  const closeTo = (actual, expected) => assert(Math.abs(actual - expected) < 0.001, actual + ' is not close to ' + expected)

  for (const [index, position] of positions.entries()) {
    const { x, y } = position
    const [pilotBottom] = cast([x, y, p.height + 2], fromAbove, baseSurface)
    closeTo(pilotBottom.point.z, p.height - p.pilotDepth)
    assert(hasVertex(model.upper, x + p.clearanceDiameter / 2, -y, 0))

    // Between the boss and either wall, the first face from the floor is the rim.
    const wallX = Math.sign(x) * (p.width / 2 - p.wall - 0.1)
    const wallY = Math.sign(y) * (p.depth / 2 - p.wall - 0.1)
    for (const point of [[wallX, y + Math.sign(y) * 1.8], [x + Math.sign(x) * 1.8, wallY]]) {
      const [top] = cast([...point, p.floor + 0.1], fromBelow, baseSurface)
      closeTo(top.point.z, p.height)
    }
    const [bossTop] = cast([x + collarRadius - 0.4, y, p.height + 2], fromAbove, baseSurface)
    closeTo(bossTop.point.z, p.height + (index % 2 === 0 ? LOCATOR_HEIGHT : 0))
  }

  // Measure the underside recesses along and across the line between the screws.
  const lidSurface = raycastSurface(model.upper)
  const along = new THREE.Vector3(x, -y, 0).normalize()
  const across = new THREE.Vector3(-along.y, along.x, 0)
  for (const index of [0, 2]) {
    const position = positions[index]
    for (const [axis, limit] of [[along, recessRadius + (index === 2 ? LOCATOR_SLOT_TRAVEL : 0)], [across, recessRadius]]) {
      const start = new THREE.Vector3(position.x, -position.y, p.thickness - LOCATOR_RECESS_DEPTH / 2)
        .addScaledVector(axis, 3.8)
      const [edge] = cast(start.toArray(), axis.clone().negate(), lidSurface)
      assert(Math.abs(3.8 - edge.distance - limit) < 0.005)
    }
  }
  baseSurface.geometry.dispose()
  baseSurface.material.dispose()
  lidSurface.geometry.dispose()
  lidSurface.material.dispose()
})

test('a counterbore leaves solid lid thickness above the locating recess', () => {
  const project = newProject('screw-fastened')
  const p = project.root.parameters
  p.counterboreDepth = 1.2
  const model = build(project)
  for (const { x, y } of cornerFasteners(p).positions) {
    assert(hasVertex(model.upper, x + p.counterboreDiameter / 2, -y, 0))
    assert(hasVertex(model.upper, x + p.counterboreDiameter / 2, -y, 1.2))
  }
  inspectSTL(enclosureSTL(model, 'both'))
  p.counterboreDepth = 1.4
  assert.throws(() => build(project), /between it and the locating recess/)
})

test('screw-fastened drafts show invalid dimensions and collisions while blocking export', () => {
  const project = newProject('screw-fastened')
  const p = project.root.parameters
  const { x, y } = cornerFasteners(p)
  const preview = () => {
    const { root, issues } = evaluateProject(project)
    return buildEnclosure(geometry, root, { preview: true, screwIssues: screwClosureDraftIssues(root, issues) })
  }

  p.bossDiameter = 4
  let model = preview()
  const draft = cornerFasteners(p)
  assert.deepEqual(model.previewIssues.map(({ field }) => field), ['root.parameters.bossDiameter'])
  assert(model.previewGuides.some(({ part, mesh }) => part === 'base' && hasVertex(mesh, draft.x - 2, draft.y, p.height)))
  assert(model.previewGuides.some(({ part, outline }) => part === 'upper' && outline))
  assert.equal(model.base.height, p.height)
  assert.throws(() => enclosureSTL(model, 'both'), /support the locating collar/)

  p.bossDiameter = 8
  p.counterboreDepth = 'missing'
  model = preview()
  assert.match(model.previewIssues[0].message, /Unknown variable/)
  assert.equal(model.previewGuides.filter(({ part }) => part === 'upper').length, 6, 'through holes and locator recesses remain visible')
  p.counterboreDepth = 1.2

  const obstruction = makeChild('repeater')
  Object.assign(obstruction.parameters.primitive.parameters, { width: 4, depth: 4 })
  Object.assign(obstruction.placement, { x, y })
  project.root.children.push(obstruction)
  assert.throws(() => build(project), /overlaps another object or cut on the base/)
  Object.assign(obstruction.placement, { part: 'upper', x: x - 0.7, y: -y + 0.7 })
  model = preview()
  assert.match(model.previewIssues[0].message, /overlaps another object or cut on the lid/)
  assert(model.previewGuides.some(({ part }) => part === 'base'))
  assert(model.upper.runs.some(({ path }) => path === 'root.children.0'))
  assert.throws(() => enclosureSTL(model, 'both'), /overlaps another object/)

  obstruction.placement.x = 0
  model = preview()
  assert.deepEqual(model.previewIssues, [])
  assert.deepEqual(model.previewGuides, [])
  inspectSTL(enclosureSTL(model, 'both'))
})

test('a screw draft still checks the enclosure constraints before building', () => {
  const project = newProject('screw-fastened')
  Object.assign(project.root.parameters, { radius: 36, pilotDepth: '' })
  const { root, issues } = evaluateProject(project)
  assert(issues.some(({ field }) => field === 'root.parameters.radius'))
  assert.deepEqual(screwClosureDraftIssues(root, issues), [])
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

test('the split lip has a 45 degree print-side shoulder and preserves its mating faces', () => {
  for (const parameters of [{ radius: 5 }, { radius: 3 }, { radius: 3, seam: 27.9, clearance: 2 }]) {
    const project = newProject('split')
    const p = Object.assign(project.root.parameters, parameters)
    const model = build(project)
    const top = model.layout.upperHeight
    const upper = raycastSurface(model.upper)
    function sideHits(z) {
      const ray = new THREE.Raycaster(new THREE.Vector3(0, 1.3, z), new THREE.Vector3(1, 0, 0))
      return ray.intersectObject(upper).map(({ point }) => point.x)
    }
    const closeTo = (actual, expected) => assert(Math.abs(actual - expected) < 0.001, actual + ' is not close to ' + expected)

    closeTo(sideHits(top - 1.1)[0] - sideHits(top - 0.3)[0], 0.8)
    const fitFace = p.width / 2 - p.wall - p.clearance
    const [lipInside, lipOutside] = sideHits(top + p.lip / 2)
    closeTo(lipInside, fitFace - 1.6)
    closeTo(lipOutside, fitFace)
    inspectSTL(enclosureSTL(model, 'both'))
    const stl = new DataView(enclosureSTL(model, 'upper'))
    for (let offset = 84; offset < stl.byteLength; offset += 50) {
      const normalZ = stl.getFloat32(offset + 8, true)
      const height = stl.getFloat32(offset + 20, true)
      if (normalZ >= 0 || height === 0) continue
      const horizontal = Math.hypot(stl.getFloat32(offset, true), stl.getFloat32(offset + 4, true))
      assert(-normalZ <= horizontal + 0.001, 'sloped faces stay printable through rounded and square corners')
    }
    upper.geometry.dispose()
    upper.material.dispose()
  }
})

test('seam cutouts follow the split and clear the upper lip across the cable width', () => {
  const project = newProject('split')
  project.root.parameters.lip = 5
  const exit = cutout('Right', 'Circle', 6, 6, 12, 'unusedCenter')
  exit.properties.placement = 'seam'
  project.root.features.push(exit)
  const saved = parseProject(projectJSON(project))
  assert.equal(saved.root.features[0].properties.placement, 'seam')

  for (const seam of [14, 18]) {
    saved.root.parameters.seam = seam + ' + 0'
    const model = build(saved)
    const upperSeam = model.layout.upperHeight
    assert(hasVertex(model.base, 50, 12, seam - 3))
    assert(hasVertex(model.upper, 50, -12, upperSeam - 3))

    const upper = raycastSurface(model.upper)
    function hitsWall(y, z) {
      const ray = new THREE.Raycaster(new THREE.Vector3(51, -y, z), new THREE.Vector3(-1, 0, 0), 0, 10)
      return ray.intersectObject(upper).length > 0
    }

    for (const depth of [0.2, 2.5, 4.8]) {
      for (const y of [9.2, 12, 14.8]) {
        assert(!hitsWall(y, upperSeam + depth), 'the full cable width clears the lip all the way to its edge')
      }
    }
    assert(hitsWall(16, upperSeam + 4.8), 'lip material beside the opening still locates the halves')
    assert(hitsWall(14.8, upperSeam - 2.5), 'the outer wall retains the round bore profile')
    upper.geometry.dispose()
    upper.material.dispose()
    inspectSTL(enclosureSTL(model, 'both'))
  }

  saved.root.features[0].parameters.width = 30
  const { issues } = evaluateProject(saved)
  assert(issues.some(({ field, message }) => field.endsWith('.width') && /move the split seam/.test(message)))
})

test('a lidded enclosure can be instantiated as a base-only project', () => {
  const project = newProject('lidded', false)
  const model = build(parseProject(projectJSON(project)))
  assert.equal(model.upper, null)
  assert.deepEqual(inspectSTL(enclosureSTL(model, 'base')).max, [50, 35, 30])
  assert.throws(() => enclosureSTL(model, 'both'), /requested parts/)
})

test('snap-fit mounts join the selected part and a cut repeater makes holes', () => {
  const project = newProject('split')
  const initial = build(project)
  const pcb = snapFitMount()
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
  const clip = snapFitMount()
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
  for (const { path, start, count, visiblePath } of base.runs) {
    if (path !== 'root.children.2') continue
    assert.equal(visiblePath, 'root', 'cutter faces remain with the enclosure when the cutter guide is hidden')
    for (const index of base.triangles.subarray(start, start + count)) {
      const z = base.vertices[index * base.stride + 2]
      assert(z >= -0.001 && z <= project.root.parameters.floor + 0.001, 'cut faces belong to the floor holes')
    }
  }
})

test('hiding additions restores the surfaces they join and preserves the printable model', () => {
  const project = newProject()
  project.root.children.push(floorCutter())
  const clean = build(project)
  const baseBox = makeChild('repeater')
  const lidBox = makeChild('repeater')
  Object.assign(baseBox.placement, { x: 45.5, y: 12 })
  lidBox.placement.part = 'upper'
  Object.assign(baseBox.parameters.primitive.parameters, { width: 7, depth: 12, height: 8 })
  project.root.children.push(baseBox, lidBox)
  const complete = build(project)
  const { root } = evaluateProject(project)
  const hidden = buildEnclosure(geometry, root, {
    preview: true,
    hiddenPaths: new Set(['root.children.0', 'root.children.1', 'root.children.2']),
  })

  for (const part of ['base', 'upper']) {
    const shown = hidden.visibleParts[part]
    assert.deepEqual(shown.vertices, clean[part].vertices)
    assert.deepEqual(shown.triangles, clean[part].triangles)
    assert.deepEqual(enclosureSTL(hidden, part), enclosureSTL(complete, part))
    assert(inspectSTL(enclosureSTL(complete, part)).volume > inspectSTL(enclosureSTL(clean, part)).volume)
  }
  assert(hidden.visibleParts.base.runs.some(({ path }) => path === 'root.children.0'), 'the hidden cutter still cuts the visible floor')
})

test('hiding an additive child restores its parent and preserves the rest of the branch', () => {
  const project = newProject('lidded', false)
  const parent = makeChild('repeater')
  project.root.children.push(parent)
  const clean = build(project).base
  const child = makeChild('repeater', false)
  Object.assign(child.placement, { x: 2, z: 3 })
  parent.children.push(child)
  const preview = buildEnclosure(geometry, evaluateProject(project).root, {
    preview: true,
    hiddenPaths: new Set(['root.children.0.children.0']),
  })

  assert.deepEqual(preview.visibleParts.base.vertices, clean.vertices)
  assert.deepEqual(preview.visibleParts.base.triangles, clean.triangles)
  assert(preview.base.runs.some(({ path }) => path === 'root.children.0.children.0'))
})

test('hiding a support keeps the visible object and the original placement diagnostics', () => {
  const project = newProject('lidded', false)
  const support = makeChild('repeater')
  const attached = makeChild('repeater')
  const floating = makeChild('repeater')
  attached.placement.z = 4.5
  Object.assign(floating.placement, { x: 10, z: 4.5 })
  project.root.children.push(support, attached, floating)
  const preview = buildEnclosure(geometry, evaluateProject(project).root, {
    preview: true,
    hiddenPaths: new Set(['root.children.0']),
  })

  assert.deepEqual(preview.previewIssues.map(({ field }) => field), ['root.children.2.placement'])
  assert.deepEqual(preview.previewGuides.map(({ paths }) => paths), [['root.children.2']])
  assert.deepEqual(new Set(preview.visibleParts.base.runs.map(({ path }) => path)), new Set(['root', 'root.children.1']))
})

test('geometry starts as one shape and can add or cut a repeated pattern', () => {
  const project = newProject()
  const baseVolume = () => inspectSTL(enclosureSTL(build(project), 'base')).volume
  const emptyVolume = baseVolume()
  const repeater = makeChild('repeater')
  assert.equal(repeater.name, 'Geometry')
  assert.equal(repeater.parameters.count, 1)
  repeater.placement.z = -1
  project.root.children.push(repeater)
  assert.equal(repeater.properties.operation, 'add')
  const singleVolume = baseVolume()
  assert(singleVolume > emptyVolume)
  repeater.parameters.count = 4
  assert(baseVolume() > singleVolume)

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
  repeater.parameters.count = 4
  repeater.placement = { part: 'upper', x: 49, y: -20, z: 0, angle: 90 }
  project.root.children.push(repeater)
  const preview = () => {
    const { root, issues } = evaluateProject(project)
    assert.deepEqual(issues, [])
    return buildEnclosure(geometry, root, { preview: true })
  }

  const draft = preview()
  const [issue] = draft.previewIssues
  const [guide] = draft.previewGuides
  assert.equal(draft.previewIssues.length, 1)
  assert.equal(guide.part, 'upper')
  assert.equal(issue.field, 'root.children.0.placement')
  assert.match(issue.message, /Geometry.*lid.*outside the assembled case/)
  assert.match(issue.hint, /Decrease X offset/)
  assert(hasVertex(guide.mesh, 51.5, 12.5, 7.35), 'the guide preserves lid coordinates and the rotated copies')
  assert(draft.upper.runs.every(({ path }) => path === 'root'))
  assert.throws(() => enclosureSTL(draft, 'both'), /outside the assembled case/)
  assert.throws(() => build(project), /outside the assembled case/)

  repeater.placement.x = 12
  repeater.placement.z = -4
  assert.match(preview().previewIssues[0].hint, /Increase Z offset/)
  repeater.placement.z = 0
  const fixed = preview()
  assert.deepEqual(fixed.previewIssues, [])
  assert(fixed.upper.runs.some(({ path }) => path === 'root.children.0'))
  inspectSTL(enclosureSTL(fixed, 'both'))
})

test('floating geometry follows edits in the base and lid previews until it reconnects', () => {
  for (const part of ['base', 'upper']) {
    const project = newProject('lidded', part === 'upper')
    const object = makeChild('repeater')
    object.placement.part = part
    project.root.children.push(object)
    const preview = () => buildEnclosure(geometry, evaluateProject(project).root, { preview: true })

    for (const z of [2, 8]) {
      object.placement.z = z
      const draft = preview()
      const [issue] = draft.previewIssues
      const [guide] = draft.previewGuides
      assert.equal(issue.field, 'root.children.0.placement')
      assert.match(issue.message, /disconnected/)
      assert.match(issue.hint, /Decrease Z offset/)
      assert.equal(guide.part, part)
      assert(hasVertex(guide.mesh, -12.5, 2.5, 7.35 + z))
      assert(draft[part].runs.every(({ path }) => path === 'root'))
      assert.throws(() => enclosureSTL(draft, part), /disconnected/)
      assert.throws(() => build(project), /disconnected/)
    }

    object.placement.z = 0
    const fixed = preview()
    assert.deepEqual(fixed.previewIssues, [])
    assert.deepEqual(fixed.previewGuides, [])
    assert(fixed[part].runs.some(({ path }) => path === 'root.children.0'))
    inspectSTL(enclosureSTL(fixed, part))
  }
})

test('only the loose copies appear as guides when nested geometry is partly attached', () => {
  const project = newProject()
  const parent = makeChild('repeater')
  parent.placement.x = 0
  Object.assign(parent.parameters.primitive.parameters, { width: 8, depth: 8, height: 8 })
  const child = makeChild('repeater', false)
  Object.assign(child.placement, { x: 5, z: 3 })
  Object.assign(child.parameters, { count: 2, stepX: 10 })
  parent.children.push(child)
  project.root.children.push(parent)

  const draft = buildEnclosure(geometry, evaluateProject(project).root, { preview: true })
  assert.deepEqual(draft.previewIssues.map(({ field }) => field), ['root.children.0.children.0.placement'])
  assert.equal(draft.previewGuides.length, 1)
  assert(hasVertex(draft.previewGuides[0].mesh, 17.5, 2.5, 10.35))
  assert(draft.base.runs.some(({ path }) => path === 'root.children.0.children.0'))
  assert(hasVertex(draft.base, 7.5, 2.5, 10.35))
  assert(!hasVertex(draft.base, 17.5, 2.5, 10.35))
})

test('a reference branch inherits transforms and stays out of both printable parts', () => {
  const project = newProject()
  const original = enclosureSTL(build(project), 'both')
  const board = makeChild('repeater')
  board.properties.operation = 'cut'
  board.properties.reference = true
  Object.assign(board.placement, { part: 'upper', x: 90, y: 24, z: 11, angle: 90 })
  const connector = makeChild('repeater', false)
  connector.properties.reference = false
  Object.assign(connector.placement, { x: 7, y: 2, z: 3 })
  const mounts = makeChild('pcb-corner-mount', false)
  board.children.push(connector, mounts)
  project.root.children.push(board)

  const saved = parseProject(projectJSON(project))
  assert.equal(saved.root.children[0].properties.reference, true)
  assert.equal(saved.root.children[0].children[0].properties.reference, false)
  let model = build(saved)
  assert.deepEqual(model.previewIssues, [])
  assert.deepEqual(enclosureSTL(model, 'both'), original)
  assert.equal(model.cutters.size, 0)
  assert.equal(model.references.length, 3)
  assert(model.references.every(({ part }) => part === 'upper'))
  const boardMesh = model.references.find(({ path }) => path === 'root.children.0').mesh
  const connectorMesh = model.references.find(({ path }) => path === 'root.children.0.children.0').mesh
  assert(hasVertex(boardMesh, 92.5, 26.5, 18.35))
  assert(hasVertex(connectorMesh, 90.5, 33.5, 21.35))

  Object.assign(board.placement, { part: 'base', x: 0, y: 0, z: -3, angle: 0 })
  model = build(project)
  assert.deepEqual(enclosureSTL(model, 'both'), original, 'reference cutters do not remove floor material')
  board.children.length = 0
  board.properties.reference = false
  model = build(project)
  assert.equal(model.references.length, 0)
  assert.equal(model.cutters.size, 1)
  assert.notDeepEqual(enclosureSTL(model, 'both'), original)
})

test('a reference child keeps its position relative to a printable parent', () => {
  const project = newProject('lidded', false)
  const parent = makeChild('repeater')
  parent.placement.angle = 90
  project.root.children.push(parent)
  const original = enclosureSTL(build(project), 'base')
  const reference = makeChild('repeater', false)
  reference.properties.reference = true
  Object.assign(reference.placement, { x: 115, y: 6, z: -10 })
  parent.children.push(reference)

  const model = build(project)
  const [guide] = model.references
  assert.equal(guide.path, 'root.children.0.children.0')
  assert(hasVertex(guide.mesh, -18.5, 117.5, -2.65))
  assert.deepEqual(enclosureSTL(model, 'base'), original)
})

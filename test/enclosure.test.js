import assert from 'node:assert/strict'
import test from 'node:test'
import { buildEnclosure, initGeometry } from '../src/geometry.js'
import { defaultProject, parseProject, projectJSON, validateProject } from '../src/project.js'
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

test('the default base and lid export as closed mm meshes oriented on the print bed', () => {
  const project = defaultProject()
  const model = buildEnclosure(geometry, project)
  const base = inspectSTL(enclosureSTL(model, 'base', project.body.width))
  const lid = inspectSTL(enclosureSTL(model, 'lid', project.body.width))
  const both = inspectSTL(enclosureSTL(model, 'both', project.body.width))
  assert.deepEqual(base.min, [-50, -35, 0])
  assert.deepEqual(base.max, [50, 35, 30])
  assert.deepEqual(lid.min, [-50, -35, 0])
  assert.deepEqual(lid.max, [50, 35, 5.6])
  assert.deepEqual(both.min, [-104, -35, 0])
  assert.deepEqual(both.max, [104, 35, 30])
  assert.equal(both.triangleCount, base.triangleCount + lid.triangleCount)
})

test('ports on all four walls remove material and mounts add material', () => {
  const project = defaultProject()
  project.body.radius = 0
  project.lid.lip = 0
  project.cutouts = []
  project.mounts.enabled = false
  const baseVolume = () => inspectSTL(enclosureSTL(buildEnclosure(geometry, project), 'base', project.body.width)).volume
  const noFeatures = baseVolume()
  for (const [side, shape] of [['Front', 'Rectangle'], ['Right', 'Circle'], ['Back', 'Rectangle'], ['Left', 'Circle']]) {
    const before = baseVolume()
    project.cutouts.push({ side, shape, width: 8, height: 5, offset: 8, z: 12 })
    assert(baseVolume() < before - 90, side + ' port must cut through its wall')
  }
  const portsOnly = baseVolume()
  project.mounts.enabled = true
  assert(baseVolume() > portsOnly)
  const flatLid = inspectSTL(enclosureSTL(buildEnclosure(geometry, project), 'lid', project.body.width))
  assert.deepEqual(flatLid.max, [50, 35, 2.4])
  assert(noFeatures > portsOnly)
})

test('project JSON round-trips all parameters and rejects invalid or incompatible projects', () => {
  const project = defaultProject()
  project.name = 'Board prototype'
  project.body.width = 112.2
  project.lid.clearance = 0.375
  project.mounts.enabled = false
  assert.deepEqual(parseProject(projectJSON(project)), project)
  assert.deepEqual(validateProject(project), [])

  project.cutouts[0].z = 2
  assert(validateProject(project).some(({ field }) => field === 'cutouts.0.z'))
  assert.throws(() => parseProject(projectJSON(project)), /above the floor/)
  assert.throws(() => buildEnclosure(geometry, project), /above the floor/)
  assert.throws(() => parseProject('{"version":2}'), /version 1/)
  assert.throws(() => parseProject('['), /valid JSON/)
})

test('cutouts that touch at a point are caught before export', () => {
  const project = defaultProject()
  project.cutouts = [0, 8].map((offset) => ({
    side: 'Front', shape: 'Circle', width: 8, height: 8, offset, z: 12,
  }))
  assert.throws(() => buildEnclosure(geometry, project), /shared edge/)
  project.cutouts[1].offset = 7
  assert.doesNotThrow(() => buildEnclosure(geometry, project))
})

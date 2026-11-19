import createManifold from 'manifold-3d'
import { lidRimWidth, validateProject } from './project.js'

const ARC_STEPS = 16
const BOOLEAN_OVERLAP = 0.05

export async function initGeometry(wasmURL) {
  const module = await createManifold(wasmURL ? { locateFile: () => wasmURL } : undefined)
  module.setup()
  return module
}

function roundedRectangle(width, depth, radius) {
  const x = width / 2
  const y = depth / 2
  if (radius === 0) return [[x, y], [-x, y], [-x, -y], [x, -y]]

  const centers = [[x - radius, y - radius], [-x + radius, y - radius],
    [-x + radius, -y + radius], [x - radius, -y + radius]]
  return centers.flatMap(([cx, cy], corner) => Array.from({ length: ARC_STEPS + 1 }, (_, step) => {
    const angle = (corner + step / ARC_STEPS) * Math.PI / 2
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]
  }))
}

function hasClosedEdges(vertices, triangles, stride) {
  // STL welds by position, including vertices Manifold duplicated for shading.
  const positions = new Map()
  const indices = []
  for (let i = 0; i < vertices.length; i += stride) {
    const key = [vertices[i], vertices[i + 1], vertices[i + 2]].join(',')
    if (!positions.has(key)) positions.set(key, positions.size)
    indices.push(positions.get(key))
  }
  const edges = new Map()
  for (let i = 0; i < triangles.length; i += 3) {
    const a = indices[triangles[i]]
    const b = indices[triangles[i + 1]]
    const c = indices[triangles[i + 2]]
    if (a === b || b === c || c === a) return false
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const direction = from < to ? 1 : -1
      const key = Math.min(from, to) * positions.size + Math.max(from, to)
      if (!edges.has(key)) edges.set(key, direction)
      else if (edges.get(key) === -direction) edges.set(key, 0)
      else return false
    }
  }
  return [...edges.values()].every((balance) => balance === 0)
}

export function buildEnclosure({ Manifold }, project) {
  const [issue] = validateProject(project)
  if (issue) throw new Error(issue.message)

  const { body, lid, mounts, cutouts } = project
  const owned = []
  const own = (solid) => {
    owned.push(solid)
    return solid
  }
  const box = (size, position) => own(own(Manifold.cube(size, true)).translate(position))
  const cylinder = (length, radius) => own(Manifold.cylinder(length, radius, radius, 64, true))
  const prism = (inset, height, z = 0) => {
    const contour = roundedRectangle(body.width - 2 * inset, body.depth - 2 * inset, Math.max(0, body.radius - inset))
    const solid = own(Manifold.extrude([contour], height))
    return z === 0 ? solid : own(solid.translate([0, 0, z]))
  }
  const subtract = (solid, tools) => tools.length ? own(Manifold.difference([solid, ...tools])) : solid

  function opening(cutout) {
    const horizontal = cutout.side === 'Front' || cutout.side === 'Back'
    const sign = cutout.side === 'Left' || cutout.side === 'Front' ? -1 : 1
    const center = sign * ((horizontal ? body.depth : body.width) / 2 - body.wall / 2)
    const position = horizontal ? [cutout.offset, center, cutout.z] : [center, cutout.offset, cutout.z]
    const length = body.wall + 2 * BOOLEAN_OVERLAP
    if (cutout.shape === 'Rectangle') {
      const size = horizontal ? [cutout.width, length, cutout.height] : [length, cutout.width, cutout.height]
      return box(size, position)
    }
    const rotation = horizontal ? [90, 0, 0] : [0, 90, 0]
    return own(own(cylinder(length, cutout.width / 2).rotate(rotation)).translate(position))
  }

  function mesh(solid, part) {
    if (solid.status() !== 'NoError' || solid.isEmpty()) {
      throw new Error('The current dimensions could not generate a solid enclosure.')
    }
    const shaded = own(solid.calculateNormals(0, 45)).getMesh()
    const model = {
      vertices: new Float32Array(shaded.vertProperties),
      triangles: new Uint32Array(shaded.triVerts),
      stride: shaded.numProp,
    }
    if (!hasClosedEdges(model.vertices, model.triangles, model.stride)) {
      throw new Error(part === 'base'
        ? 'The base has a collapsed or shared edge. Adjust the body dimensions or move cutouts that just touch.'
        : 'The lid has a collapsed or shared edge. Adjust the lip depth or clearance.')
    }
    return model
  }

  try {
    const outside = prism(0, body.height)
    const cavity = prism(body.wall, body.height - body.floor + BOOLEAN_OVERLAP, body.floor)
    let base = subtract(outside, [cavity, ...cutouts.map(opening)])

    if (mounts.enabled) {
      const posts = []
      const holes = []
      const x = body.width / 2 - mounts.inset
      const y = body.depth / 2 - mounts.inset
      for (const [px, py] of [[x, y], [-x, y], [-x, -y], [x, -y]]) {
        posts.push(own(cylinder(mounts.height + BOOLEAN_OVERLAP, mounts.diameter / 2)
          .translate([px, py, body.floor + (mounts.height - BOOLEAN_OVERLAP) / 2])))
        holes.push(own(cylinder(mounts.height + BOOLEAN_OVERLAP, mounts.hole / 2)
          .translate([px, py, body.floor + (mounts.height + BOOLEAN_OVERLAP) / 2])))
      }
      base = subtract(own(Manifold.union([base, ...posts])), holes)
    }

    let top = prism(0, lid.thickness)
    if (lid.lip > 0) {
      const fit = body.wall + lid.clearance
      const bottom = lid.thickness - BOOLEAN_OVERLAP
      const outerRim = prism(fit, lid.lip + BOOLEAN_OVERLAP, bottom)
      const innerRim = prism(fit + lidRimWidth(body), lid.lip + 3 * BOOLEAN_OVERLAP, bottom - BOOLEAN_OVERLAP)
      top = own(top.add(subtract(outerRim, [innerRim])))
    }

    return { base: mesh(base, 'base'), lid: mesh(top, 'lid') }
  } finally {
    for (const solid of owned.reverse()) solid.delete()
  }
}

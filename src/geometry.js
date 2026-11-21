import createManifold from 'manifold-3d'
import { enclosureLayout, lidRimWidth } from './definitions.js'

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

export function buildEnclosure({ Manifold }, root) {
  const p = root.parameters
  const layout = enclosureLayout(root)
  const owned = []
  const own = (solid) => {
    owned.push(solid)
    return solid
  }
  const move = (solid, position) => own(solid.translate(position))
  const rotate = (solid, angles) => own(solid.rotate(angles))
  const box = (size, position) => move(own(Manifold.cube(size, true)), position)
  const cylinder = (length, radius, segments = 48) => own(Manifold.cylinder(length, radius, radius, segments, true))
  const union = (solid, shapes) => shapes.length ? own(Manifold.union([solid, ...shapes])) : solid
  const subtract = (solid, shapes) => shapes.length ? own(Manifold.difference([solid, ...shapes])) : solid

  function prism(inset, height, z = 0) {
    const contour = roundedRectangle(p.width - 2 * inset, p.depth - 2 * inset, Math.max(0, p.radius - inset))
    const solid = own(Manifold.extrude([contour], height))
    return z === 0 ? solid : move(solid, [0, 0, z])
  }

  function tray(height, floor) {
    return subtract(prism(0, height), [prism(p.wall, height - floor + BOOLEAN_OVERLAP, floor)])
  }

  function opening(feature) {
    const { side, shape } = feature.properties
    const { width, height, offset, z } = feature.parameters
    const horizontal = side === 'Front' || side === 'Back'
    const sign = side === 'Left' || side === 'Front' ? -1 : 1
    const reach = root.type === 'split' && p.lip > 0 ? p.wall + p.clearance + lidRimWidth(p) : p.wall
    const length = reach + 2 * BOOLEAN_OVERLAP
    const center = sign * ((horizontal ? p.depth : p.width) / 2 - reach / 2)
    const position = horizontal ? [offset, center, z] : [center, offset, z]
    if (shape === 'Rectangle') return box(horizontal ? [width, length, height] : [length, width, height], position)
    return move(rotate(cylinder(length, width / 2, 64), horizontal ? [90, 0, 0] : [0, 90, 0]), position)
  }

  function screwPosts({ height, diameter, hole, inset }, adds, cuts) {
    const x = p.width / 2 - inset
    const y = p.depth / 2 - inset
    for (const [px, py] of [[x, y], [-x, y], [-x, -y], [x, -y]]) {
      adds.push(move(cylinder(height + BOOLEAN_OVERLAP, diameter / 2, 64),
        [px, py, p.floor + (height - BOOLEAN_OVERLAP) / 2]))
      cuts.push(move(cylinder(height + BOOLEAN_OVERLAP, hole / 2, 64),
        [px, py, p.floor + (height + BOOLEAN_OVERLAP) / 2]))
    }
  }

  function pressFit({ boardWidth, boardDepth, boardThickness, support, clearance, grip, wall, length }) {
    const catchZ = support + boardThickness + 0.15
    const outer = clearance + wall
    const outline = [
      [-2.4, 0], [outer, 0], [outer, catchZ + 1.5], [clearance + wall * 0.25, catchZ + 1.5],
      [-grip, catchZ + 0.3], [-grip, catchZ], [clearance, catchZ],
      [clearance, support], [-2.4, support],
    ]
    // Rotate the X/Z clip profile onto the board edge and center it along Y.
    const clip = move(rotate(own(Manifold.extrude([outline], length)), [90, 0, 0]), [boardWidth / 2, length / 2, 0])
    const y = boardDepth / 4
    const mirror = rotate(clip, [0, 0, 180])
    return own(Manifold.union([
      move(clip, [0, y, 0]), move(clip, [0, -y, 0]),
      move(mirror, [0, y, 0]), move(mirror, [0, -y, 0]),
    ]))
  }

  function repeat({ primitive, count, stepX, stepY, stepZ, turnX, turnY, turnZ }) {
    const { width, depth, height, diameter } = primitive.parameters
    let shape
    if (primitive.type === 'box') shape = box([width, depth, height], [0, 0, height / 2])
    else if (primitive.type === 'cylinder') shape = move(cylinder(height, diameter / 2, 32), [0, 0, height / 2])
    else shape = move(own(Manifold.sphere(diameter / 2, 24)), [0, 0, diameter / 2])

    if (count === 1) return shape
    const copies = [shape]
    for (let i = 1; i < count; i++) {
      const angles = [turnX * i % 360, turnY * i % 360, turnZ * i % 360]
      copies.push(move(rotate(shape, angles), [stepX * i, stepY * i, stepZ * i]))
    }
    return own(Manifold.union(copies))
  }

  function childGeometry(object, surface) {
    const solid = object.type === 'repeater' ? repeat(object.parameters) : pressFit(object.parameters)
    const groups = childGroups(object.children)
    const result = subtract(union(solid, groups.adds), groups.cuts)
    const { x, y, z, angle } = object.placement
    return move(rotate(result, [0, 0, angle]), [x, y, z + surface])
  }

  function childGroups(children, surface = 0) {
    const adds = []
    const cuts = []
    for (const object of children) {
      const result = childGeometry(object, surface)
      const cutting = object.properties.operation === 'cut'
      if (result.status() !== 'NoError' || (!cutting && result.isEmpty())) {
        throw new Error(object.name + ' could not be made into usable geometry.')
      }
      const collection = cutting ? cuts : adds
      collection.push(result)
    }
    return { adds, cuts }
  }

  function ensureInside(adds, availableHeight, name) {
    if (!adds.length) return
    const envelope = prism(0, availableHeight)
    for (const shape of adds) {
      if (subtract(shape, [envelope]).volume() > 0.005) {
        throw new Error('An object attached to the ' + name.toLowerCase() + ' extends outside the assembled case. Adjust its dimensions or placement.')
      }
    }
  }

  function mesh(solid, label) {
    if (solid.status() !== 'NoError' || solid.isEmpty()) {
      throw new Error('The ' + label.toLowerCase() + ' could not be made into a solid.')
    }
    const pieces = solid.decompose().map(own)
    if (pieces.length !== 1) {
      throw new Error('The ' + label.toLowerCase() + ' has disconnected pieces. Check that added objects touch their mounting surface and cutouts leave the walls joined.')
    }
    const shaded = own(solid.calculateNormals(0, 45)).getMesh()
    const model = {
      vertices: new Float32Array(shaded.vertProperties),
      triangles: new Uint32Array(shaded.triVerts),
      stride: shaded.numProp,
      height: solid.boundingBox().max[2],
    }
    if (!hasClosedEdges(model.vertices, model.triangles, model.stride)) {
      throw new Error('The ' + label.toLowerCase() + ' has a collapsed or shared edge. Move any cutouts or objects that just touch.')
    }
    return model
  }

  // The upper part is built on its outside face for printing. This transform
  // converts between its print frame and the assembled enclosure frame.
  const flipUpper = (solid) => move(rotate(solid, [180, 0, 0]), [0, 0, layout.height])

  try {
    const openings = root.features.filter(({ type }) => type === 'cutout').map(opening)
    const baseChildren = childGroups(root.children.filter(({ placement }) => placement.part === 'base'), p.floor - BOOLEAN_OVERLAP)
    ensureInside(baseChildren.adds, layout.height - (layout.hasUpper ? p.thickness : 0), layout.baseLabel)
    for (const feature of root.features) {
      if (feature.type === 'screw-posts') screwPosts(feature.parameters, baseChildren.adds, baseChildren.cuts)
    }
    const base = subtract(union(tray(layout.baseHeight, p.floor), baseChildren.adds), [...openings, ...baseChildren.cuts])
    const baseMesh = mesh(base, layout.baseLabel)
    if (!layout.hasUpper) return { base: baseMesh, upper: null, layout }

    let upper = root.type === 'split' ? tray(layout.upperHeight, p.thickness) : prism(0, p.thickness)
    if (p.lip > 0) {
      const fit = p.wall + p.clearance
      const start = layout.upperHeight - BOOLEAN_OVERLAP
      const outer = prism(fit, p.lip + BOOLEAN_OVERLAP, start)
      const inner = prism(fit + lidRimWidth(p), p.lip + 3 * BOOLEAN_OVERLAP, start - BOOLEAN_OVERLAP)
      upper = union(upper, [subtract(outer, [inner])])
      if (root.type === 'split') {
        // A shoulder joins the inset lip to the upper half's outer walls.
        const depth = Math.min(p.wall, 1.2)
        const shoulderZ = layout.upperHeight - depth
        const shoulder = subtract(prism(0, depth, shoulderZ), [
          prism(fit + lidRimWidth(p), depth + 2 * BOOLEAN_OVERLAP, shoulderZ - BOOLEAN_OVERLAP),
        ])
        upper = union(upper, [shoulder])
      }
    }
    const upperChildren = childGroups(root.children.filter(({ placement }) => placement.part === 'upper'), p.thickness - BOOLEAN_OVERLAP)
    ensureInside(upperChildren.adds, layout.height - p.floor, layout.upperLabel)
    if (root.type === 'split') upperChildren.cuts.push(...openings.map(flipUpper))
    upper = subtract(union(upper, upperChildren.adds), upperChildren.cuts)
    const upperMesh = mesh(upper, layout.upperLabel)
    if (own(base.intersect(flipUpper(upper))).volume() > 0.005) {
      throw new Error('The parts intersect when assembled. Check the lip dimensions and any objects near the mating edge.')
    }
    return { base: baseMesh, upper: upperMesh, layout }
  } finally {
    for (const solid of owned.reverse()) solid.delete()
  }
}

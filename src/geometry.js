import createManifold from 'manifold-3d'
import { enclosureLayout, lidRimWidth, rectangleCorners, screwPositions } from './definitions.js'

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
  const objectSources = new Map()
  const cutters = new Map()
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

  function trackSource(primitive, path) {
    objectSources.set(primitive.originalID(), path)
    return primitive
  }

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

  function verticalCylinder({ x, y }, bottom, top, radius, path) {
    const solid = cylinder(top - bottom, radius, 64)
    if (path) trackSource(solid, path)
    return move(solid, [x, y, (bottom + top) / 2])
  }

  function screwPosts(positions, { diameter, pilotDiameter, pilotDepth }, bottom, top, path) {
    const posts = positions.map((position) => verticalCylinder(position, bottom, top, diameter / 2, path))
    const pilots = positions.map((position) => verticalCylinder(position, top - pilotDepth, top + BOOLEAN_OVERLAP, pilotDiameter / 2, path))
    return { posts, pilots }
  }

  function pcbScrewMount(parameters, path) {
    const { pitchX, pitchY, height } = parameters
    const { posts, pilots } = screwPosts(rectangleCorners(pitchX / 2, pitchY / 2), parameters, -BOOLEAN_OVERLAP, height, path)
    return subtract(own(Manifold.union(posts)), pilots)
  }

  function screwClosure(feature) {
    const f = feature.parameters
    const positions = screwPositions(p, feature)
    // Lid print coordinates are reflected in Y when the lid is flipped onto the base.
    const lidPositions = positions.map(({ x, y }) => ({ x, y: -y }))
    const { posts, pilots } = screwPosts(positions, f, p.floor - BOOLEAN_OVERLAP, p.height)
    const lidHoles = lidPositions.map((position) =>
      verticalCylinder(position, -BOOLEAN_OVERLAP, p.thickness + BOOLEAN_OVERLAP, f.clearanceDiameter / 2))
    if (f.counterboreDepth > 0) {
      lidHoles.push(...lidPositions.map((position) =>
        verticalCylinder(position, -BOOLEAN_OVERLAP, f.counterboreDepth, f.counterboreDiameter / 2)))
    }
    const headDiameter = f.counterboreDepth > 0 ? f.counterboreDiameter : f.clearanceDiameter
    const baseFootprint = own(Manifold.union(positions.map((position) => verticalCylinder(position, 0, p.height, f.diameter / 2))))
    const lidFootprint = own(Manifold.union(lidPositions.map((position) =>
      verticalCylinder(position, 0, p.thickness, Math.max(headDiameter, f.diameter) / 2))))
    return { posts, pilots, lidHoles, baseFootprint, lidFootprint }
  }

  function checkScrewClearance(footprint, shapes, part) {
    if (shapes.some((shape) => own(footprint.intersect(shape)).volume() > 0.005)) {
      throw new Error('Screw closure overlaps another object or cut on the ' + part + '. Move the screw positions or the other geometry.')
    }
  }

  function pressFit({ boardWidth, boardDepth, boardThickness, support, clearance, grip, wall, length }, path) {
    const catchZ = support + boardThickness + 0.15
    const outer = clearance + wall
    const outline = [
      [-2.4, 0], [outer, 0], [outer, catchZ + 1.5], [clearance + wall * 0.25, catchZ + 1.5],
      [-grip, catchZ + 0.3], [-grip, catchZ], [clearance, catchZ],
      [clearance, support], [-2.4, support],
    ]
    // Rotate the X/Z clip profile onto the board edge and center it along Y.
    const profile = trackSource(own(Manifold.extrude([outline], length)), path)
    const clip = move(rotate(profile, [90, 0, 0]), [boardWidth / 2, length / 2, 0])
    const y = boardDepth / 4
    const mirror = rotate(clip, [0, 0, 180])
    return own(Manifold.union([
      move(clip, [0, y, 0]), move(clip, [0, -y, 0]),
      move(mirror, [0, y, 0]), move(mirror, [0, -y, 0]),
    ]))
  }

  function repeat({ primitive, count, stepX, stepY, stepZ, turnX, turnY, turnZ }, path) {
    const { width, depth, height, diameter } = primitive.parameters
    let seed
    if (primitive.type === 'box') seed = own(Manifold.cube([width, depth, height], true))
    else if (primitive.type === 'cylinder') seed = cylinder(height, diameter / 2, 32)
    else seed = own(Manifold.sphere(diameter / 2, 24))
    const shape = move(trackSource(seed, path), [0, 0, (primitive.type === 'sphere' ? diameter : height) / 2])

    if (count === 1) return shape
    const copies = [shape]
    for (let i = 1; i < count; i++) {
      const angles = [turnX * i % 360, turnY * i % 360, turnZ * i % 360]
      copies.push(move(rotate(shape, angles), [stepX * i, stepY * i, stepZ * i]))
    }
    return own(Manifold.union(copies))
  }

  function childGeometry(object, path, { part, surface, toPart }) {
    const { x, y, z, angle } = object.placement
    const place = (solid) => move(rotate(solid, [0, 0, angle]), [x, y, z + surface])
    let solid
    if (object.type === 'repeater') solid = repeat(object.parameters, path)
    else if (object.type === 'pcb-screw-mount') solid = pcbScrewMount(object.parameters, path)
    else solid = pressFit(object.parameters, path)
    const groups = childGroups(object.children, path, { part, toPart: (child) => toPart(place(child)) })
    return place(subtract(union(solid, groups.adds), groups.cuts))
  }

  function childGroups(children, path, { part, surface = 0, toPart = (solid) => solid }) {
    const adds = []
    const cuts = []
    children.forEach((object, index) => {
      if (path === 'root' && object.placement.part !== part) return
      const key = path + '.children.' + index
      const overlap = path === 'root' && object.type !== 'pcb-screw-mount' ? BOOLEAN_OVERLAP : 0
      const result = childGeometry(object, key, { part, surface: surface - overlap, toPart })
      const cutting = object.properties.operation === 'cut'
      if (result.status() !== 'NoError' || (!cutting && result.isEmpty())) {
        throw new Error(object.name + ' could not be made into usable geometry.')
      }
      if (cutting && !result.isEmpty()) {
        // Capture the full cutter in its part's coordinates before the parent subtracts it.
        const { vertProperties, triVerts, numProp, mergeFromVert, mergeToVert } = toPart(result).getMesh()
        const triangles = new Uint32Array(triVerts)
        if (mergeFromVert.length) {
          const merged = new Map(Array.from(mergeFromVert, (from, index) => [from, mergeToVert[index]]))
          for (let i = 0; i < triangles.length; i++) {
            triangles[i] = merged.get(triangles[i]) ?? triangles[i]
          }
        }
        cutters.set(key, { part, vertices: new Float32Array(vertProperties), triangles, stride: numProp })
      }
      const collection = cutting ? cuts : adds
      collection.push(result)
    })
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
    // Runs retain their source primitive across copies, transforms, and Boolean operations.
    const { runIndex, runOriginalID } = shaded
    const runs = []
    for (const [i, original] of runOriginalID.entries()) {
      const start = runIndex[i]
      const count = runIndex[i + 1] - start
      if (count) runs.push({ path: objectSources.get(original) ?? 'root', start, count })
    }
    const model = {
      vertices: new Float32Array(shaded.vertProperties),
      triangles: new Uint32Array(shaded.triVerts),
      stride: shaded.numProp,
      height: solid.boundingBox().max[2],
      runs,
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
    const baseChildren = childGroups(root.children, 'root', { part: 'base', surface: p.floor })
    ensureInside(baseChildren.adds, layout.height - (layout.hasUpper ? p.thickness : 0), layout.baseLabel)
    const closureFeature = root.features.find(({ type }) => type === 'screw-closure')
    const closure = closureFeature ? screwClosure(closureFeature) : null
    if (closure) {
      checkScrewClearance(closure.baseFootprint, [...baseChildren.adds, ...baseChildren.cuts], 'base')
      baseChildren.adds.push(...closure.posts)
      baseChildren.cuts.push(...closure.pilots)
    }
    const base = subtract(union(tray(layout.baseHeight, p.floor), baseChildren.adds), [...openings, ...baseChildren.cuts])
    const baseMesh = mesh(base, layout.baseLabel)
    if (!layout.hasUpper) return { base: baseMesh, upper: null, layout, cutters }

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
    const upperChildren = childGroups(root.children, 'root', { part: 'upper', surface: p.thickness })
    ensureInside(upperChildren.adds, layout.height - p.floor, layout.upperLabel)
    if (closure) {
      checkScrewClearance(closure.lidFootprint, [...upperChildren.adds, ...upperChildren.cuts], 'lid')
      // A lid-side object can reach into the space filled by a base boss.
      checkScrewClearance(flipUpper(closure.baseFootprint), upperChildren.adds, 'lid')
      upperChildren.cuts.push(...closure.lidHoles)
    }
    if (root.type === 'split') upperChildren.cuts.push(...openings.map(flipUpper))
    upper = subtract(union(upper, upperChildren.adds), upperChildren.cuts)
    const upperMesh = mesh(upper, layout.upperLabel)
    if (own(base.intersect(flipUpper(upper))).volume() > 0.005) {
      throw new Error('The parts intersect when assembled. Check the lip dimensions and any objects near the mating edge.')
    }
    return { base: baseMesh, upper: upperMesh, layout, cutters }
  } finally {
    for (const solid of owned.reverse()) solid.delete()
  }
}

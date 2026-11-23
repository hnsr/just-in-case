import createManifold from 'manifold-3d'
import {
  LOCATOR_HEIGHT, LOCATOR_RECESS_DEPTH, LOCATOR_SLOT_TRAVEL, cornerFasteners, enclosureLayout, lidRimWidth, rectangleCorners,
} from './definitions.js'

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

export function buildEnclosure({ CrossSection, Manifold, Mesh }, root, { preview = false, screwIssues = [] } = {}) {
  if (!preview && screwIssues.length) throw new Error(screwIssues[0].message)
  const p = root.parameters
  const layout = enclosureLayout(root)
  const owned = []
  const objectSources = new Map()
  const objectsByPath = new Map()
  const cutters = new Map()
  const references = []
  const previewIssues = [...screwIssues]
  const previewGuides = []
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

  function wallContour(inset) {
    return roundedRectangle(p.width - 2 * inset, p.depth - 2 * inset, Math.max(0, p.radius - inset))
  }

  function prism(inset, height, z = 0) {
    const solid = own(Manifold.extrude([wallContour(inset)], height))
    return z === 0 ? solid : move(solid, [0, 0, z])
  }

  function tray(height, floor, cornerPads = []) {
    const cavityHeight = height - floor + BOOLEAN_OVERLAP
    const outer = prism(0, height)
    if (!cornerPads.length) return subtract(outer, [prism(p.wall, cavityHeight, floor)])
    const cavity = own(CrossSection.difference([[wallContour(p.wall)], ...cornerPads]))
    return subtract(outer, [move(own(cavity.extrude(cavityHeight)), [0, 0, floor])])
  }

  function slopedLipCavity(innerInset) {
    const top = layout.upperHeight
    // Advance inward 1 mm for each mm of print height near the seam.
    const rampTop = top - BOOLEAN_OVERLAP
    const rampStart = rampTop - (innerInset - p.wall)
    const profiles = [[p.thickness, p.wall + Math.max(0, p.thickness - rampStart)]]
    if (rampStart > p.thickness + BOOLEAN_OVERLAP) profiles.push([rampStart, p.wall])
    const [rampZ, rampInset] = profiles.at(-1)
    // End the rounded arcs at the height where they reach zero radius.
    if (p.radius > rampInset && p.radius < innerInset) {
      const fraction = (p.radius - rampInset) / (innerInset - rampInset)
      profiles.push([rampZ + (rampTop - rampZ) * fraction, p.radius])
    }
    profiles.push([rampTop, innerInset], [top + p.lip + BOOLEAN_OVERLAP, innerInset])

    const vertices = []
    const triangles = []
    const rings = profiles.map(([z, inset]) => {
      const contour = wallContour(inset)
      return contour.flatMap(([x, y]) => {
        const index = vertices.length / 3
        vertices.push(x, y, z)
        // Match each rounded arc to a single vertex when the inset makes a corner square.
        return contour.length === 4 ? Array(ARC_STEPS + 1).fill(index) : [index]
      })
    })
    const segmentCount = rings[0].length
    for (let level = 1; level < rings.length; level++) {
      const lower = rings[level - 1]
      const upper = rings[level]
      for (let i = 0; i < segmentCount; i++) {
        const next = (i + 1) % segmentCount
        if (lower[i] !== lower[next]) triangles.push(lower[i], lower[next], upper[next])
        if (upper[i] !== upper[next]) triangles.push(lower[i], upper[next], upper[i])
      }
    }
    const bottomCenter = vertices.length / 3
    const topCenter = bottomCenter + 1
    vertices.push(0, 0, profiles[0][0], 0, 0, profiles.at(-1)[0])
    const first = rings[0]
    const last = rings.at(-1)
    for (let i = 0; i < segmentCount; i++) {
      const next = (i + 1) % segmentCount
      if (first[i] !== first[next]) triangles.push(bottomCenter, first[next], first[i])
      if (last[i] !== last[next]) triangles.push(topCenter, last[i], last[next])
    }
    return own(Manifold.ofMesh(new Mesh({
      numProp: 3, vertProperties: new Float32Array(vertices), triVerts: new Uint32Array(triangles),
    })))
  }

  function opening(feature, { lipRelief = false } = {}) {
    const { side, shape } = feature.properties
    const { width, height, offset, z } = feature.parameters
    const horizontal = side === 'Front' || side === 'Back'
    const sign = side === 'Left' || side === 'Front' ? -1 : 1
    const reach = root.type === 'split' && p.lip > 0 ? p.wall + p.clearance + lidRimWidth(p) : p.wall
    const length = reach + 2 * BOOLEAN_OVERLAP
    const center = sign * ((horizontal ? p.depth : p.width) / 2 - reach / 2)
    const centerZ = lipRelief ? z - p.lip / 2 : z
    const position = horizontal ? [offset, center, centerZ] : [center, offset, centerZ]
    if (lipRelief || shape === 'Rectangle') {
      const cutWidth = lipRelief ? width + 2 * BOOLEAN_OVERLAP : width
      const cutHeight = lipRelief ? p.lip + 2 * BOOLEAN_OVERLAP : height
      return box(horizontal ? [cutWidth, length, cutHeight] : [length, cutWidth, cutHeight], position)
    }
    return move(rotate(cylinder(length, width / 2, 64), horizontal ? [90, 0, 0] : [0, 90, 0]), position)
  }

  function verticalCylinder({ x, y }, bottom, top, radius, path) {
    const solid = cylinder(top - bottom, radius, 64)
    if (path) trackSource(solid, path)
    return move(solid, [x, y, (bottom + top) / 2])
  }

  function screwPosts(positions, { diameter, pilotDiameter, pilotDepth }, bottom, top, path) {
    const posts = Number.isFinite(diameter)
      ? positions.map((position) => verticalCylinder(position, bottom, top, diameter / 2, path)) : []
    const pilots = Number.isFinite(pilotDiameter) && Number.isFinite(pilotDepth)
      ? positions.map((position) => verticalCylinder(position, top - pilotDepth, top + BOOLEAN_OVERLAP, pilotDiameter / 2, path)) : []
    return { posts, pilots }
  }

  function pcbScrewMount(parameters, path) {
    const { pitchX, pitchY, height } = parameters
    const { posts, pilots } = screwPosts(rectangleCorners(pitchX / 2, pitchY / 2), parameters, -BOOLEAN_OVERLAP, height, path)
    return subtract(own(Manifold.union(posts)), pilots)
  }

  function screwClosure() {
    const { positions, x, y, bossRadius, collarRadius, recessRadius } = cornerFasteners(p)
    const pads = []
    const collars = []
    const pilots = []
    const lidHoles = []
    if (x <= 0 || y <= 0) return { pads, collars, pilots, lidHoles }

    const cornerX = p.width / 2 - p.wall / 2
    const cornerY = p.depth / 2 - p.wall / 2
    const envelope = [wallContour(p.wall / 2)]
    const diagonal = Math.hypot(x, y)
    const slotX = LOCATOR_SLOT_TRAVEL * x / diagonal
    // Lid print coordinates reverse Y when the lid is assembled.
    const slotY = -LOCATOR_SLOT_TRAVEL * y / diagonal

    positions.forEach((position, index) => {
      const lid = { x: position.x, y: -position.y }
      if (Number.isFinite(bossRadius)) {
        const circle = own(CrossSection.circle(bossRadius, 64))
        const round = own(circle.translate([position.x, position.y]))
        const cx = Math.sign(position.x) * cornerX
        const cy = Math.sign(position.y) * cornerY
        const corner = [[position.x, position.y], [cx, position.y], [cx, cy], [position.x, cy]]
        // Extend the round boss past both inner walls so it is part of the tray cross-section.
        const pad = own(CrossSection.hull([round, [corner]]))
        pads.push(own(pad.intersect(envelope)))
      }
      if (Number.isFinite(p.pilotDiameter) && Number.isFinite(p.pilotDepth)) {
        pilots.push(verticalCylinder(position, p.height - p.pilotDepth, p.height + LOCATOR_HEIGHT + BOOLEAN_OVERLAP, p.pilotDiameter / 2))
      }
      if (Number.isFinite(p.clearanceDiameter)) {
        lidHoles.push(verticalCylinder(lid, -BOOLEAN_OVERLAP, p.thickness + BOOLEAN_OVERLAP, p.clearanceDiameter / 2))
      }
      if (p.counterboreDepth > 0 && Number.isFinite(p.counterboreDiameter)) {
        lidHoles.push(verticalCylinder(lid, -BOOLEAN_OVERLAP, p.counterboreDepth, p.counterboreDiameter / 2))
      }

      if (index % 2 !== 0 || !Number.isFinite(collarRadius)) return
      const collar = own(Manifold.cylinder(LOCATOR_HEIGHT + BOOLEAN_OVERLAP, collarRadius, collarRadius - 0.25, 64, true))
      collars.push(move(collar, [position.x, position.y, p.height + (LOCATOR_HEIGHT - BOOLEAN_OVERLAP) / 2]))
      if (!Number.isFinite(recessRadius)) return
      const recess = (center) => verticalCylinder(center, p.thickness - LOCATOR_RECESS_DEPTH, p.thickness + BOOLEAN_OVERLAP, recessRadius)
      if (index === 0) {
        lidHoles.push(recess(lid))
      } else {
        lidHoles.push(own(Manifold.hull([
          recess({ x: lid.x - slotX, y: lid.y - slotY }),
          recess({ x: lid.x + slotX, y: lid.y + slotY }),
        ])))
      }
    })
    return { pads, collars, pilots, lidHoles }
  }

  function overlaps(footprint, shapes) {
    return shapes.some((shape) => own(footprint.intersect(shape)).volume() > 0.005)
  }

  function meshBuffers({ vertProperties, triVerts, numProp }) {
    return { vertices: new Float32Array(vertProperties), triangles: new Uint32Array(triVerts), stride: numProp }
  }

  function addGuide(solid, part, outline = false, paths = []) {
    const data = (outline ? solid : own(solid.calculateNormals(0, 45))).getMesh()
    previewGuides.push({ part, outline, paths, mesh: meshBuffers(data) })
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

  function childGeometry(object, path, { part, surface, toPart, reference, cutOwner }) {
    const { x, y, z, angle } = object.placement
    const place = (solid) => move(rotate(solid, [0, 0, angle]), [x, y, z + surface])
    let solid
    if (object.type === 'repeater') solid = repeat(object.parameters, path)
    else if (object.type === 'pcb-screw-mount') solid = pcbScrewMount(object.parameters, path)
    else solid = pressFit(object.parameters, path)
    const groups = childGroups(object.children, path, { part, toPart: (child) => toPart(place(child)), reference, cutOwner })
    return place(subtract(union(solid, groups.adds), groups.cuts))
  }

  function childGroups(children, path, { part, surface = 0, toPart = (solid) => solid, availableHeight, reference = false, cutOwner }) {
    const adds = []
    const cuts = []
    const envelope = availableHeight === undefined ? null : prism(0, availableHeight)
    children.forEach((object, index) => {
      if (path === 'root' && object.placement.part !== part) return
      const key = path + '.children.' + index
      const isReference = reference || object.properties.reference === true
      const cutting = object.properties.operation === 'cut'
      // Faces contributed by a cutter belong to the object whose material it removes.
      const owner = cutOwner ?? (cutting ? path : undefined)
      objectsByPath.set(key, { object, visiblePath: owner ?? key })
      const overlap = path === 'root' && object.type !== 'pcb-screw-mount' ? BOOLEAN_OVERLAP : 0
      const result = childGeometry(object, key, { part, surface: surface - overlap, toPart, reference: isReference, cutOwner: owner })
      if (isReference) {
        const placed = toPart(result)
        const data = own(placed.calculateNormals(0, 45)).getMesh()
        if (data.triVerts.length) references.push({ path: key, part, mesh: meshBuffers(data) })
        return
      }
      if (result.status() !== 'NoError' || (!cutting && result.isEmpty())) {
        throw new Error(object.name + ' could not be made into usable geometry.')
      }
      if (!cutting && envelope && subtract(result, [envelope]).volume() > 0.005) {
        const label = part === 'base' ? layout.baseLabel : layout.upperLabel
        const message = '“' + object.name + '” on the ' + label.toLowerCase() + ' extends outside the assembled case.'
        if (!preview) throw new Error(message)
        const { min, max } = result.boundingBox()
        const field = key + '.placement'
        const hint = placementHint(min, max, availableHeight)
        previewIssues.push({ field, message, hint })
        addGuide(result, part, false, [key])
        // Cutters nested under this object only affect the omitted solid.
        for (const path of cutters.keys()) {
          if (path.startsWith(key + '.')) cutters.delete(path)
        }
        return
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

  function placementHint(min, max, height) {
    const tolerance = 0.001
    const hints = []
    for (const [axis, limit] of [[0, p.width / 2], [1, p.depth / 2]]) {
      const lower = min[axis] < -limit - tolerance
      const upper = max[axis] > limit + tolerance
      const label = axis === 0 ? 'X' : 'Y'
      if (lower && upper) hints.push('Reduce the span along ' + label + '.')
      else if (lower || upper) {
        hints.push((lower ? 'Increase ' : 'Decrease ') + label + ' offset or reduce the span along ' + label + '.')
      }
    }
    if (min[2] < -tolerance && max[2] > height + tolerance) {
      hints.push('Reduce the height of the object or pattern.')
    } else if (min[2] < -tolerance) {
      hints.push('Increase Z offset to bring it inside the mounting face.')
    } else if (max[2] > height + tolerance) {
      hints.push('Reduce its height or decrease Z offset to clear the opposite face.')
    }
    return hints.join(' ') || 'Move it away from the rounded corner or reduce its span.'
  }

  function completePart(shell, { adds, cuts }, part, openings = []) {
    const label = part === 'base' ? layout.baseLabel : layout.upperLabel
    const solid = subtract(union(shell, adds), [...openings, ...cuts])
    if (solid.status() !== 'NoError' || solid.isEmpty()) {
      throw new Error('The ' + label.toLowerCase() + ' could not be made into a solid.')
    }
    const pieces = solid.decompose().map(own)
    if (pieces.length === 1) return solid

    const message = 'The ' + label.toLowerCase() + ' has disconnected pieces. Check that added objects touch their mounting surface and cutouts leave the walls joined.'
    if (!preview) throw new Error(message)

    let attached
    const loose = []
    const paths = new Set()
    for (const piece of pieces) {
      // Check the final Boolean result so objects can also connect via walls or one another.
      if (own(piece.intersect(shell)).volume() > 0) {
        if (attached) throw new Error(message)
        attached = piece
        continue
      }
      const faces = piece.getMesh()
      const sources = new Set()
      for (const [i, id] of faces.runOriginalID.entries()) {
        const path = objectSources.get(id)
        if (path && faces.runIndex[i + 1] > faces.runIndex[i] && !faces.backside(i)) sources.add(path)
      }
      if (!sources.size) throw new Error(message)
      for (const path of sources) paths.add(path)
      loose.push({ piece, sources })
    }
    if (!attached) throw new Error(message)
    for (const path of paths) {
      const { name, placement, parameters } = objectsByPath.get(path).object
      const hint = placement.part && placement.z > BOOLEAN_OVERLAP
        ? 'Decrease Z offset to bring the geometry back to its mounting surface.'
        : parameters.count > 1
          ? 'Adjust the placement or per-copy steps so each copy connects.'
          : 'Move the geometry until it joins its mounting surface or another attached object.'
      previewIssues.push({
        field: path + '.placement',
        message: '“' + name + '” has geometry disconnected from the ' + label.toLowerCase() + '.',
        hint,
      })
    }
    for (const { piece, sources } of loose) addGuide(piece, part, false, [...sources])
    return attached
  }

  function mesh(solid, label) {
    const shaded = own(solid.calculateNormals(0, 45)).getMesh()
    // Runs retain their source primitive across copies, transforms, and Boolean operations.
    const { runIndex, runOriginalID } = shaded
    const runs = []
    for (const [i, original] of runOriginalID.entries()) {
      const start = runIndex[i]
      const count = runIndex[i + 1] - start
      const path = objectSources.get(original) ?? 'root'
      if (count) runs.push({ path, start, count, visiblePath: objectsByPath.get(path)?.visiblePath ?? 'root' })
    }
    const model = {
      ...meshBuffers(shaded),
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
    const cutoutFeatures = root.features.filter(({ type }) => type === 'cutout')
    const openings = cutoutFeatures.map((feature) => opening(feature))
    let cornerPads = []
    const baseChildren = childGroups(root.children, 'root', {
      part: 'base', surface: p.floor, availableHeight: layout.height - (layout.hasUpper ? p.thickness : 0),
    })
    if (!layout.hasUpper) {
      const base = completePart(tray(layout.baseHeight, p.floor), baseChildren, 'base', openings)
      return { base: mesh(base, layout.baseLabel), upper: null, layout, cutters, references, previewIssues, previewGuides }
    }

    let upper
    if (!p.lip) {
      upper = root.type === 'split' ? tray(layout.upperHeight, p.thickness) : prism(0, p.thickness)
    } else {
      const fit = p.wall + p.clearance
      const innerInset = fit + lidRimWidth(p)
      const start = layout.upperHeight - BOOLEAN_OVERLAP
      const outer = prism(fit, p.lip + BOOLEAN_OVERLAP, start)
      // Open the lip to its free edge while the bore still defines the outer wall profile.
      const reliefs = cutoutFeatures.filter(({ properties }) => properties.placement === 'seam')
        .map((feature) => flipUpper(opening(feature, { lipRelief: true })))
      if (root.type === 'split') {
        upper = subtract(union(prism(0, layout.upperHeight), [subtract(outer, reliefs)]), [slopedLipCavity(innerInset)])
      } else {
        const inner = prism(innerInset, p.lip + 3 * BOOLEAN_OVERLAP, start - BOOLEAN_OVERLAP)
        upper = union(prism(0, p.thickness), [subtract(outer, [inner])])
      }
    }
    const upperChildren = childGroups(root.children, 'root', {
      part: 'upper', surface: p.thickness, availableHeight: layout.height - p.floor,
    })
    if (root.type === 'screw-fastened') {
      const { pads, collars, pilots, lidHoles } = screwClosure()
      const bosses = pads.map((pad) => move(own(pad.extrude(p.height - p.floor)), [0, 0, p.floor]))
      const screwSolids = [...bosses, ...collars]
      let invalid = Boolean(screwIssues.length)
      if (!invalid) {
        const baseFootprint = own(Manifold.union(screwSolids))
        const lidFootprint = own(Manifold.union(lidHoles))
        const baseOverlap = overlaps(baseFootprint, [...baseChildren.adds, ...baseChildren.cuts, ...openings])
        const lidOverlap = overlaps(lidFootprint, [...upperChildren.adds, ...upperChildren.cuts])
          || overlaps(flipUpper(baseFootprint), upperChildren.adds)
        for (const [part, blocked] of [['base', baseOverlap], ['lid', lidOverlap]]) {
          if (!blocked) continue
          const message = 'Screw closure overlaps another object or cut on the ' + part + '. Move the object or cutout away from the corner.'
          if (!preview) throw new Error(message)
          previewIssues.push({ field: 'root.parameters.bossDiameter', message })
          invalid = true
        }
      }
      if (invalid) {
        for (const solid of screwSolids) addGuide(solid, 'base')
        for (const pilot of pilots) addGuide(pilot, 'base', true)
        for (const hole of lidHoles) addGuide(hole, 'upper', true)
      } else {
        cornerPads = pads
        baseChildren.adds.push(...collars)
        baseChildren.cuts.push(...pilots)
        upperChildren.cuts.push(...lidHoles)
      }
    }
    if (root.type === 'split') upperChildren.cuts.push(...openings.map(flipUpper))
    const base = completePart(tray(layout.baseHeight, p.floor, cornerPads), baseChildren, 'base', openings)
    const baseMesh = mesh(base, layout.baseLabel)
    upper = completePart(upper, upperChildren, 'upper')
    const upperMesh = mesh(upper, layout.upperLabel)
    if (own(base.intersect(flipUpper(upper))).volume() > 0.005) {
      const hint = p.lip ? 'Check the lip dimensions and any objects near the mating edge.' : 'Check any objects near the mating edge.'
      throw new Error('The parts intersect when assembled. ' + hint)
    }
    return { base: baseMesh, upper: upperMesh, layout, cutters, references, previewIssues, previewGuides }
  } finally {
    for (const solid of owned.reverse()) solid.delete()
  }
}

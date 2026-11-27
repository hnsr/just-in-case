import { evaluateFormula, VARIABLE_NAME } from './formula.js'
import {
  ROOT_TYPES, CHILD_TYPES, FEATURES, PRIMITIVES, REPEATER_OPERATIONS, PLACEMENT_FIELDS, SIDES, SHAPES,
  CABLE_DUCT_FITS, cableDuctMinimumWidth,
  PCB_MOUNT_FASTENINGS, PCB_PILOT_MARGIN, SCREW_FIELDS, pcbSeatSize,
  LOCATOR_RECESS_DEPTH, cornerFasteners, isScrewParameter, enclosureLayout, featureFields, fieldDefaults, lidRimWidth,
  makePrimitive, parameterFields,
} from './definitions.js'

const PROJECT_VERSION = 3
export const STORAGE_KEY = 'just-in-case.project.v' + PROJECT_VERSION
export const MAX_VARIABLES = 32
export const MAX_FEATURES = 24
export const MAX_OBJECTS = 40
export const MAX_DEPTH = 6

export function addsGeometry(object) {
  return object.properties.reference !== true && object.properties.operation !== 'cut'
}

export function newProject(type = 'lidded', includeLid = true) {
  const root = { type, properties: type === 'lidded' ? { includeLid } : {}, parameters: {}, features: [], children: [] }
  root.parameters = fieldDefaults(parameterFields(root))
  return { version: PROJECT_VERSION, name: 'Electronics enclosure', variables: [], root }
}

export function makeChild(type, direct = true, root) {
  const object = {
    type,
    name: CHILD_TYPES[type].label,
    properties: {},
    parameters: {},
    placement: { ...fieldDefaults(PLACEMENT_FIELDS), ...(direct ? { part: 'base' } : {}) },
    features: [],
    children: [],
  }
  if (type === 'pcb-corner-mount') object.properties.fastening = 'screw'
  if (type === 'cable-duct') object.properties.fit = 'standard'
  object.parameters = fieldDefaults(parameterFields(object))
  if (type === 'repeater') {
    object.properties.operation = 'add'
    object.parameters.primitive = makePrimitive('box')
    if (direct) object.placement.x = -15
  }
  if (type === 'cable-duct' && direct && root) placeNewDuct(object, root)
  return object
}

function placeNewDuct({ parameters, placement }, root) {
  const p = root.parameters
  const alongY = p.depth > p.width
  const edge = Math.max(p.wall, p.radius) + 0.5
  const [span, across, offset] = alongY ? [p.depth, p.width, 'x'] : [p.width, p.depth, 'y']
  placement.angle = alongY ? 90 : 0
  parameters.baseLength = Math.max(CHILD_TYPES['cable-duct'].fields.baseLength.min,
    Math.min(parameters.baseLength, span - 2 * edge))
  const ducts = root.children.filter((item) => item.type === 'cable-duct' && item.placement.part === 'base')
  const spacing = parameters.baseWidth + 1
  const lanes = Math.max(0, Math.floor((across / 2 - edge - parameters.baseWidth / 2) / spacing))
  const candidates = [0, ...Array.from({ length: lanes }, (_, i) => [spacing * (i + 1), -spacing * (i + 1)]).flat()]
  placement[offset] = candidates.find((value) => ducts.every((duct) =>
    Math.abs(value - duct.placement[offset]) >= (parameters.baseWidth + duct.parameters.baseWidth) / 2 + 0.5)) ?? 0
}

export function makeFeature(type, root) {
  const feature = { type, properties: {}, parameters: fieldDefaults(FEATURES[type].fields) }
  const p = root.parameters
  const { height, hasUpper } = enclosureLayout(root)
  const top = hasUpper ? p.thickness : 0
  const edge = Math.max(p.wall, p.radius) + 1
  const inside = height - top - p.floor
  feature.parameters.height = Math.max(1, Math.min(6, Math.floor(inside - 1.5)))
  feature.parameters.z = (height - top + p.floor - 0.5) / 2

  const used = root.features.filter((item) => item.type === 'cutout')
  const walls = [[p.width, 'Front'], [p.depth, 'Right'], [p.width, 'Back'], [p.depth, 'Left']]
  const candidates = walls.sort(([a], [b]) => b - a).flatMap(([length, side]) => {
    const width = Math.max(1, Math.min(12, Math.floor(length - 2 * edge)))
    const travel = Math.max(0, Math.floor(length / 2 - edge - width / 2))
    return [0, -travel, travel].map((offset) => ({ width, side, offset }))
  })
  const place = candidates.find(({ width, side, offset }) => used.every((item) =>
    item.properties.side !== side || Math.abs(item.parameters.offset - offset) >= (item.parameters.width + width) / 2 + 1
  )) ?? candidates[0]
  feature.properties = { side: place.side, shape: 'Rectangle' }
  feature.parameters.width = place.width
  feature.parameters.offset = place.offset
  return feature
}

export function defaultProject() {
  const project = newProject()
  project.root.features = [
    { type: 'cutout', properties: { side: 'Front', shape: 'Rectangle' }, parameters: { width: 16, height: 8, offset: -21, z: 12 } },
    { type: 'cutout', properties: { side: 'Right', shape: 'Circle' }, parameters: { width: 11, offset: 9, z: 14 } },
  ]
  project.root.children.push(makeChild('pcb-corner-mount'))
  return project
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function demand(condition, message) {
  if (!condition) throw new Error(message)
}

function validateCornerFasteners(p, field) {
  const { x, y, bossRadius, collarRadius, envelopeRadius } = cornerFasteners(p)
  if (bossRadius < collarRadius + 0.3) {
    field('bossDiameter', 'Increase the boss diameter to support the locating collar around the lid hole.')
  }
  if (p.clearanceDiameter <= p.pilotDiameter) field('clearanceDiameter', 'The lid hole must be wider than the pilot hole.')
  if (p.pilotDepth > p.height - p.floor) field('pilotDepth', 'The pilot hole must stop above the base floor.')
  if (p.counterboreDepth > p.thickness - LOCATOR_RECESS_DEPTH - 0.7) {
    field('counterboreDepth', 'Reduce the counterbore depth or thicken the lid to leave 0.7 mm between it and the locating recess.')
  }
  if (p.counterboreDepth > 0 && p.counterboreDiameter <= p.clearanceDiameter) {
    field('counterboreDiameter', 'The counterbore must be wider than the lid hole.')
  }
  if (Math.min(x, y) < envelopeRadius + 0.25) {
    field('bossDiameter', 'The corner fasteners need more room. Enlarge the enclosure or reduce the boss or screw-hole diameters.')
  }
}

export function screwClosureDraftIssues(root, issues) {
  return root?.type === 'screw-fastened' && issues.every(({ field }) => isScrewParameter(field)) ? issues : []
}

function validateCableDuct(f, issue) {
  const minimumWidth = cableDuctMinimumWidth(f.cableDiameter)
  if (f.baseWidth < minimumWidth - 1e-8) {
    const width = Math.ceil((minimumWidth - 1e-8) * 100) / 100
    issue('baseWidth', 'needs a base at least ' + width + ' mm wide for this cable and its rails.')
  }
}

function validatePCBMount(p, fastening, issue) {
  const [seatX, seatY] = pcbSeatSize(p, fastening)
  if (fastening === 'snap-fit') {
    if (2 * seatX + 0.5 > Math.min(p.boardWidth, p.boardDepth)) {
      issue('seatSize', 'Reduce the corner seat size to leave at least 0.5 mm between the seats.')
    }
    if (p.seatClearance > seatX - 1 + 1e-8) {
      issue('seatClearance', 'Keep the corner seat clearance at least 1 mm smaller than the corner seat size to support the board.')
    }
    return
  }
  const radius = p.pilotDiameter / 2
  const minimumInset = radius + Math.max(0, PCB_PILOT_MARGIN - p.clearance - p.wallThickness)
  for (const [field, inset, seat, size] of [
    ['holeInsetX', p.holeInsetX, seatX, p.boardWidth],
    ['holeInsetY', p.holeInsetY, seatY, p.boardDepth],
  ]) {
    if (inset < minimumInset - 1e-8) {
      issue(field, 'Increase the hole inset or reduce the pilot hole diameter so the hole fits inside the board corner and seat.')
    } else if (2 * seat + 0.5 > size) {
      issue(field, 'Reduce the hole inset or diameter, or increase the board size to leave 0.5 mm between the seats.')
    }
  }
  if (p.baseHeight < PCB_PILOT_MARGIN + 0.5) {
    issue('baseHeight', 'Use at least 1.5 mm of base height for a blind pilot hole.')
  }
}

function validateEnclosureShell(root, mark) {
  const p = root.parameters
  const { baseHeight, upperHeight, height, hasUpper } = enclosureLayout(root)
  const narrowest = Math.min(p.width, p.depth)
  const lip = hasUpper ? p.lip ?? 0 : 0
  const thickness = hasUpper ? p.thickness : 0
  const field = (key, message) => mark('root.parameters.' + key, message)
  if (p.radius > narrowest / 2 - 1) field('radius', 'Leave 2 mm of straight edge between the rounded corners.')
  if (narrowest - 2 * p.wall < 4) field('wall', 'Leave at least 4 mm of interior width and depth.')
  if (baseHeight - p.floor < 2) field(root.type === 'split' ? 'seam' : 'floor', 'Leave at least 2 mm inside the base above the floor.')
  if (root.type === 'split' && upperHeight - thickness < 2) field('seam', 'Leave at least 2 mm inside the upper half below its ceiling.')
  if (lip > baseHeight - p.floor - 0.5) field('lip', 'Leave at least 0.5 mm between the lip and the floor.')
  if (lip > 0 && narrowest - 2 * (p.wall + p.clearance + lidRimWidth(p)) < 2) {
    field('clearance', 'Reduce the wall thickness or clearance to leave room inside the lip.')
  }

}

function validateWallCutout(root, feature, index, mark) {
  const p = root.parameters
  const { baseHeight, height } = enclosureLayout(root)
  const f = feature.parameters
  const { side, shape, placement } = feature.properties
  const label = FEATURES[feature.type].label + ' ' + (index + 1)
  const issue = (key, message) => mark('root.features.' + index + '.parameters.' + key, label + ' ' + message)
  const wallLength = ['Front', 'Back'].includes(side) ? p.width : p.depth
  const openingHeight = shape === 'Circle' ? f.width : f.height
  const wallTop = root.type === 'split' ? height - p.thickness : baseHeight
  if (Math.abs(f.offset) + f.width / 2 > wallLength / 2 - Math.max(p.radius, p.wall) - 1) {
    issue('offset', 'must fit on the straight wall with 1 mm of room at each end.')
  }
  if (f.z - openingHeight / 2 < p.floor + 0.5 || f.z + openingHeight / 2 > wallTop - 1) {
    if (placement === 'seam') {
      const circular = shape === 'Circle'
      issue(circular ? 'width' : 'height', 'needs 0.5 mm above the floor and 1 mm below the ceiling. Reduce the ' +
        (circular ? 'diameter' : 'height') + ' or move the split seam.')
    } else {
      issue('z', 'needs 0.5 mm above the floor and 1 mm below the top of the wall.')
    }
  }
}

function validateRoot(root, mark) {
  validateEnclosureShell(root, mark)
  if (root.type === 'screw-fastened') {
    validateCornerFasteners(root.parameters, (key, message) => mark('root.parameters.' + key, message))
  }
  root.features.forEach((feature, index) => validateWallCutout(root, feature, index, mark))
}

export function evaluateProject(project) {
  return evaluate(project)
}

export function evaluateSample(project, path) {
  demand(typeof path === 'string', 'Choose a feature, object, or mounting surface to export a sample.')
  const { sample, issues } = evaluate(project, path)
  if (issues.length) throw new Error(issues[0].message)
  return sample
}

function evaluate(project, samplePath) {
  const issues = []
  const values = new Map()
  const mark = (field, message) => issues.push({ field, message })
  const nameValid = (name) => typeof name === 'string' && Boolean(name.trim()) && name.length <= 80
  if (samplePath === undefined && !nameValid(project.name)) mark('name', 'Enter a project name of 1 to 80 characters.')

  const variables = new Map()
  const duplicates = new Set()
  const resolvedVariables = new Map()
  const chain = new Set()
  let objectCount = 0
  let copies = 0

  function variable(name) {
    if (samplePath !== undefined && duplicates.has(name)) throw new Error('Variable “' + name + '” is already defined.')
    if (resolvedVariables.has(name)) return resolvedVariables.get(name)
    if (!variables.has(name)) throw new Error('Unknown variable “' + name + '”.')
    if (chain.has(name)) throw new Error('Circular reference involving “' + name + '”.')
    chain.add(name)
    try {
      const result = evaluateFormula(variables.get(name), variable)
      resolvedVariables.set(name, result)
      return result
    } finally {
      chain.delete(name)
    }
  }

  function fields(source, schema, path) {
    demand(record(source), 'A parameter group is missing.')
    return Object.fromEntries(Object.entries(schema).map(([key, spec]) => {
      const location = path + '.' + key
      try {
        const expression = spec.defaultIfMissing && source[key] === undefined ? spec.value : source[key]
        const value = evaluateFormula(expression, variable)
        if (spec.integer && !Number.isInteger(value)) throw new Error('Enter a whole number.')
        if (value < spec.min || value > spec.max) throw new Error('Use ' + spec.min + ' to ' + spec.max + (spec.unit ? ' ' + spec.unit : '') + '.')
        values.set(location, value)
        return [key, value]
      } catch (error) {
        mark(location, spec.label + ' — ' + error.message)
        return [key, NaN]
      }
    }))
  }

  function visitFeature(feature, path, root) {
    demand(record(feature) && Object.hasOwn(FEATURES, feature.type) && record(feature.properties), 'This project contains an unknown feature.')
    const { side, shape, placement = 'height' } = feature.properties
    demand(SIDES.includes(side) && SHAPES.includes(shape), 'A wall cutout is missing its wall or shape.')
    demand(placement === 'height' || (placement === 'seam' && root.type === 'split'),
      'Choose a wall cutout placement supported by the enclosure.')
    const parameters = fields(feature.parameters, featureFields(feature), path + '.parameters')
    if (placement === 'seam') parameters.z = root.parameters.seam
    return { type: feature.type, properties: { side, shape, placement }, parameters }
  }

  function visit(object, path, depth, hasUpper) {
    objectCount++
    demand(depth <= MAX_DEPTH && objectCount <= MAX_OBJECTS, 'The object hierarchy is too large.')
    const root = depth === 0
    demand(record(object) && Object.hasOwn(root ? ROOT_TYPES : CHILD_TYPES, object.type) && record(object.properties),
      root ? 'Choose an enclosure type as the project root.' : 'This project contains an unknown child object.')
    demand(Array.isArray(object.features) && object.features.length <= (root ? MAX_FEATURES : 0) &&
      Array.isArray(object.children) && object.children.length < MAX_OBJECTS, 'This object contains unsupported features or too many children.')
    const { type } = object
    const next = { type, properties: {} }
    if (type === 'lidded') {
      demand(typeof object.properties.includeLid === 'boolean', 'Choose whether the enclosure has a lid.')
      next.properties.includeLid = object.properties.includeLid
    }
    if (type === 'repeater') {
      demand(Object.hasOwn(REPEATER_OPERATIONS, object.properties.operation), 'Choose whether the geometry adds or cuts material.')
      next.properties.operation = object.properties.operation
    }
    if (type === 'pcb-corner-mount') {
      const { fastening } = object.properties
      demand(Object.hasOwn(PCB_MOUNT_FASTENINGS, fastening), 'Choose Screw or Snap-fit for the PCB corner mount.')
      next.properties.fastening = fastening
    }
    if (type === 'cable-duct') {
      const { fit } = object.properties
      if (!Object.hasOwn(CABLE_DUCT_FITS, fit)) mark(path + '.properties.fit', 'Choose a push-in fit for the cable duct.')
      next.properties.fit = fit
    }
    if (object.properties.reference !== undefined) {
      demand(CHILD_TYPES[type]?.supportsReference && typeof object.properties.reference === 'boolean',
        'Reference only must be a checkbox value on an object that supports it.')
      next.properties.reference = object.properties.reference
    }
    next.parameters = fields(object.parameters, parameterFields(next), path + '.parameters')

    if (!root) {
      if (!nameValid(object.name)) mark(path + '.name', 'Enter an object name of 1 to 80 characters.')
      next.name = object.name
      next.placement = fields(object.placement, PLACEMENT_FIELDS, path + '.placement')
      if (depth === 1) {
        const { part } = object.placement
        demand(part === 'base' || (hasUpper && part === 'upper'), 'A child is attached to an enclosure part that does not exist.')
        next.placement.part = part
      }
    }
    if (type === 'repeater') {
      const primitive = object.parameters.primitive
      demand(record(primitive) && Object.hasOwn(PRIMITIVES, primitive.type), 'Choose a box, cylinder, or sphere for the geometry.')
      next.parameters.primitive = {
        type: primitive.type,
        parameters: fields(primitive.parameters, PRIMITIVES[primitive.type].fields, path + '.parameters.primitive.parameters'),
      }
      copies += next.parameters.count || 0
      if (copies > 256) mark(path + '.parameters.count', 'Keep the project below 257 repeated copies.')
    }
    if (type === 'pcb-corner-mount') {
      validatePCBMount(next.parameters, next.properties.fastening,
        (field, message) => mark(path + '.parameters.' + field, message))
    }
    if (type === 'cable-duct') {
      validateCableDuct(next.parameters, (field, message) =>
        mark(path + '.parameters.' + field, 'Cable duct ' + message))
    }
    if (root) hasUpper = enclosureLayout(next).hasUpper
    next.features = object.features.map((feature, index) => visitFeature(feature, path + '.features.' + index, next))
    next.children = object.children.flatMap((child, index) => {
      if (samplePath !== undefined && child?.properties?.reference === true) return []
      return [visit(child, path + '.children.' + index, depth + 1, hasUpper)]
    })
    return next
  }

  function sampleRoot(includeScrewFields) {
    const source = project.root
    demand(record(source) && Object.hasOwn(ROOT_TYPES, source.type) && record(source.properties),
      'Choose an enclosure type as the project root.')
    const { type, properties } = source
    if (type === 'lidded') demand(typeof properties.includeLid === 'boolean', 'Choose whether the enclosure has a lid.')
    const schema = Object.fromEntries(Object.entries(parameterFields(source))
      .filter(([key]) => includeScrewFields || !Object.hasOwn(SCREW_FIELDS, key)))
    return { type, properties, parameters: fields(source.parameters, schema, 'root.parameters') }
  }

  function prepareSample(path) {
    const mountingPart = /^root\.mounting\.(base|upper)$/.exec(path)?.[1]
    if (mountingPart) {
      const root = sampleRoot(true)
      const { hasUpper, baseLabel, upperLabel } = enclosureLayout(root)
      demand(mountingPart === 'base' || hasUpper, 'This enclosure has no upper mounting surface.')
      // Wall cutouts are above the floor and below the ceiling. Surface cuts come from child branches and fasteners.
      root.features = []
      validateRoot(root, mark)
      const { children } = project.root
      demand(Array.isArray(children) && children.length < MAX_OBJECTS, 'The enclosure contains too many children or is missing its object list.')
      root.children = children.flatMap((child, index) => {
        if (child?.placement?.part !== mountingPart || child.properties?.reference === true) return []
        return [visit(child, 'root.children.' + index, 1, hasUpper)]
      })
      demand(root.children.length > 0, 'Add a printable object or cut to this mounting surface first.')
      const label = (mountingPart === 'base' ? baseLabel : upperLabel) + ' mounting'
      return { root, mountingPart, label }
    }
    if (/^root\.features\.\d+$/.test(path)) {
      const index = Number(path.split('.').at(-1))
      const feature = project.root?.features?.[index]
      demand(feature?.type === 'cutout', 'Choose a wall cutout to export a fit sample.')
      const root = sampleRoot(false)
      const cutout = visitFeature(feature, path, root)
      validateEnclosureShell(root, mark)
      validateWallCutout(root, cutout, index, mark)
      return { root, cutout, label: cutout.properties.side + ' wall cutout ' + (index + 1) }
    }
    demand(/^root(?:\.children\.\d+)+$/.test(path), 'Choose a non-root object to export a sample.')
    const indices = path.split('.children.').slice(1)
    demand(indices.length <= MAX_DEPTH, 'The object hierarchy is too deep.')
    let ancestorPath = 'root'
    let object = project.root
    let ancestorAngle = 0
    indices.forEach((index, i) => {
      ancestorPath += '.children.' + index
      object = object.children?.[index]
      demand(record(object) && record(object.properties) && addsGeometry(object),
        'Choose an object in a branch that adds material.')
      if (i < indices.length - 1) {
        ancestorAngle += fields(object.placement, { angle: PLACEMENT_FIELDS.angle }, ancestorPath + '.placement').angle
      }
    })
    const resolved = visit(object, path, indices.length, true)
    return { object: resolved, ancestorAngle, label: resolved.name?.trim() || CHILD_TYPES[resolved.type].label }
  }

  try {
    demand(Array.isArray(project.variables) && project.variables.length <= MAX_VARIABLES, 'The project has invalid or too many variables.')
    project.variables.forEach((entry, index) => {
      demand(record(entry), 'A project variable is missing its name or formula.')
      if (typeof entry.name !== 'string' || entry.name.length > 40 || !VARIABLE_NAME.test(entry.name)) {
        mark('variables.' + index + '.name', 'Use a variable name that starts with a letter or underscore, followed by letters, digits, or underscores.')
      } else if (variables.has(entry.name)) {
        duplicates.add(entry.name)
        mark('variables.' + index + '.name', 'Variable “' + entry.name + '” is already defined.')
      } else {
        variables.set(entry.name, entry.value)
      }
    })
    if (samplePath !== undefined) {
      // Sample formulas resolve only the variables the sample uses.
      issues.length = 0
      return { sample: prepareSample(samplePath), issues }
    }
    project.variables.forEach(({ name }, index) => {
      if (!variables.has(name)) return
      try {
        values.set('variables.' + index + '.value', variable(name))
      } catch (error) {
        mark('variables.' + index + '.value', name + ' — ' + error.message)
      }
    })
    const root = visit(project.root, 'root', 0, false)
    if (!issues.length || screwClosureDraftIssues(root, issues).length) validateRoot(root, mark)
    return { root, issues, values }
  } catch (error) {
    mark('root', error.message)
    return { issues, values }
  }
}

export function parseProject(source) {
  let project
  try {
    project = JSON.parse(source)
  } catch {
    throw new Error('This file does not contain valid JSON.')
  }
  demand(record(project) && project.version === PROJECT_VERSION,
    'Choose a Just in Case project with format version ' + PROJECT_VERSION + '.')
  const [issue] = evaluateProject(project).issues
  if (issue) throw new Error(issue.message)
  project.name = project.name.trim()
  return project
}

export function projectJSON(project) {
  return JSON.stringify({ ...project, name: project.name.trim() }, null, 2) + '\n'
}

export function objectAt(project, path) {
  return path.split('.').reduce((object, key) => object[key], project)
}

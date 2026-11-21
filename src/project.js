import { evaluateFormula, VARIABLE_NAME } from './formula.js'
import {
  ROOT_TYPES, CHILD_TYPES, FEATURES, PRIMITIVES, PLACEMENT_FIELDS, SIDES, SHAPES,
  enclosureLayout, featureFields, fieldDefaults, lidRimWidth, makePrimitive, parameterFields,
} from './definitions.js'

export const STORAGE_KEY = 'just-in-case.project.v2'
export const LEGACY_STORAGE_KEY = 'just-in-case.project.v1'
export const MAX_VARIABLES = 32
export const MAX_FEATURES = 24
export const MAX_OBJECTS = 40
export const MAX_DEPTH = 6

export function newProject(type = 'lidded', includeLid = true) {
  const root = { type, properties: type === 'lidded' ? { includeLid } : {}, parameters: {}, features: [], children: [] }
  root.parameters = fieldDefaults(parameterFields(root))
  return { version: 2, name: 'Electronics enclosure', variables: [], root }
}

export function makeChild(type, operation = 'add', direct = true) {
  const object = {
    type,
    name: CHILD_TYPES[type].label,
    properties: type === 'repeater' ? { operation } : {},
    parameters: fieldDefaults(CHILD_TYPES[type].fields),
    placement: { ...fieldDefaults(PLACEMENT_FIELDS), ...(direct ? { part: 'base' } : {}) },
    features: [],
    children: [],
  }
  if (type === 'repeater') {
    object.parameters.primitive = makePrimitive(operation === 'cut' ? 'cylinder' : 'box')
    if (direct) object.placement.x = -15
    if (operation === 'cut') object.placement.z = -3
  }
  return object
}

export function makeFeature(type, root) {
  const feature = { type, properties: {}, parameters: fieldDefaults(FEATURES[type].fields) }
  if (type !== 'cutout') return feature

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
    makeFeature('screw-posts', project.root),
  ]
  return project
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function demand(condition, message) {
  if (!condition) throw new Error(message)
}

function migrateV1(value) {
  demand(record(value.body) && record(value.lid) && record(value.mounts) &&
    typeof value.mounts.enabled === 'boolean' && Array.isArray(value.cutouts) &&
    value.cutouts.length <= 16 && value.cutouts.every(record), 'The version 1 project is missing enclosure settings.')
  const project = newProject()
  project.name = value.name
  const fields = { ...value.body, ...value.lid }
  project.root.parameters = Object.fromEntries(Object.keys(parameterFields(project.root)).map((key) => [key, fields[key]]))
  project.root.features = value.cutouts.map(({ side, shape, width, height, offset, z }) => ({
    type: 'cutout',
    properties: { side, shape },
    parameters: shape === 'Circle' ? { width, offset, z } : { width, height, offset, z },
  }))
  if (value.mounts.enabled) {
    const { height, diameter, hole, inset } = value.mounts
    project.root.features.push({ type: 'screw-posts', properties: {}, parameters: { height, diameter, hole, inset } })
  }
  return project
}

function validateRoot(root, mark) {
  const p = root.parameters
  const { baseHeight, upperHeight, height, hasUpper } = enclosureLayout(root)
  const narrowest = Math.min(p.width, p.depth)
  const lip = hasUpper ? p.lip : 0
  const thickness = hasUpper ? p.thickness : 0
  const wallTop = root.type === 'split' ? height - thickness : baseHeight
  const field = (key, message) => mark('root.parameters.' + key, message)
  if (p.radius > narrowest / 2 - 1) field('radius', 'Leave 2 mm of straight edge between the rounded corners.')
  if (narrowest - 2 * p.wall < 4) field('wall', 'Leave at least 4 mm of interior width and depth.')
  if (baseHeight - p.floor < 2) field(root.type === 'split' ? 'seam' : 'floor', 'Leave at least 2 mm inside the base above the floor.')
  if (root.type === 'split' && upperHeight - thickness < 2) field('seam', 'Leave at least 2 mm inside the upper half below its ceiling.')
  if (lip > baseHeight - p.floor - 0.5) field('lip', 'Leave at least 0.5 mm between the lip and the floor.')
  if (lip > 0 && narrowest - 2 * (p.wall + p.clearance + lidRimWidth(p)) < 2) {
    field('clearance', 'Reduce the wall thickness or clearance to leave room inside the lip.')
  }

  root.features.forEach((feature, index) => {
    const f = feature.parameters
    const label = FEATURES[feature.type].label + ' ' + (index + 1)
    const issue = (key, message) => mark('root.features.' + index + '.parameters.' + key, label + ' ' + message)
    if (feature.type === 'cutout') {
      const wallLength = ['Front', 'Back'].includes(feature.properties.side) ? p.width : p.depth
      const openingHeight = feature.properties.shape === 'Circle' ? f.width : f.height
      if (Math.abs(f.offset) + f.width / 2 > wallLength / 2 - Math.max(p.radius, p.wall) - 1) {
        issue('offset', 'must fit on the straight wall with 1 mm of room at each end.')
      }
      if (f.z - openingHeight / 2 < p.floor + 0.5 || f.z + openingHeight / 2 > wallTop - 1) {
        issue('z', 'needs 0.5 mm above the floor and 1 mm below the top of the wall.')
      }
      return
    }
    const postRadius = f.diameter / 2
    const cavityRadius = Math.max(0, p.radius - p.wall)
    const cornerOffset = cavityRadius - (f.inset - p.wall)
    const wallGap = cavityRadius - (cornerOffset > 0 ? Math.SQRT2 * cornerOffset : cornerOffset)
    if (narrowest / 2 - f.inset < postRadius + 0.25 || wallGap < postRadius + 0.25) {
      issue('inset', 'need room between the posts and inner walls.')
    }
    if (f.hole + 1.2 > f.diameter) issue('hole', 'need at least 0.6 mm of material around each pilot hole.')
    if (p.floor + f.height + lip + 0.5 > baseHeight) issue('height', 'must fit below the mating edge.')
  })
}

export function evaluateProject(project) {
  const issues = []
  const values = new Map()
  const mark = (field, message) => issues.push({ field, message })
  const nameValid = (name) => typeof name === 'string' && Boolean(name.trim()) && name.length <= 80
  if (!nameValid(project.name)) mark('name', 'Enter a project name of 1 to 80 characters.')

  const variables = new Map()
  const resolvedVariables = new Map()
  const chain = new Set()
  let objectCount = 0
  let copies = 0

  function variable(name) {
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
        const value = evaluateFormula(source[key], variable)
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

  function visitFeature(feature, path) {
    demand(record(feature) && Object.hasOwn(FEATURES, feature.type) && record(feature.properties), 'This project contains an unknown feature.')
    const { type } = feature
    let properties = {}
    if (type === 'cutout') {
      const { side, shape } = feature.properties
      demand(SIDES.includes(side) && SHAPES.includes(shape), 'A wall cutout is missing its wall or shape.')
      properties = { side, shape }
    }
    return { type, properties, parameters: fields(feature.parameters, featureFields(feature), path + '.parameters') }
  }

  function visit(object, path, depth, hasUpper) {
    objectCount++
    demand(depth <= MAX_DEPTH && objectCount <= MAX_OBJECTS, 'The object hierarchy is too large.')
    const root = depth === 0
    demand(record(object) && Object.hasOwn(root ? ROOT_TYPES : CHILD_TYPES, object.type) && record(object.properties),
      root ? 'Choose a lidded or split enclosure as the project root.' : 'This project contains an unknown child object.')
    demand(Array.isArray(object.features) && object.features.length <= (root ? MAX_FEATURES : 0) &&
      Array.isArray(object.children) && object.children.length < MAX_OBJECTS, 'This object contains unsupported features or too many children.')
    const { type } = object
    const next = { type, properties: {} }
    if (type === 'lidded') {
      demand(typeof object.properties.includeLid === 'boolean', 'Choose whether the enclosure has a lid.')
      next.properties.includeLid = object.properties.includeLid
    }
    if (type === 'repeater') {
      demand(['add', 'cut'].includes(object.properties.operation), 'Choose whether the repeater adds or cuts material.')
      next.properties.operation = object.properties.operation
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
      demand(record(primitive) && Object.hasOwn(PRIMITIVES, primitive.type), 'Choose a box, cylinder, or sphere for the repeater.')
      next.parameters.primitive = {
        type: primitive.type,
        parameters: fields(primitive.parameters, PRIMITIVES[primitive.type].fields, path + '.parameters.primitive.parameters'),
      }
      copies += next.parameters.count || 0
      if (copies > 256) mark(path + '.parameters.count', 'Keep the project below 257 repeated copies.')
    }
    if (type === 'pcb-mount' && next.parameters.length > next.parameters.boardDepth / 2 - 0.5) {
      mark(path + '.parameters.length', 'Shorten the clips to leave room between each pair.')
    }
    if (root) hasUpper = type === 'split' || next.properties.includeLid
    next.features = object.features.map((feature, index) => visitFeature(feature, path + '.features.' + index))
    next.children = object.children.map((child, index) => visit(child, path + '.children.' + index, depth + 1, hasUpper))
    return next
  }

  try {
    demand(Array.isArray(project.variables) && project.variables.length <= MAX_VARIABLES, 'The project has invalid or too many variables.')
    project.variables.forEach((entry, index) => {
      demand(record(entry), 'A project variable is missing its name or formula.')
      if (typeof entry.name !== 'string' || entry.name.length > 40 || !VARIABLE_NAME.test(entry.name)) {
        mark('variables.' + index + '.name', 'Use a variable name that starts with a letter or underscore, followed by letters, digits, or underscores.')
      } else if (variables.has(entry.name)) {
        mark('variables.' + index + '.name', 'Variable “' + entry.name + '” is already defined.')
      } else {
        variables.set(entry.name, entry.value)
      }
    })
    project.variables.forEach(({ name }, index) => {
      if (!variables.has(name)) return
      try {
        values.set('variables.' + index + '.value', variable(name))
      } catch (error) {
        mark('variables.' + index + '.value', name + ' — ' + error.message)
      }
    })
    const root = visit(project.root, 'root', 0, false)
    if (issues.length === 0) validateRoot(root, mark)
    return { root, issues, values }
  } catch (error) {
    mark('root', error.message)
    return { issues, values }
  }
}

export function parseProject(source) {
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('This file does not contain valid JSON.')
  }
  demand(record(value) && [1, 2].includes(value.version), 'Choose a Just in Case project with format version 1 or 2.')
  const project = value.version === 1 ? migrateV1(value) : value
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

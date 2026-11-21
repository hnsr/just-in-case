const mm = (label, value, min, max) => ({ label, value, min, max, unit: 'mm' })
const angle = (label) => ({ label, value: 0, min: -360, max: 360, unit: '°' })

const body = {
  width: mm('Width', 100, 20, 400),
  depth: mm('Depth', 70, 20, 400),
  height: mm('Body height', 30, 8, 200),
  wall: mm('Wall thickness', 2.4, 1, 12),
  floor: mm('Floor thickness', 2.4, 1, 12),
  radius: mm('Corner radius', 5, 0, 100),
}
const closure = {
  thickness: mm('Lid thickness', 2.4, 1, 12),
  lip: mm('Lip depth', 3.2, 0, 15),
  clearance: mm('Fit clearance per side', 0.25, 0.1, 2),
}

export const ROOT_TYPES = {
  lidded: { label: 'Lidded enclosure', icon: 'box' },
  split: { label: 'Split enclosure', icon: 'layers' },
}

export const CHILD_TYPES = {
  'pcb-screw-mount': {
    label: 'PCB screw mounts', icon: 'bolt',
    fields: {
      pitchX: mm('X hole spacing', 32, 2, 400),
      pitchY: mm('Y hole spacing', 24, 2, 400),
      height: mm('Post height', 6, 1, 60),
      diameter: mm('Post diameter', 7, 2, 30),
      pilotDiameter: mm('Pilot hole diameter', 2.7, 0.5, 12),
      pilotDepth: mm('Pilot hole depth', 5, 0.5, 60),
    },
  },
  'pcb-mount': {
    label: 'PCB press-fit mounts', icon: 'bolt',
    fields: {
      boardWidth: mm('Board width', 40, 12, 360),
      boardDepth: mm('Board depth', 30, 12, 360),
      boardThickness: mm('Board thickness', 1.6, 0.5, 5),
      support: mm('Board height above floor', 4, 2, 45),
      clearance: mm('Edge clearance per side', 0.2, 0, 1.5),
      grip: mm('Clip overhang', 0.35, 0.15, 1.5),
      wall: mm('Clip thickness', 1.4, 0.8, 4),
      length: mm('Clip length', 5, 2, 40),
    },
  },
  repeater: {
    label: 'Geometry repeater', icon: 'grid',
    fields: {
      count: { label: 'Copies', value: 4, min: 1, max: 32, integer: true },
      stepX: mm('X step', 10, -400, 400),
      stepY: mm('Y step', 0, -400, 400),
      stepZ: mm('Z step', 0, -200, 200),
      turnX: angle('X rotation per copy'),
      turnY: angle('Y rotation per copy'),
      turnZ: angle('Z rotation per copy'),
    },
  },
}

export const REPEATER_OPERATIONS = {
  add: { label: 'Add material', treeLabel: 'Add' },
  cut: { label: 'Cut material', treeLabel: 'Cut' },
}

export const PLACEMENT_FIELDS = {
  x: mm('X offset', 0, -400, 400),
  y: mm('Y offset', 0, -400, 400),
  z: mm('Z offset', 0, -200, 200),
  angle: angle('Z rotation'),
}

export const PRIMITIVES = {
  box: { label: 'Box', fields: { width: mm('Width', 5, 0.5, 400), depth: mm('Depth', 5, 0.5, 400), height: mm('Height', 5, 0.5, 200) } },
  cylinder: { label: 'Cylinder', fields: { diameter: mm('Diameter', 5, 0.5, 400), height: mm('Height', 6, 0.5, 200) } },
  sphere: { label: 'Sphere', fields: { diameter: mm('Diameter', 5, 0.5, 400) } },
}

export const FEATURES = {
  cutout: {
    label: 'Wall cutout', icon: 'scissors',
    fields: {
      width: mm('Width', 12, 1, 400),
      height: mm('Height', 6, 1, 200),
      offset: mm('Wall offset', 0, -200, 200),
      z: mm('Center from enclosure bottom', 12, 0, 200),
    },
  },
  'screw-closure': {
    label: 'Screw closure', icon: 'bolt',
    fields: {
      insetX: mm('X inset from outside', 12, 2, 200),
      insetY: mm('Y inset from outside', 12, 2, 200),
      diameter: mm('Boss diameter', 8, 2, 30),
      pilotDiameter: mm('Pilot hole diameter', 2.7, 0.5, 12),
      pilotDepth: mm('Pilot hole depth', 7, 0.5, 60),
      clearanceDiameter: mm('Lid hole diameter', 3.4, 0.8, 16),
      counterboreDepth: mm('Counterbore depth', 0, 0, 12),
      counterboreDiameter: mm('Counterbore diameter', 6.2, 2, 30),
    },
  },
}

export const SIDES = ['Front', 'Right', 'Back', 'Left']
export const SHAPES = ['Rectangle', 'Circle']
export const SCREW_LAYOUTS = { corners: 'Four corners', custom: 'Custom positions' }
export const SCREW_POSITION_FIELDS = { x: mm('X position', 0, -200, 200), y: mm('Y position', 0, -200, 200) }

export function supportsScrewClosure(root) {
  return root.type === 'lidded' && root.properties.includeLid
}

export function rectangleCorners(x, y) {
  return [{ x, y }, { x: -x, y }, { x: -x, y: -y }, { x, y: -y }]
}

export function screwPositions(body, feature) {
  const { insetX, insetY, positions } = feature.parameters
  return feature.properties.layout === 'custom' ? positions : rectangleCorners(body.width / 2 - insetX, body.depth / 2 - insetY)
}

export function parameterFields(object) {
  if (object.type === 'lidded') return object.properties.includeLid ? { ...body, ...closure } : body
  if (object.type === 'split') {
    return {
      ...body,
      height: mm('Total height', 32.4, 10, 200),
      seam: mm('Lower half height', 16, 4, 196),
      ...closure,
      thickness: mm('Ceiling thickness', 2.4, 1, 12),
    }
  }
  return CHILD_TYPES[object.type].fields
}

export function featureFields(feature) {
  if (feature.type === 'screw-closure' && feature.properties.layout === 'custom') {
    const { insetX, insetY, ...shared } = FEATURES['screw-closure'].fields
    return shared
  }
  if (feature.type !== 'cutout' || feature.properties.shape !== 'Circle') return FEATURES[feature.type].fields
  const { width, offset, z } = FEATURES.cutout.fields
  return { width: { ...width, label: 'Diameter' }, offset, z }
}

export function fieldDefaults(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, spec]) => [key, spec.value]))
}

export function makePrimitive(type) {
  return { type, parameters: fieldDefaults(PRIMITIVES[type].fields) }
}

export function enclosureLayout(root) {
  const p = root.parameters
  const split = root.type === 'split'
  const hasUpper = split || root.properties.includeLid
  const baseHeight = split ? p.seam : p.height
  const height = split ? p.height : p.height + (hasUpper ? p.thickness : 0)
  return {
    width: p.width,
    depth: p.depth,
    height,
    baseHeight,
    upperHeight: split ? height - baseHeight : hasUpper ? p.thickness : 0,
    upperLabel: split ? 'Upper half' : 'Lid',
    baseLabel: split ? 'Lower half' : 'Base',
    hasUpper,
  }
}

export function lidRimWidth(p) {
  return Math.min(1.6, p.wall)
}

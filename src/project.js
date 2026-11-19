export const STORAGE_KEY = 'just-in-case.project.v1'
export const MAX_CUTOUTS = 16

export const BODY_FIELDS = {
  width: { label: 'Width', min: 20, max: 400 },
  depth: { label: 'Depth', min: 20, max: 400 },
  height: { label: 'Body height', min: 8, max: 200 },
  wall: { label: 'Wall thickness', min: 1, max: 12 },
  floor: { label: 'Floor thickness', min: 1, max: 12 },
  radius: { label: 'Corner radius', min: 0, max: 100 },
}

export const LID_FIELDS = {
  thickness: { label: 'Lid thickness', min: 1, max: 12 },
  lip: { label: 'Lip depth', min: 0, max: 15 },
  clearance: { label: 'Fit clearance', min: 0.1, max: 2, step: 0.05 },
}

export const MOUNT_FIELDS = {
  height: { label: 'Post height', min: 1, max: 60 },
  diameter: { label: 'Post diameter', min: 2, max: 20 },
  hole: { label: 'Pilot hole diameter', min: 0.5, max: 12 },
  inset: { label: 'Inset from outside', min: 2, max: 100 },
}

export const SIDES = ['Front', 'Right', 'Back', 'Left']

export function defaultProject() {
  return {
    version: 1,
    name: 'Electronics enclosure',
    body: { width: 100, depth: 70, height: 30, wall: 2.4, floor: 2.4, radius: 5 },
    lid: { thickness: 2.4, lip: 3.2, clearance: 0.25 },
    cutouts: [
      { side: 'Front', shape: 'Rectangle', width: 16, height: 8, offset: -21, z: 12 },
      { side: 'Right', shape: 'Circle', width: 11, height: 8, offset: 9, z: 14 },
    ],
    mounts: { enabled: true, height: 6, diameter: 7, hole: 2.7, inset: 12 },
  }
}

export function makeCutout(body, cutouts) {
  const edge = Math.max(body.radius, body.wall) + 1
  const height = Math.max(1, Math.min(6, Math.floor(body.height - body.floor - 1.5)))
  const z = (body.height + body.floor - 0.5) / 2
  const walls = [
    [body.width, 'Front'], [body.depth, 'Right'], [body.width, 'Back'], [body.depth, 'Left'],
  ].sort(([a], [b]) => b - a)
  const placements = walls.flatMap(([length, side]) => {
    const width = Math.max(1, Math.min(12, Math.floor(length - 2 * edge)))
    const travel = Math.max(0, Math.floor(length / 2 - edge - width / 2))
    return [0, -travel, travel].map((offset) => ({ side, shape: 'Rectangle', width, height, offset, z }))
  })
  const fits = ({ side, offset, width }) => cutouts.every((cutout) => (
    cutout.side !== side ||
    Math.abs(cutout.offset - offset) >= (cutout.width + width) / 2 + 1 ||
    Math.abs(cutout.z - z) >= ((cutout.shape === 'Circle' ? cutout.width : cutout.height) + height) / 2 + 1
  ))
  return placements.find(fits) ?? placements[0]
}

export function lidRimWidth(body) {
  return Math.min(1.6, body.wall)
}

function collectNumbers(group, schema, prefix, issues) {
  for (const [key, { label, min, max }] of Object.entries(schema)) {
    const number = group[key]
    if (!Number.isFinite(number) || number < min || number > max) {
      issues.push({ field: prefix + key, message: label + ' must be between ' + min + ' and ' + max + ' mm.' })
    }
  }
}

export function validateProject(project) {
  const { name, body, lid, cutouts, mounts } = project
  const issues = []
  const mark = (field, message) => issues.push({ field, message })

  if (typeof name !== 'string' || !name.trim() || name.length > 80) {
    mark('name', 'Enter a project name of 1 to 80 characters.')
  }
  collectNumbers(body, BODY_FIELDS, 'body.', issues)
  collectNumbers(lid, LID_FIELDS, 'lid.', issues)
  collectNumbers(mounts, MOUNT_FIELDS, 'mounts.', issues)

  const narrowest = Math.min(body.width, body.depth)
  if (body.radius > narrowest / 2 - 1) {
    mark('body.radius', 'Leave at least 2 mm of straight edge between the rounded corners.')
  }
  if (narrowest - 2 * body.wall < 4) {
    mark('body.wall', 'Leave at least 4 mm of interior width and depth.')
  }
  if (body.height - body.floor < 2) {
    mark('body.floor', 'Leave at least 2 mm of space above the floor.')
  }

  if (lid.lip > 0) {
    if (lid.lip > body.height - body.floor - 0.5) {
      mark('lid.lip', 'Leave at least 0.5 mm between the lid lip and the floor.')
    }
    if (narrowest - 2 * (body.wall + lid.clearance + lidRimWidth(body)) < 2) {
      mark('lid.clearance', 'Reduce clearance or wall thickness to leave space inside the lid lip.')
    }
  }

  if (cutouts.length > MAX_CUTOUTS) {
    mark('cutouts', 'A project can have up to ' + MAX_CUTOUTS + ' cutouts.')
  }
  cutouts.forEach((cutout, index) => {
    const prefix = 'cutouts.' + index + '.'
    const label = 'Cutout ' + (index + 1)
    const wallLength = ['Front', 'Back'].includes(cutout.side) ? body.width : body.depth
    const height = cutout.shape === 'Circle' ? cutout.width : cutout.height
    if (!SIDES.includes(cutout.side) || !['Rectangle', 'Circle'].includes(cutout.shape)) {
      mark(prefix + 'side', label + ' needs a valid wall and shape.')
    }
    if (!Number.isFinite(cutout.width) || cutout.width < 1 || cutout.width > BODY_FIELDS.width.max) {
      mark(prefix + 'width', label + ' needs a width or diameter of at least 1 mm.')
    }
    if (!Number.isFinite(cutout.height) || cutout.height < 1 || cutout.height > BODY_FIELDS.height.max) {
      mark(prefix + 'height', label + ' needs a stored height between 1 and 200 mm.')
    }
    if (!Number.isFinite(cutout.offset) || Math.abs(cutout.offset) + cutout.width / 2 > wallLength / 2 - Math.max(body.radius, body.wall) - 1) {
      mark(prefix + 'offset', label + ' must fit on the straight wall with 1 mm of room at each end.')
    }
    if (!Number.isFinite(cutout.z) || cutout.z - height / 2 < body.floor + 0.5 || cutout.z + height / 2 > body.height - 1) {
      mark(prefix + 'z', label + ' needs 0.5 mm above the floor and 1 mm below the top edge.')
    }
  })

  if (mounts.enabled) {
    const { width, depth, wall, radius } = body
    const postRadius = mounts.diameter / 2
    const cavityRadius = Math.max(0, radius - wall)
    const halfWidth = width / 2 - mounts.inset
    const halfDepth = depth / 2 - mounts.inset
    const cornerOffset = cavityRadius - (mounts.inset - wall)
    const wallGap = cavityRadius - (cornerOffset > 0 ? Math.SQRT2 * cornerOffset : cornerOffset)
    if (halfWidth < postRadius + 0.25 || halfDepth < postRadius + 0.25 || wallGap < postRadius + 0.25) {
      mark('mounts.inset', 'Position the four posts with room between them and the inner walls.')
    }
    if (mounts.hole + 1.2 > mounts.diameter) {
      mark('mounts.hole', 'Leave at least 0.6 mm of material around each pilot hole.')
    }
    if (body.floor + mounts.height + lid.lip + 0.5 > body.height) {
      mark('mounts.height', 'Leave at least 0.5 mm between the posts and the lid lip.')
    }
  }
  return issues
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
}

function pickNumbers(group, schema) {
  if (!record(group)) throw new Error('The project is missing a parameter group.')
  return Object.fromEntries(Object.keys(schema).map((key) => [key, group[key]]))
}

export function parseProject(source) {
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('This file does not contain valid JSON.')
  }
  if (!record(value) || value.version !== 1) {
    throw new Error('Choose a Just in Case project with format version 1.')
  }
  if (!Array.isArray(value.cutouts) || value.cutouts.length > MAX_CUTOUTS ||
      !value.cutouts.every(record) || typeof value.mounts?.enabled !== 'boolean') {
    throw new Error('This file contains invalid cutouts or mounting settings.')
  }
  const project = {
    version: 1,
    name: typeof value.name === 'string' ? value.name.trim() : value.name,
    body: pickNumbers(value.body, BODY_FIELDS),
    lid: pickNumbers(value.lid, LID_FIELDS),
    cutouts: value.cutouts.map(({ side, shape, width, height, offset, z }) => ({ side, shape, width, height, offset, z })),
    mounts: { enabled: value.mounts.enabled, ...pickNumbers(value.mounts, MOUNT_FIELDS) },
  }
  const [issue] = validateProject(project)
  if (issue) throw new Error(issue.message)
  return project
}

export function projectJSON(project) {
  return JSON.stringify({ ...project, name: project.name.trim() }, null, 2) + '\n'
}

import {
  ROOT_TYPES, CHILD_TYPES, FEATURES, PRIMITIVES, REPEATER_OPERATIONS, PLACEMENT_FIELDS, SIDES, SHAPES, CUTOUT_PLACEMENTS,
  BOOLEAN_OVERLAP, CABLE_DUCT_FITS, PCB_MOUNT_FASTENINGS,
  SCREW_FIELDS, isScrewParameter, enclosureLayout, featureFields, makePrimitive, parameterFields,
} from './definitions.js'
import { MAX_DEPTH, MAX_FEATURES, MAX_OBJECTS, MAX_VARIABLES, addsGeometry, makeChild, makeFeature, newProject, objectAt } from './project.js'
import { addIcons } from './icons.js'

const $ = (selector) => document.querySelector(selector)
const formatter = new Intl.NumberFormat('en', { maximumFractionDigits: 4, useGrouping: false })
const NUMBER_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

function parseNumberLiteral(text) {
  if (!NUMBER_LITERAL.test(text.trim())) return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

function adjustNumber(event, { min = -Infinity, max = Infinity, integer = false }) {
  const input = event.currentTarget
  if (input.ownerDocument.activeElement !== input || event.ctrlKey || event.metaKey || !event.cancelable) return
  const delta = event.deltaY || (event.shiftKey ? event.deltaX : 0)
  if (!delta) return

  const current = parseNumberLiteral(input.value)
  if (current === undefined) return
  event.preventDefault()

  const step = event.shiftKey && !integer ? 0.1 : 1
  let adjusted = current - Math.sign(delta) * step
  if (integer) adjusted = delta < 0 ? Math.floor(adjusted) : Math.ceil(adjusted)
  const next = Number(Math.min(max, Math.max(min, adjusted)).toFixed(12))
  if (next === current) return
  input.value = String(next)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function element(tag, className, content) {
  const result = document.createElement(tag)
  if (className) result.className = className
  if (content !== undefined) result.textContent = content
  return result
}

function icon(name, className) {
  const result = element('span', className)
  result.dataset.icon = name
  return result
}

function button(label, symbol, style, action) {
  const result = element('button', style)
  result.type = 'button'
  if (symbol) result.append(icon(symbol))
  result.append(label)
  result.addEventListener('click', action)
  return result
}

function field(label, control, className, suffix) {
  const result = element('label', 'field')
  const wrapper = element('span', className)
  wrapper.append(control)
  if (suffix) {
    suffix.setAttribute('aria-hidden', 'true')
    wrapper.append(suffix)
  }
  result.append(element('span', 'field-label', label), wrapper)
  return result
}

function textField(path, label, value, numberSpec) {
  const input = element('input')
  input.type = 'text'
  input.value = typeof value === 'number' || typeof value === 'string' ? value : ''
  input.maxLength = numberSpec ? 160 : path.startsWith('variables.') ? 40 : 80
  input.spellcheck = false
  input.autocomplete = 'off'
  input.dataset.field = path
  const unit = numberSpec?.unit
  const suffix = unit ? element('span', '', unit) : null
  const result = field(label, input, numberSpec ? 'number-input' : 'text-input', suffix)
  if (numberSpec) {
    input.dataset.formula = ''
    input.addEventListener('wheel', (event) => adjustNumber(event, numberSpec), { passive: false })
    const resolved = element('span', 'resolved-value')
    resolved.setAttribute('aria-hidden', 'true')
    resolved.hidden = true
    result.append(resolved)
  }
  return result
}

function select(options, value, path) {
  const control = element('select')
  if (path) control.dataset.field = path
  control.append(...options.map(([key, label]) => new Option(label, key)))
  control.value = value
  return control
}

function selectField(path, label, options, value) {
  return field(label, select(options, value, path), 'select-input', icon('chevron'))
}

function fields(schema, values, path) {
  const grid = element('div', 'fields')
  for (const [key, spec] of Object.entries(schema)) {
    const value = spec.defaultIfMissing && values[key] === undefined ? spec.value : values[key]
    grid.append(textField(path + '.' + key, spec.label, value, spec))
  }
  return grid
}

function picker(label, choices, action, disabled) {
  const row = element('div', 'add-row')
  const control = select(choices, choices[0][0])
  control.setAttribute('aria-label', label + ' type')
  control.disabled = disabled
  const wrapper = element('div', 'select-input')
  wrapper.append(control, icon('chevron'))
  const add = button(label, 'plus', 'button button-small', () => action(control.value))
  add.disabled = disabled
  row.append(wrapper, add)
  return row
}

function ownLabel(object) {
  return object.name?.trim() || (ROOT_TYPES[object.type] ?? CHILD_TYPES[object.type]).label
}

function countDescendants(object) {
  return object.children.reduce((total, child) => total + 1 + countDescendants(child), 0)
}

export function createInspector(getProject, getEvaluatedRoot, onChange, onSelect, onVisibilityChange, onExportSample) {
  const tree = $('#object-tree')
  const selected = $('#object-inspector')
  const childPicker = $('#child-picker')
  const objectActions = $('#object-actions')
  const exportAction = objectActions.querySelector('[data-object-action="export"]')
  const removeDialog = $('#remove-object-dialog')
  const variablesPanel = $('#variables-panel')
  const variablesToggle = $('#variables-toggle')
  const list = $('#variable-list')
  const addVariable = $('#add-variable')
  const openSections = new Map()
  let hiddenObjects = new WeakSet()
  let path = 'root'
  let inheritsReference = false
  let rowTarget
  let pendingRemoval

  function disclosure(label, key, { glyph, summary, open = false } = {}) {
    const details = element('details', 'parameter-section')
    details.dataset.section = key
    details.open = openSections.get(key) ?? open
    details.addEventListener('toggle', () => {
      if (details.isConnected) openSections.set(key, details.open)
    })
    const title = element('summary')
    if (glyph) title.append(icon(glyph, 'section-icon'))
    title.append(element('span', 'section-title', label), element('span', 'section-summary', summary), icon('chevron', 'chevron'))
    const content = element('div', 'section-content')
    details.append(title, content)
    return { details, content }
  }

  function closeRowPopover() {
    if (rowTarget?.popover.matches(':popover-open')) rowTarget.popover.hidePopover()
  }

  function positionRowPopover() {
    if (!rowTarget?.popover.matches(':popover-open')) return
    const { trigger, popover } = rowTarget
    const { top, bottom, right } = trigger.getBoundingClientRect()
    const { clientWidth, clientHeight } = document.documentElement
    if (top >= clientHeight || bottom <= 0) {
      closeRowPopover()
      return
    }
    const gap = 8
    const maxTop = clientHeight - popover.offsetHeight - gap
    const above = top - popover.offsetHeight - gap
    const left = Math.min(right, clientWidth - gap) - popover.offsetWidth
    popover.style.left = Math.max(gap, left) + 'px'
    popover.style.top = Math.max(gap, bottom + gap <= maxTop ? bottom + gap : above >= gap ? above : maxTop) + 'px'
  }

  function openRowPopover(popover, trigger, target) {
    const sameTrigger = rowTarget?.trigger === trigger
    closeRowPopover()
    if (sameTrigger) return
    rowTarget = { ...target, trigger, popover }
    trigger.setAttribute('aria-expanded', 'true')
    trigger.focus({ preventScroll: true })
    popover.showPopover({ source: trigger })
    positionRowPopover()
    popover.querySelector('button:not([hidden])')?.focus({ preventScroll: true })
  }

  function requestRemoval(object, key, parent) {
    function remove() {
      const index = parent.children.indexOf(object)
      if (index < 0) return
      const selection = path === key || path.startsWith(key + '.') ? parent : objectAt(getProject(), path)
      parent.children.splice(index, 1)
      renderTree(true, selection)
      renderSelected()
      onChange()
    }

    if (object.children.length === 0) {
      remove()
      return
    }

    const count = countDescendants(object)
    const label = count === 1 ? 'nested object' : 'nested objects'
    $('#remove-object-warning').textContent = '“' + ownLabel(object) + '” and ' + count + ' ' + label + ' will be removed from this project.'
    pendingRemoval = remove
    removeDialog.returnValue = 'cancel'
    removeDialog.showModal()
  }

  function renderTree(focus = false, selection = objectAt(getProject(), path)) {
    closeRowPopover()
    const rootObject = getProject().root
    const limitReached = countDescendants(rootObject) + 1 >= MAX_OBJECTS

    function branch(object, key, depth, parent, parentReference = false, parentHidden = false, parentAdditive = true) {
      const detail = ROOT_TYPES[object.type] ?? CHILD_TYPES[object.type]
      const label = ownLabel(object)
      const reference = parentReference || object.properties.reference === true
      const hidden = parentHidden || hiddenObjects.has(object)
      const additive = parentAdditive && addsGeometry(object)
      const row = element('div', 'tree-row')
      row.classList.toggle('is-hidden', hidden)
      const choose = button('', detail.icon, 'tree-object', () => {
        renderTree(true, object)
        renderSelected()
        applyEvaluation(lastEvaluation)
      })
      choose.append(element('span', 'tree-name', label))
      choose.title = label
      if (reference || object.type === 'repeater') {
        const operation = reference ? 'reference' : object.properties.operation
        const marker = element('span', 'tree-operation', reference ? 'Reference' : REPEATER_OPERATIONS[operation].treeLabel)
        marker.dataset.operation = operation
        choose.append(marker)
        choose.title += ' · ' + (reference ? 'Reference only' : REPEATER_OPERATIONS[operation].label)
      }
      choose.dataset.object = key
      row.style.setProperty('--depth', depth)
      if (object === selection) {
        path = key
        inheritsReference = parentReference
        choose.setAttribute('aria-current', 'true')
      }

      const eye = button('', hidden ? 'eyeOff' : 'eye', 'icon-button tree-action tree-visibility', () => {
        if (hiddenObjects.has(object)) hiddenObjects.delete(object)
        else hiddenObjects.add(object)
        renderTree()
        applyEvaluation(lastEvaluation)
        tree.querySelector('[data-visibility="' + key + '"]').focus({ preventScroll: true })
        onVisibilityChange()
      })
      const eyeLabel = parentHidden ? label + ' is hidden by its parent' : (hidden ? 'Show ' : 'Hide ') + label + ' in preview'
      eye.dataset.visibility = key
      eye.disabled = parentHidden
      eye.setAttribute('aria-label', eyeLabel)
      eye.title = eyeLabel
      const actions = element('div', 'tree-actions')
      const add = button('', 'plus', 'icon-button tree-action', (event) =>
        openRowPopover(childPicker, event.currentTarget, { object, key }))
      add.setAttribute('aria-label', 'Add child to ' + label)
      add.setAttribute('aria-controls', childPicker.id)
      add.setAttribute('aria-haspopup', 'dialog')
      add.setAttribute('aria-expanded', 'false')
      add.disabled = limitReached || depth >= MAX_DEPTH
      add.title = add.disabled ? 'Object or nesting limit reached' : 'Add child object'
      actions.append(add)
      if (parent) {
        const more = button('', 'more', 'icon-button tree-action', (event) => {
          exportAction.hidden = !additive
          $('#object-actions-title').textContent = label
          openRowPopover(objectActions, event.currentTarget, { object, key, parent })
        })
        more.setAttribute('aria-label', 'More actions for ' + label)
        more.setAttribute('aria-controls', objectActions.id)
        more.setAttribute('aria-haspopup', 'dialog')
        more.setAttribute('aria-expanded', 'false')
        more.title = 'More actions'
        actions.append(more)
      }
      row.append(choose, eye, actions)

      const item = element('li')
      item.append(row)
      if (object.children.length) {
        const children = element('ul')
        object.children.forEach((child, index) => {
          children.append(branch(child, key + '.children.' + index, depth + 1, object, reference, hidden, additive))
        })
        item.append(children)
      }
      return item
    }
    const root = element('ul')
    root.append(branch(rootObject, 'root', 0))
    tree.replaceChildren(root)
    addIcons(tree)
    if (focus) tree.querySelector('[aria-current="true"]').focus()
    onSelect(selection)
  }

  function renderVariables() {
    const { variables } = getProject()
    addVariable.disabled = variables.length >= MAX_VARIABLES
    list.replaceChildren(...variables.map((entry, index) => {
      const key = 'variables.' + index
      const row = element('div', 'variable-row')
      const remove = button('', 'trash', 'icon-button', () => {
        variables.splice(index, 1)
        renderVariables()
        addVariable.focus()
        onChange()
      })
      remove.setAttribute('aria-label', 'Remove variable ' + entry.name)
      remove.title = 'Remove variable'
      row.append(textField(key + '.name', 'Name', entry.name), textField(key + '.value', 'Value or formula', entry.value, {}), remove)
      return row
    }))
    addIcons(list)
  }

  function featureCard(feature, index, enclosureType) {
    const key = path + '.features.' + index
    const { properties, parameters } = feature
    const atSeam = properties.placement === 'seam'
    const title = properties.side + ' wall cutout'
    const summary = properties.shape + (atSeam ? ' · Seam' : '')
    const { details, content } = disclosure(title, key, { summary })
    details.classList.add('feature-card')
    const options = element('div', 'fields feature-options')
    options.append(
      selectField(key + '.properties.side', 'Wall', SIDES.map((side) => [side, side]), properties.side),
      selectField(key + '.properties.shape', 'Shape', SHAPES.map((shape) => [shape, shape]), properties.shape),
    )
    content.append(options)
    if (enclosureType === 'split') {
      const placement = element('div', 'feature-options')
      placement.append(selectField(key + '.properties.placement', 'Placement',
        Object.entries(CUTOUT_PLACEMENTS), properties.placement ?? 'height'))
      content.append(placement)
    }
    content.append(fields(featureFields(feature), parameters, key + '.parameters'))
    if (atSeam) content.append(element('p', 'field-hint', 'Follows the lower half height and opens the lip at this cutout.'))
    const actions = element('div', 'feature-actions')
    const remove = button('Remove feature', 'trash', 'button button-quiet button-small', () => {
      objectAt(getProject(), path).features.splice(index, 1)
      renderSelected()
      $('#object-inspector .add-row button')?.focus()
      onChange()
    })
    remove.setAttribute('aria-label', 'Remove ' + title.toLowerCase() + ' ' + (index + 1))
    const exportFit = button('Export fit sample', 'download', 'button button-quiet button-small', () => onExportSample(key))
    exportFit.setAttribute('aria-label', 'Export fit sample for ' + title.toLowerCase() + ' ' + (index + 1))
    actions.append(remove, exportFit)
    content.append(actions)
    return details
  }

  function renderSelected() {
    const project = getProject()
    const object = objectAt(project, path)
    const isRoot = path === 'root'
    const depth = path.split('.children.').length - 1
    const type = ROOT_TYPES[object.type] ?? CHILD_TYPES[object.type]
    const heading = element('div', 'inspector-heading')
    heading.append(element('h3', '', type.label))
    selected.replaceChildren(heading)

    if (object.type === 'lidded') {
      const property = object.properties.includeLid ? 'Lid included' : 'Base only'
      heading.append(element('p', 'object-property', property))
    }
    if (!isRoot) {
      heading.append(textField(path + '.name', 'Object name', object.name))
    }
    if (type.supportsReference) {
      const properties = disclosure('Properties', path + '.properties', { open: true })
      const reference = element('input')
      reference.type = 'checkbox'
      reference.checked = inheritsReference || object.properties.reference === true
      reference.disabled = inheritsReference
      const label = element('label', 'reference-option')
      label.append(reference, 'Reference only')
      const options = Object.entries(REPEATER_OPERATIONS).map(([key, spec]) => [key, spec.label])
      const operation = element('div')
      operation.hidden = reference.checked
      operation.append(
        selectField(path + '.properties.operation', 'Operation', options, object.properties.operation),
        element('p', 'field-hint', 'The operation applies to the parent. Cuts remove material wherever the geometry overlaps it.'),
      )
      const hint = element('p', 'field-hint', inheritsReference
        ? 'Inherited from the parent.'
        : 'This branch can float or overlap the case. It stays out of the STL.')
      hint.hidden = !reference.checked
      properties.content.append(label, hint, operation)
      selected.append(properties.details)
      reference.addEventListener('change', () => {
        object.properties.reference = reference.checked
        operation.hidden = reference.checked
        hint.hidden = !reference.checked
        renderTree()
        onChange()
      })
    } else if (inheritsReference) {
      heading.append(element('p', 'object-property', 'Reference inherited from the parent.'))
    }

    const parameterPanel = disclosure('Parameters', path + '.parameters', { glyph: 'sliders', open: true })
    const formulaHint = element('p', 'field-hint leading-hint', 'Formulas can use names defined in ')
    formulaHint.append(element('strong', '', 'Variables'), '.')
    parameterPanel.content.append(formulaHint)
    if (object.type === 'pcb-corner-mount') {
      const options = Object.entries(PCB_MOUNT_FASTENINGS).map(([key, { label }]) => [key, label])
      parameterPanel.content.append(selectField(path + '.properties.fastening', 'Fastening', options, object.properties.fastening))
    }
    if (object.type === 'cable-duct') {
      const fits = Object.entries(CABLE_DUCT_FITS).map(([key, { label }]) => [key, label])
      const center = element('p', 'field-hint')
      center.dataset.ductCenter = ''
      center.hidden = true
      parameterPanel.content.append(selectField(path + '.properties.fit', 'Push-in fit', fits, object.properties.fit), center)
    }
    if (object.type === 'repeater') {
      const primitive = object.parameters.primitive
      const primitiveBox = element('div', 'primitive-box')
      primitiveBox.append(
        selectField(path + '.parameters.primitive.type', 'Primitive', Object.entries(PRIMITIVES).map(([key, spec]) => [key, spec.label]), primitive.type),
        fields(PRIMITIVES[primitive.type].fields, primitive.parameters, path + '.parameters.primitive.parameters'),
      )
      const { count, ...transforms } = parameterFields(object)
      const repeatSettings = fields(transforms, object.parameters, path + '.parameters')
      repeatSettings.dataset.repeatSettings = ''
      repeatSettings.hidden = object.parameters.count === 1
      parameterPanel.content.append(primitiveBox, fields({ count }, object.parameters, path + '.parameters'), repeatSettings)
    } else {
      const schema = Object.fromEntries(Object.entries(parameterFields(object)).filter(([key]) => !isRoot || !Object.hasOwn(SCREW_FIELDS, key)))
      parameterPanel.content.append(fields(schema, object.parameters, path + '.parameters'))
    }
    if (object.type === 'pcb-corner-mount') {
      const hint = object.properties.fastening === 'screw'
        ? 'Measure insets from the PCB edges to the hole centers. Base height sets the board’s underside.'
        : 'Corner seat clearance sets the size of the square notch for pins. Tuck one edge under two catches, then press the opposite edge down.'
      parameterPanel.content.append(element('p', 'field-hint', hint))
    }
    selected.append(parameterPanel.details)
    if (object.type === 'screw-fastened') {
      const screws = disclosure('Screw closure', path + '.screws', { glyph: 'bolt', open: true })
      screws.content.append(fields(SCREW_FIELDS, object.parameters, path + '.parameters'),
        element('p', 'field-hint', 'Two diagonal collars align the lid. Set counterbore depth to 0 for plain lid holes.'))
      selected.append(screws.details)
    }

    if (!isRoot) {
      const placement = disclosure('Placement', path + '.placement', { glyph: 'fit', open: true })
      if (depth === 1) {
        const { hasUpper, baseLabel, upperLabel } = enclosureLayout(project.root)
        const options = [['base', baseLabel + ' inside floor']]
        if (hasUpper) options.push(['upper', upperLabel + ' inside ceiling'])
        placement.content.append(selectField(path + '.placement.part', 'Mounting surface', options, object.placement.part))
      }
      const hint = depth === 1
        ? 'X and Y start at the surface center. Z points into the case, along the print orientation of that part.'
        : 'Offsets and rotation are relative to the parent object’s origin.'
      placement.content.append(fields(PLACEMENT_FIELDS, object.placement, path + '.placement'), element('p', 'field-hint', hint))
      selected.append(placement.details)
    }

    if (isRoot) {
      const featurePanel = disclosure('Features', path + '.features', { glyph: 'scissors', summary: String(object.features.length) })
      if (object.features.some(({ type }) => type === 'cutout')) {
        featurePanel.content.append(element('p', 'field-hint leading-hint', 'Wall offsets start at the midpoint. Positive follows X on front and back, or Y on left and right.'))
      }
      object.features.forEach((feature, index) => featurePanel.content.append(featureCard(feature, index, object.type)))
      const choices = Object.entries(FEATURES).map(([type, spec]) => [type, spec.label])
      featurePanel.content.append(picker('Add feature', choices, (type) => {
        const root = getEvaluatedRoot() ?? newProject(object.type, object.properties.includeLid).root
        const index = object.features.push(makeFeature(type, root)) - 1
        openSections.set(path + '.features', true)
        openSections.set(path + '.features.' + index, true)
        renderSelected()
        selected.querySelector('[data-section="' + path + '.features.' + index + '"] summary').focus()
        onChange()
      }, object.features.length >= MAX_FEATURES))
      selected.append(featurePanel.details)
    }

    addIcons(selected)
  }

  function handleInput(event) {
    const control = event.target
    const key = control.dataset.field
    if (!key) return
    const split = key.lastIndexOf('.')
    const parent = objectAt(getProject(), key.slice(0, split))
    const fieldName = key.slice(split + 1)
    const value = control.value
    const numeric = control.hasAttribute('data-formula') ? parseNumberLiteral(value) : undefined
    if (key.endsWith('.primitive.type')) {
      objectAt(getProject(), path).parameters.primitive = makePrimitive(value)
    } else {
      parent[fieldName] = numeric ?? value
    }
    if (key.endsWith('.properties.shape') && value === 'Rectangle') {
      const card = key.slice(0, key.lastIndexOf('.properties.'))
      const feature = objectAt(getProject(), card)
      feature.parameters.height ??= FEATURES.cutout.fields.height.value
    }
    if (key.endsWith('.properties.placement') && value === 'height') {
      const card = key.slice(0, key.lastIndexOf('.properties.'))
      const project = getProject()
      objectAt(project, card).parameters.z ??= project.root.parameters.seam
    }
    if (key === path + '.properties.fastening') {
      const { parameters } = objectAt(getProject(), path)
      for (const [field, spec] of Object.entries(PCB_MOUNT_FASTENINGS[value].fields)) parameters[field] ??= spec.value
    }
    if (control.tagName === 'SELECT') {
      renderSelected()
      selected.querySelector('[data-field="' + key + '"]')?.focus()
    }
    if (key === path + '.name' || key === path + '.properties.operation') renderTree()
    if (key.startsWith('variables.') && fieldName === 'name') {
      control.closest('.variable-row').querySelector('button').setAttribute('aria-label', 'Remove variable ' + value)
    }
    onChange()
  }

  let lastEvaluation
  function applyEvaluation(evaluation) {
    if (!evaluation) return
    lastEvaluation = evaluation
    const errors = new Map(evaluation.issues.map((issue) => [issue.field, issue]))
    for (const input of document.querySelectorAll('#object-inspector [data-field], #variable-list [data-field]')) {
      const key = input.dataset.field
      input.setAttribute('aria-invalid', String(errors.has(key)))
      if (errors.has(key)) input.title = errors.get(key).message
      else input.removeAttribute('title')
      const output = input.closest('.field').querySelector('.resolved-value')
      if (!output) continue
      const resolved = evaluation.values.get(key)
      const stored = objectAt(getProject(), key)
      output.hidden = resolved === undefined || typeof stored !== 'string'
      output.textContent = output.hidden ? '' : '= ' + formatter.format(resolved)
    }
    const repeatSettings = selected.querySelector('[data-repeat-settings]')
    if (repeatSettings) {
      const count = evaluation.values.get(path + '.parameters.count')
      repeatSettings.hidden = count === 1 && !repeatSettings.querySelector('[aria-invalid="true"]')
    }
    for (const row of tree.querySelectorAll('[data-object]')) {
      const prefix = row.dataset.object
      row.classList.toggle('has-issue', evaluation.issues.some(({ field }) => field.startsWith(prefix + '.')))
    }
    for (const details of selected.querySelectorAll('[data-section]')) {
      const key = details.dataset.section
      details.classList.toggle('has-issue', errors.has(key) || evaluation.issues.some(({ field }) => field.startsWith(key + '.')))
    }
    const readout = selected.querySelector('[data-duct-center]')
    if (readout) {
      const { root, values } = evaluation
      let center = values.get(path + '.parameters.baseHeight') + values.get(path + '.parameters.cableDiameter') / 2
      let mount = path
      while (mount !== 'root') {
        center += values.get(mount + '.placement.z')
        const parent = mount.slice(0, mount.lastIndexOf('.children.'))
        if (parent === 'root') {
          const { type, placement: { part } } = objectAt(getProject(), mount)
          if (type === 'repeater') center -= BOOLEAN_OVERLAP
          center = part === 'base' ? values.get('root.parameters.floor') + center
            : root ? enclosureLayout(root).height - root.parameters.thickness - center : NaN
        }
        mount = parent
      }
      readout.hidden = !Number.isFinite(center)
      readout.textContent = readout.hidden ? '' : 'Cable center sits ' + formatter.format(center) + ' mm above the enclosure bottom.'
    }
    selected.querySelector('[data-section="root.screws"]')?.classList.toggle('has-issue',
      evaluation.issues.some(({ field }) => isScrewParameter(field)))
    const variableError = evaluation.issues.some(({ field }) => field.startsWith('variables.'))
    variablesToggle.classList.toggle('has-issue', variableError)
    if (variableError) variablesToggle.setAttribute('aria-description', 'Some variables need attention.')
    else variablesToggle.removeAttribute('aria-description')
  }

  selected.addEventListener('input', handleInput)
  for (const popover of [childPicker, objectActions]) {
    popover.addEventListener('beforetoggle', (event) => {
      if (event.newState === 'closed' && rowTarget?.popover === popover) {
        rowTarget.trigger.setAttribute('aria-expanded', 'false')
        rowTarget = undefined
      }
    })
  }
  childPicker.addEventListener('click', (event) => {
    const choice = event.target.closest('[data-child-type]')
    if (!choice || rowTarget?.popover !== childPicker) return
    const { object, key } = rowTarget
    const type = choice.dataset.childType
    const direct = key === 'root'
    const root = type === 'cable-duct' && direct ? getEvaluatedRoot() : undefined
    const child = makeChild(type, direct, root)
    object.children.push(child)
    renderTree(true, child)
    renderSelected()
    onChange()
  })
  objectActions.addEventListener('click', (event) => {
    const action = event.target.closest('[data-object-action]')?.dataset.objectAction
    if (!action || rowTarget?.popover !== objectActions) return
    const { object, key, parent } = rowTarget
    closeRowPopover()
    if (action === 'export') onExportSample(key)
    else requestRemoval(object, key, parent)
  })
  window.addEventListener('scroll', positionRowPopover, { passive: true })
  window.addEventListener('resize', positionRowPopover)
  removeDialog.addEventListener('close', () => {
    const remove = pendingRemoval
    pendingRemoval = undefined
    if (removeDialog.returnValue === 'remove') remove?.()
  })
  list.addEventListener('input', handleInput)
  addVariable.addEventListener('click', () => {
    const { variables } = getProject()
    let number = variables.length + 1
    while (variables.some(({ name }) => name === 'var' + number)) number++
    variables.push({ name: 'var' + number, value: 10 })
    renderVariables()
    const name = list.lastElementChild.querySelector('input')
    name.focus()
    name.select()
    onChange()
  })

  return {
    reset() {
      path = 'root'
      hiddenObjects = new WeakSet()
      openSections.clear()
      lastEvaluation = undefined
      pendingRemoval = undefined
      if (removeDialog.open) removeDialog.close()
      if (variablesPanel.matches(':popover-open')) variablesPanel.hidePopover()
      renderTree()
      renderVariables()
      renderSelected()
    },
    applyEvaluation,
    isHidden: (object) => hiddenObjects.has(object),
  }
}

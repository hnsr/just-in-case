import {
  ROOT_TYPES, CHILD_TYPES, FEATURES, PRIMITIVES, REPEATER_OPERATIONS, PLACEMENT_FIELDS, SIDES, SHAPES,
  SCREW_LAYOUTS, SCREW_POSITION_FIELDS, enclosureLayout, featureFields, makePrimitive, parameterFields,
  screwPositions, supportsScrewClosure,
} from './definitions.js'
import { MAX_DEPTH, MAX_FEATURES, MAX_OBJECTS, MAX_SCREWS, MAX_VARIABLES, makeChild, makeFeature, newProject, objectAt } from './project.js'
import { addIcons } from './icons.js'

const $ = (selector) => document.querySelector(selector)
const formatter = new Intl.NumberFormat('en', { maximumFractionDigits: 4, useGrouping: false })
const NUMBER_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

function parseNumberLiteral(text) {
  if (!NUMBER_LITERAL.test(text.trim())) return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

function adjustDimension(event, { min, max }) {
  const input = event.currentTarget
  if (input.ownerDocument.activeElement !== input || event.ctrlKey || event.metaKey || !event.cancelable) return
  const delta = event.deltaY || (event.shiftKey ? event.deltaX : 0)
  if (!delta) return

  const current = parseNumberLiteral(input.value)
  if (current === undefined) return
  event.preventDefault()

  const step = event.shiftKey ? 0.1 : 1
  const adjusted = current - Math.sign(delta) * step
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

function textField(path, label, value, formula = false, unit) {
  const input = element('input')
  input.type = 'text'
  input.value = typeof value === 'number' || typeof value === 'string' ? value : ''
  input.maxLength = formula ? 160 : path.startsWith('variables.') ? 40 : 80
  input.spellcheck = false
  input.autocomplete = 'off'
  input.dataset.field = path
  if (formula) input.dataset.formula = ''
  const suffix = unit ? element('span', '', unit) : null
  const result = field(label, input, formula ? 'number-input' : 'text-input', suffix)
  if (formula) {
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
    const field = textField(path + '.' + key, spec.label, values[key], true, spec.unit)
    if (spec.unit) {
      field.querySelector('input').addEventListener('wheel', (event) => adjustDimension(event, spec), { passive: false })
    }
    grid.append(field)
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

export function createInspector(getProject, getEvaluatedRoot, onChange, onSelect) {
  const tree = $('#object-tree')
  const selected = $('#object-inspector')
  const childPicker = $('#child-picker')
  const removeDialog = $('#remove-object-dialog')
  const variablesPanel = $('#variables-panel')
  const variablesToggle = $('#variables-toggle')
  const list = $('#variable-list')
  const addVariable = $('#add-variable')
  const openSections = new Map()
  let path = 'root'
  let childTarget
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

  function positionChildPicker() {
    if (!childTarget || !childPicker.matches(':popover-open')) return
    const { top, bottom, right } = childTarget.trigger.getBoundingClientRect()
    const { clientWidth, clientHeight } = document.documentElement
    if (top >= clientHeight || bottom <= 0) {
      childPicker.hidePopover()
      return
    }
    const gap = 8
    const maxTop = clientHeight - childPicker.offsetHeight - gap
    const above = top - childPicker.offsetHeight - gap
    const left = Math.min(right, clientWidth - gap) - childPicker.offsetWidth
    childPicker.style.left = Math.max(gap, left) + 'px'
    childPicker.style.top = Math.max(gap, bottom + gap <= maxTop ? bottom + gap : above >= gap ? above : maxTop) + 'px'
  }

  function openChildPicker(object, key, trigger) {
    const sameTrigger = childTarget?.trigger === trigger
    if (childPicker.matches(':popover-open')) childPicker.hidePopover()
    if (sameTrigger) return
    childTarget = { object, key, trigger }
    trigger.setAttribute('aria-expanded', 'true')
    trigger.focus({ preventScroll: true })
    childPicker.showPopover({ source: trigger })
    positionChildPicker()
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
    if (childPicker.matches(':popover-open')) childPicker.hidePopover()
    const rootObject = getProject().root
    const limitReached = countDescendants(rootObject) + 1 >= MAX_OBJECTS

    function branch(object, key, depth, parent) {
      const detail = ROOT_TYPES[object.type] ?? CHILD_TYPES[object.type]
      const label = ownLabel(object)
      const row = element('div', 'tree-row')
      const choose = button('', detail.icon, 'tree-object', () => {
        renderTree(true, object)
        renderSelected()
        applyEvaluation(lastEvaluation)
      })
      choose.append(element('span', 'tree-name', label))
      choose.title = label
      if (object.type === 'repeater') {
        const operation = REPEATER_OPERATIONS[object.properties.operation]
        const marker = element('span', 'tree-operation', operation.treeLabel)
        marker.dataset.operation = object.properties.operation
        choose.append(marker)
        choose.title += ' · ' + operation.label
      }
      choose.dataset.object = key
      row.style.setProperty('--depth', depth)
      if (object === selection) {
        path = key
        choose.setAttribute('aria-current', 'true')
      }

      const actions = element('div', 'tree-actions')
      const add = button('', 'plus', 'icon-button tree-action', (event) => openChildPicker(object, key, event.currentTarget))
      add.setAttribute('aria-label', 'Add child to ' + label)
      add.setAttribute('aria-controls', childPicker.id)
      add.setAttribute('aria-haspopup', 'dialog')
      add.setAttribute('aria-expanded', 'false')
      add.disabled = limitReached || depth >= MAX_DEPTH
      add.title = add.disabled ? 'Object or nesting limit reached' : 'Add child object'
      actions.append(add)
      if (parent) {
        const remove = button('', 'trash', 'icon-button tree-action tree-remove', () => requestRemoval(object, key, parent))
        remove.setAttribute('aria-label', 'Remove ' + label)
        remove.title = 'Remove object'
        actions.append(remove)
      }
      row.append(choose, actions)

      const item = element('li')
      item.append(row)
      if (object.children.length) {
        const children = element('ul')
        object.children.forEach((child, index) => {
          children.append(branch(child, key + '.children.' + index, depth + 1, object))
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
      row.append(textField(key + '.name', 'Name', entry.name), textField(key + '.value', 'Value or formula', entry.value, true), remove)
      return row
    }))
    addIcons(list)
  }

  function nextScrewPosition(positions) {
    const root = getEvaluatedRoot() ?? newProject().root
    const resolved = root.features.find(({ type }) => type === 'screw-closure')?.parameters
    const diameter = resolved?.counterboreDepth > 0 ? Math.max(resolved.diameter, resolved.counterboreDiameter) : resolved?.diameter
    const spacing = (diameter ?? FEATURES['screw-closure'].fields.diameter.value) + 0.5
    const offsets = (length) => [0, -length / 4, length / 4, -length / 8, length / 8]
    const candidates = offsets(root.parameters.width).flatMap((x) => offsets(root.parameters.depth).map((y) => ({ x, y })))
    const used = resolved?.positions?.length === positions.length ? resolved.positions : positions
    return candidates.find(({ x, y }) => used.every((point) => Math.hypot(point.x - x, point.y - y) >= spacing)) ?? candidates[0]
  }

  function customScrewFields(feature, key) {
    const list = element('div', 'screw-positions')
    const positions = feature.parameters.positions
    const prefix = key + '.parameters.positions.'
    list.append(element('p', 'field-hint', 'Measure X and Y from the enclosure center in the assembled view.'))

    positions.forEach((position, index) => {
      const row = element('div', 'screw-position')
      const label = 'Screw ' + (index + 1)
      row.setAttribute('role', 'group')
      row.setAttribute('aria-label', label)
      const remove = button('', 'trash', 'icon-button', () => {
        positions.splice(index, 1)
        renderSelected()
        selected.querySelector('[data-field="' + prefix + Math.min(index, positions.length - 1) + '.x"]').focus()
        onChange()
      })
      remove.setAttribute('aria-label', 'Remove ' + label.toLowerCase())
      remove.title = positions.length === 1 ? 'Keep at least one screw position' : 'Remove screw position'
      remove.disabled = positions.length === 1
      const dimensions = { ...SCREW_POSITION_FIELDS, x: { ...SCREW_POSITION_FIELDS.x, label: label + ' X' } }
      row.append(fields(dimensions, position, prefix + index), remove)
      list.append(row)
    })
    const add = button('Add screw position', 'plus', 'button button-small', () => {
      const index = positions.push(nextScrewPosition(positions)) - 1
      renderSelected()
      selected.querySelector('[data-field="' + prefix + index + '.x"]').focus()
      onChange()
    })
    add.disabled = positions.length >= MAX_SCREWS
    list.append(add)
    return list
  }

  function featureCard(feature, index) {
    const key = path + '.features.' + index
    const { type, properties, parameters } = feature
    const cutout = type === 'cutout'
    const title = cutout ? properties.side + ' wall cutout' : FEATURES[type].label
    const { details, content } = disclosure(title, key, { summary: cutout ? properties.shape : undefined })
    details.classList.add('feature-card')
    if (cutout) {
      const options = element('div', 'fields feature-options')
      options.append(
        selectField(key + '.properties.side', 'Wall', SIDES.map((side) => [side, side]), properties.side),
        selectField(key + '.properties.shape', 'Shape', SHAPES.map((shape) => [shape, shape]), properties.shape),
      )
      content.append(options)
    } else if (type === 'screw-closure') {
      const options = element('div', 'feature-options')
      options.append(selectField(key + '.properties.layout', 'Screw layout', Object.entries(SCREW_LAYOUTS), properties.layout))
      content.append(options)
    }
    content.append(fields(featureFields(feature), parameters, key + '.parameters'))
    if (type === 'screw-closure') {
      content.append(element('p', 'field-hint', 'The base bosses reach the lid. Set counterbore depth to 0 for plain lid holes.'))
      if (properties.layout === 'custom') content.append(customScrewFields(feature, key))
    }
    const remove = button('Remove feature', 'trash', 'button button-quiet button-small remove-feature', () => {
      objectAt(getProject(), path).features.splice(index, 1)
      renderSelected()
      $('#object-inspector .add-row button')?.focus()
      onChange()
    })
    remove.setAttribute('aria-label', 'Remove ' + title.toLowerCase() + ' ' + (index + 1))
    content.append(remove)
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
    if (object.type === 'repeater') {
      const options = Object.entries(REPEATER_OPERATIONS).map(([key, spec]) => [key, spec.label])
      heading.append(
        selectField(path + '.properties.operation', 'Operation', options, object.properties.operation),
        element('p', 'field-hint', 'The operation applies to the parent. Cuts remove material where the pattern overlaps it.'),
      )
    }

    const parameterPanel = disclosure('Parameters', path + '.parameters', { glyph: 'sliders', open: true })
    const formulaHint = element('p', 'field-hint leading-hint', 'Formulas can use names defined in ')
    formulaHint.append(element('strong', '', 'Variables'), '.')
    parameterPanel.content.append(formulaHint)
    if (object.type === 'repeater') {
      const primitive = object.parameters.primitive
      const primitiveBox = element('div', 'primitive-box')
      primitiveBox.append(
        selectField(path + '.parameters.primitive.type', 'Primitive', Object.entries(PRIMITIVES).map(([key, spec]) => [key, spec.label]), primitive.type),
        fields(PRIMITIVES[primitive.type].fields, primitive.parameters, path + '.parameters.primitive.parameters'),
      )
      parameterPanel.content.append(primitiveBox)
    }
    parameterPanel.content.append(fields(parameterFields(object), object.parameters, path + '.parameters'))
    if (object.type === 'pcb-mount') {
      parameterPanel.content.append(element('p', 'field-hint', 'Four clips support the board and grip two opposite edges.'))
    }
    if (object.type === 'pcb-screw-mount') {
      parameterPanel.content.append(element('p', 'field-hint', 'Hole spacing is measured center to center. Placement moves and rotates all four posts together.'))
    }
    selected.append(parameterPanel.details)

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
      object.features.forEach((feature, index) => featurePanel.content.append(featureCard(feature, index)))
      const choices = Object.entries(FEATURES)
        .filter(([type]) => type !== 'screw-closure' || (supportsScrewClosure(object) && !object.features.some((feature) => feature.type === type)))
        .map(([type, spec]) => [type, spec.label])
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
    if (key.endsWith('.properties.layout')) {
      const feature = objectAt(getProject(), key.slice(0, key.lastIndexOf('.properties.')))
      const defaults = FEATURES['screw-closure'].fields
      feature.parameters.insetX ??= defaults.insetX.value
      feature.parameters.insetY ??= defaults.insetY.value
      if (value === 'custom' && !feature.parameters.positions) {
        const root = getEvaluatedRoot() ?? newProject().root
        const resolved = root.features.find(({ type }) => type === 'screw-closure')
        const corners = resolved ?? makeFeature('screw-closure', root)
        feature.parameters.positions = screwPositions(root.parameters, corners)
      }
    }
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
    const errors = new Map(evaluation.issues.map((issue) => [issue.field, issue.message]))
    for (const input of document.querySelectorAll('#object-inspector [data-field], #variable-list [data-field]')) {
      const key = input.dataset.field
      input.setAttribute('aria-invalid', String(errors.has(key)))
      if (errors.has(key)) input.title = errors.get(key)
      else input.removeAttribute('title')
      const output = input.closest('.field').querySelector('.resolved-value')
      if (!output) continue
      const resolved = evaluation.values.get(key)
      const stored = objectAt(getProject(), key)
      output.hidden = resolved === undefined || typeof stored !== 'string'
      output.textContent = output.hidden ? '' : '= ' + formatter.format(resolved)
    }
    for (const row of tree.querySelectorAll('[data-object]')) {
      const prefix = row.dataset.object
      row.classList.toggle('has-issue', evaluation.issues.some(({ field }) => field.startsWith(prefix + '.')))
    }
    for (const details of selected.querySelectorAll('[data-section]')) {
      const key = details.dataset.section
      details.classList.toggle('has-issue', evaluation.issues.some(({ field }) => field.startsWith(key + '.')))
    }
    const variableError = evaluation.issues.some(({ field }) => field.startsWith('variables.'))
    variablesToggle.classList.toggle('has-issue', variableError)
    if (variableError) variablesToggle.setAttribute('aria-description', 'Some variables need attention.')
    else variablesToggle.removeAttribute('aria-description')
  }

  selected.addEventListener('input', handleInput)
  childPicker.addEventListener('beforetoggle', (event) => {
    if (event.newState === 'closed') {
      childTarget?.trigger.setAttribute('aria-expanded', 'false')
      childTarget = undefined
    }
  })
  childPicker.addEventListener('click', (event) => {
    const choice = event.target.closest('[data-child-type]')
    if (!choice || !childTarget) return
    const { object, key } = childTarget
    const child = makeChild(choice.dataset.childType, key === 'root')
    object.children.push(child)
    renderTree(true, child)
    renderSelected()
    onChange()
  })
  window.addEventListener('scroll', positionChildPicker, { passive: true })
  window.addEventListener('resize', positionChildPicker)
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
  }
}

import {
  ROOT_TYPES, CHILD_TYPES, FEATURES, PRIMITIVES, PLACEMENT_FIELDS, SIDES, SHAPES,
  enclosureLayout, featureFields, makePrimitive, parameterFields,
} from './definitions.js'
import { MAX_DEPTH, MAX_FEATURES, MAX_OBJECTS, MAX_VARIABLES, makeChild, makeFeature, newProject, objectAt } from './project.js'
import { addIcons } from './icons.js'

const $ = (selector) => document.querySelector(selector)
const formatter = new Intl.NumberFormat('en', { maximumFractionDigits: 4, useGrouping: false })

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
  for (const [key, { label, unit }] of Object.entries(schema)) {
    grid.append(textField(path + '.' + key, label, values[key], true, unit))
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

export function createInspector(getProject, getEvaluatedRoot, onChange) {
  const tree = $('#object-tree')
  const selected = $('#object-inspector')
  const list = $('#variable-list')
  const addVariable = $('#add-variable')
  const openSections = new Map()
  let path = 'root'

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

  function renderTree(focus = false) {
    function branch(object, key, depth) {
      const detail = ROOT_TYPES[object.type] ?? CHILD_TYPES[object.type]
      const row = button('', detail.icon, 'tree-row', () => {
        path = key
        renderTree(true)
        renderSelected()
        applyEvaluation(lastEvaluation)
      })
      row.append(element('span', 'tree-name', ownLabel(object)))
      row.dataset.object = key
      row.style.setProperty('--depth', depth)
      if (key === path) row.setAttribute('aria-current', 'true')
      const item = element('li')
      item.append(row)
      if (object.children.length) {
        const children = element('ul')
        object.children.forEach((child, index) => {
          children.append(branch(child, key + '.children.' + index, depth + 1))
        })
        item.append(children)
      }
      return item
    }
    const root = element('ul')
    root.append(branch(getProject().root, 'root', 0))
    tree.replaceChildren(root)
    addIcons(tree)
    if (focus) tree.querySelector('[aria-current="true"]').focus()
  }

  function renderVariables() {
    const { variables } = getProject()
    $('#variables-count').textContent = variables.length
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
    }
    content.append(fields(featureFields(feature), parameters, key + '.parameters'))
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

    if (object.type === 'lidded' || object.type === 'repeater') {
      const property = object.type === 'lidded'
        ? (object.properties.includeLid ? 'Lid included' : 'Base only')
        : (object.properties.operation === 'cut' ? 'Cuts material' : 'Adds material')
      heading.append(element('p', 'object-property', property))
    }
    if (!isRoot) {
      heading.append(textField(path + '.name', 'Object name', object.name))
    }

    const parameterPanel = disclosure('Parameters', path + '.parameters', { glyph: 'sliders', open: true })
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
      featurePanel.content.append(picker('Add feature', Object.entries(FEATURES).map(([key, spec]) => [key, spec.label]), (type) => {
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

    const childPanel = disclosure('Child objects', path + '.children', { glyph: 'layers', summary: String(object.children.length), open: true })
    childPanel.content.append(picker('Add object', [
      ['pcb-mount', CHILD_TYPES['pcb-mount'].label],
      ['add', 'Geometry repeater · add'],
      ['cut', 'Geometry repeater · cut'],
    ], (choice) => {
      const child = makeChild(choice === 'pcb-mount' ? choice : 'repeater', choice, isRoot)
      const index = object.children.push(child) - 1
      path += '.children.' + index
      renderTree(true)
      renderSelected()
      onChange()
    }, tree.querySelectorAll('[data-object]').length >= MAX_OBJECTS || depth >= MAX_DEPTH))
    selected.append(childPanel.details)

    if (!isRoot) {
      const remove = button('Remove object', 'trash', 'button button-quiet button-small', () => {
        const boundary = path.lastIndexOf('.children.')
        const index = Number(path.slice(boundary + '.children.'.length))
        path = path.slice(0, boundary)
        objectAt(project, path).children.splice(index, 1)
        renderTree(true)
        renderSelected()
        onChange()
      })
      const footer = element('div', 'inspector-footer')
      footer.append(remove)
      selected.append(footer)
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
    if (key.endsWith('.primitive.type')) {
      objectAt(getProject(), path).parameters.primitive = makePrimitive(value)
    } else if (control.hasAttribute('data-formula') && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) && Number.isFinite(Number(value))) {
      parent[fieldName] = Number(value)
    } else {
      parent[fieldName] = value
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
    if (key === path + '.name') tree.querySelector('[aria-current] .tree-name').textContent = ownLabel(objectAt(getProject(), path))
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
    for (const input of document.querySelectorAll('.parameters [data-field]')) {
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
    for (const details of document.querySelectorAll('.parameters details')) {
      const key = details.dataset.section ?? 'variables'
      details.classList.toggle('has-issue', evaluation.issues.some(({ field }) => field.startsWith(key + '.')))
    }
  }

  selected.addEventListener('input', handleInput)
  list.addEventListener('input', handleInput)
  addVariable.addEventListener('click', () => {
    const { variables } = getProject()
    let number = variables.length + 1
    while (variables.some(({ name }) => name === 'var' + number)) number++
    variables.push({ name: 'var' + number, value: 10 })
    renderVariables()
    list.lastElementChild.querySelector('input').select()
    onChange()
  })

  return {
    reset() {
      path = 'root'
      openSections.clear()
      lastEvaluation = undefined
      $('#variables-section').open = false
      renderTree()
      renderVariables()
      renderSelected()
    },
    applyEvaluation,
  }
}

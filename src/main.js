import '@fontsource-variable/dm-sans/wght.css'
import '@fontsource-variable/space-grotesk'
import './styles.css'
import wasmURL from 'manifold-3d/manifold.wasm?url'
import { initGeometry, buildEnclosure } from './geometry.js'
import { addIcons } from './icons.js'
import { createPreview } from './preview.js'
import {
  BODY_FIELDS, LID_FIELDS, MOUNT_FIELDS, MAX_CUTOUTS, SIDES, STORAGE_KEY,
  defaultProject, makeCutout, parseProject, projectJSON, validateProject,
} from './project.js'
import { enclosureSTL } from './stl.js'

const $ = (selector) => document.querySelector(selector)
const nameInput = $('#project-name')
const fileInput = $('#project-file')
const saveButton = $('#save-project')
const exportButton = $('#export-button')
const exportOptions = $('#export-options')
const cutoutList = $('#cutout-list')
const addCutoutButton = $('#add-cutout')
const mountToggle = $('#mounts-enabled')
const previewMessage = $('#preview-message')
const notices = $('#notice')
const toast = $('#toast')
const numberFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 3, useGrouping: false })

let geometry
let preview
let currentModel
let currentProject
let modelTimer
let toastTimer
let restoreError = false
let loadError

function restoreProject() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) return parseProject(saved)
  } catch {
    restoreError = true
  }
  return defaultProject()
}

let project = restoreProject()
if (restoreError) {
  showNotice('The saved project could not be loaded. The example is open.')
}

function showNotice(message) {
  notices.hidden = !message
  $('#notice-text').textContent = message
}

function status(message, state) {
  $('#save-status-text').textContent = message
  $('#save-status').dataset.state = state
}

function notify(message) {
  toast.innerHTML = '<span data-icon="check"></span><span></span>'
  toast.lastElementChild.textContent = message
  addIcons(toast)
  toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.hidden = true }, 3200)
}

function numberField(path, field, value) {
  const label = document.createElement('label')
  label.className = 'field'
  label.innerHTML = '<span class="field-label"></span><span class="number-input"><input type="number" step="any"><span aria-hidden="true">mm</span></span>'
  label.firstElementChild.textContent = field.label
  const input = label.querySelector('input')
  input.value = value
  input.dataset.field = path
  input.step = field.step ?? 0.1
  input.min = field.min
  input.max = field.max
  return label
}

function renderFields(group, schema) {
  const destination = $('#' + ({ body: 'body-fields', lid: 'lid-fields', mounts: 'mount-fields' }[group]))
  destination.replaceChildren(...Object.entries(schema).map(([key, field]) => numberField(group + '.' + key, field, project[group][key])))
}

function selectField(path, label, options, value) {
  const field = document.createElement('label')
  field.className = 'field'
  field.innerHTML = '<span class="field-label"></span><span class="select-input"><select></select><span aria-hidden="true" data-icon="chevron"></span></span>'
  field.firstElementChild.textContent = label
  const select = field.querySelector('select')
  select.dataset.field = path
  select.append(...options.map((option) => new Option(option, option)))
  select.value = value
  return field
}

function renderCutouts() {
  const cards = project.cutouts.map((cutout, index) => {
    const prefix = 'cutouts.' + index + '.'
    const card = document.createElement('div')
    const round = cutout.shape === 'Circle'
    card.className = 'cutout'
    card.innerHTML = '<div class="cutout-header"><h3></h3><button type="button" class="icon-button" data-icon="trash"></button></div><div class="fields"></div>'
    card.querySelector('h3').textContent = 'Cutout ' + (index + 1)
    const remove = card.querySelector('button')
    remove.setAttribute('aria-label', 'Remove cutout ' + (index + 1))
    remove.title = 'Remove cutout'
    remove.addEventListener('click', () => {
      project.cutouts.splice(index, 1)
      renderCutouts()
      const nextCard = cutoutList.children[Math.min(index, project.cutouts.length - 1)]
      const nextControl = nextCard?.querySelector('button') ?? addCutoutButton
      nextControl.focus()
      scheduleUpdate()
    })
    const fields = card.querySelector('.fields')
    fields.append(
      selectField(prefix + 'side', 'Wall', SIDES, cutout.side),
      selectField(prefix + 'shape', 'Shape', ['Rectangle', 'Circle'], cutout.shape),
      numberField(prefix + 'width', { label: round ? 'Diameter' : 'Width', min: 1, max: 400 }, cutout.width),
    )
    if (!round) fields.append(numberField(prefix + 'height', { label: 'Height', min: 1, max: 200 }, cutout.height))
    fields.append(
      numberField(prefix + 'offset', { label: 'Wall offset', min: -200, max: 200 }, cutout.offset),
      numberField(prefix + 'z', { label: 'Center from bed', min: 0, max: 200 }, cutout.z),
    )
    addIcons(card)
    return card
  })
  cutoutList.replaceChildren(...cards)
  addCutoutButton.disabled = project.cutouts.length >= MAX_CUTOUTS
}

function renderForm() {
  nameInput.value = project.name
  renderFields('body', BODY_FIELDS)
  renderFields('lid', LID_FIELDS)
  renderFields('mounts', MOUNT_FIELDS)
  renderCutouts()
  mountToggle.checked = project.mounts.enabled
  updateSummaries()
}

function updateSummaries() {
  const format = (value) => Number.isFinite(value) ? numberFormat.format(value) : '—'
  const { width, depth, height } = project.body
  $('#body-summary').textContent = [width, depth, height].map(format).join(' × ')
  $('#lid-summary').textContent = project.lid.lip > 0 ? 'Inset lip' : 'Flat'
  $('#cutouts-summary').textContent = String(project.cutouts.length)
  $('#mounts-summary').textContent = project.mounts.enabled ? '4 posts' : 'Off'
}

function setIssues(issues) {
  const fields = new Set(issues.map(({ field }) => field))
  nameInput.setAttribute('aria-invalid', String(fields.has('name')))
  for (const input of document.querySelectorAll('[data-field]')) {
    input.setAttribute('aria-invalid', String(fields.has(input.dataset.field)))
  }
  for (const section of document.querySelectorAll('.parameter-section')) {
    section.classList.toggle('has-issue', Boolean(section.querySelector('[aria-invalid="true"]')))
  }
  showNotice(issues.map(({ message }) => message).join(' '))
}

function setReady(ready) {
  saveButton.disabled = !ready
  exportButton.disabled = !ready
  if (!ready && exportOptions.matches(':popover-open')) exportOptions.hidePopover()
}

function saveLocally() {
  try {
    localStorage.setItem(STORAGE_KEY, projectJSON(project))
    status('Saved in this browser', 'saved')
  } catch {
    status('Local storage unavailable', 'error')
  }
}

function commitModel(model) {
  currentModel = model
  currentProject = structuredClone(project)
  preview?.setModel(model, currentProject)
  const { body, lid } = currentProject
  $('#size-value').textContent = [body.width, body.depth, body.height + lid.thickness].map((value) => numberFormat.format(value)).join(' × ') + ' mm'
  if (preview) previewMessage.hidden = true
  saveLocally()
  setReady(true)
}

function updateModel() {
  const issues = validateProject(project)
  setIssues(issues)
  if (issues.length) {
    status('Unapplied changes', 'error')
    if (!currentModel && geometry) previewMessage.textContent = 'Fix the highlighted parameters to preview the enclosure.'
    return
  }
  if (!geometry) {
    status(loadError ? 'Geometry unavailable' : 'Starting editor…', loadError ? 'error' : 'pending')
    return
  }
  try {
    commitModel(buildEnclosure(geometry, project))
  } catch (error) {
    showNotice(error.message)
    status('Unapplied changes', 'error')
  }
}

function scheduleUpdate() {
  updateSummaries()
  setReady(false)
  if (geometry) status('Updating model…', 'pending')
  clearTimeout(modelTimer)
  modelTimer = setTimeout(updateModel, 105)
}

function replaceProject(nextProject, nextModel) {
  clearTimeout(modelTimer)
  project = nextProject
  renderForm()
  setIssues([])
  if (nextModel) commitModel(nextModel)
  else scheduleUpdate()
}

function download(contents, name, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function projectFilename() {
  return project.name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'enclosure'
}

addIcons(document)
renderForm()
setReady(false)

try {
  preview = createPreview($('#scene'), $('#axes'))
} catch {
  previewMessage.textContent = '3D preview needs WebGL. You can still edit and export this project.'
  for (const button of document.querySelectorAll('[data-view], .viewport-tools button')) button.disabled = true
}

initGeometry(wasmURL).then((module) => {
  geometry = module
  clearTimeout(modelTimer)
  const previousNotice = !notices.hidden ? $('#notice-text').textContent : ''
  updateModel()
  if (previousNotice && notices.hidden) showNotice(previousNotice)
}).catch(() => {
  loadError = true
  status('Geometry unavailable', 'error')
  previewMessage.textContent = 'The geometry engine could not load. Reload the page to try again.'
})

document.querySelector('.parameters').addEventListener('input', (event) => {
  const control = event.target
  if (control === mountToggle) {
    project.mounts.enabled = control.checked
  } else if (control.dataset.field) {
    const [group, field, key] = control.dataset.field.split('.')
    const value = control.type === 'number' ? control.valueAsNumber : control.value
    if (group === 'cutouts') {
      const cutout = project.cutouts[Number(field)]
      cutout[key] = value
      if (key === 'shape') {
        if (value === 'Circle' && (!Number.isFinite(cutout.height) || cutout.height < 1 || cutout.height > 200)) {
          cutout.height = 8
        }
        renderCutouts()
        cutoutList.querySelector('[data-field="' + control.dataset.field + '"]').focus()
      }
    } else {
      project[group][field] = value
    }
  } else {
    return
  }
  scheduleUpdate()
})

nameInput.addEventListener('input', () => {
  project.name = nameInput.value
  scheduleUpdate()
})

addCutoutButton.addEventListener('click', () => {
  project.cutouts.push(makeCutout(currentProject?.body ?? defaultProject().body, project.cutouts))
  renderCutouts()
  cutoutList.lastElementChild.querySelector('select').focus()
  scheduleUpdate()
})

$('#open-project').addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', async () => {
  const [file] = fileInput.files
  fileInput.value = ''
  if (!file) return
  try {
    if (file.size > 128 * 1024) throw new Error('Choose a project JSON file smaller than 128 KB.')
    const nextProject = parseProject(await file.text())
    const nextModel = geometry ? buildEnclosure(geometry, nextProject) : null
    replaceProject(nextProject, nextModel)
    notify('Project opened')
  } catch (error) {
    showNotice(error.message || 'The project file could not be opened.')
  }
})

saveButton.addEventListener('click', () => {
  download(projectJSON(project), projectFilename() + '.json', 'application/json')
  notify('Project JSON downloaded')
})

exportOptions.addEventListener('click', (event) => {
  const option = event.target.closest('[data-export]')
  if (!option || exportButton.disabled) return
  const part = option.dataset.export
  const contents = enclosureSTL(currentModel, part, currentProject.body.width)
  download(contents, projectFilename() + '-' + part + '.stl', 'model/stl')
  exportOptions.hidePopover()
  notify(option.querySelector('strong').textContent + ' STL downloaded')
})

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    $('[data-view][aria-pressed="true"]').setAttribute('aria-pressed', 'false')
    button.setAttribute('aria-pressed', 'true')
    preview?.setMode(button.dataset.view)
  })
}
$('#reset-camera').addEventListener('click', () => preview?.resetCamera())
$('#toggle-grid').addEventListener('click', (event) => {
  const button = event.currentTarget
  const visible = button.getAttribute('aria-pressed') !== 'true'
  button.setAttribute('aria-pressed', String(visible))
  preview?.setGrid(visible)
})

const resetDialog = $('#reset-dialog')
$('#reset-project').addEventListener('click', () => {
  resetDialog.returnValue = 'cancel'
  resetDialog.showModal()
})
resetDialog.addEventListener('close', () => {
  if (resetDialog.returnValue === 'reset') replaceProject(defaultProject())
})

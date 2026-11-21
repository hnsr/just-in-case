import '@fontsource-variable/dm-sans/wght.css'
import '@fontsource-variable/space-grotesk'
import './styles.css'
import wasmURL from 'manifold-3d/manifold.wasm?url'
import { initGeometry, buildEnclosure } from './geometry.js'
import { addIcons } from './icons.js'
import { createInspector } from './inspector.js'
import { createPreview } from './preview.js'
import {
  STORAGE_KEY, LEGACY_STORAGE_KEY, defaultProject, newProject, parseProject, projectJSON, evaluateProject,
} from './project.js'
import { enclosureSTL } from './stl.js'

const $ = (selector) => document.querySelector(selector)
const nameInput = $('#project-name')
const fileInput = $('#project-file')
const saveButton = $('#save-project')
const exportButton = $('#export-button')
const exportOptions = $('#export-options')
const previewMessage = $('#preview-message')
const notices = $('#notice')
const toast = $('#toast')
const viewButtons = [...document.querySelectorAll('[data-view]')]
const numberFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 3, useGrouping: false })

let geometry
let preview
let currentModel
let lastResolvedRoot
let modelTimer
let toastTimer
let restoreError = false
let loadError = false
let viewMode = 'exploded'

function restoreProject() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    if (saved) return parseProject(saved)
  } catch {
    restoreError = true
  }
  return defaultProject()
}

let project = restoreProject()

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

function setView(mode) {
  viewMode = mode
  for (const button of viewButtons) button.setAttribute('aria-pressed', String(button.dataset.view === mode))
  preview?.setMode(mode)
}

function setPartOptions({ hasUpper, baseLabel, upperLabel }) {
  $('[data-view="base"]').textContent = baseLabel
  $('[data-view="upper"]').textContent = upperLabel
  for (const button of viewButtons) button.hidden = !hasUpper && button.dataset.view !== 'base'
  $('[data-export="base"] strong').textContent = baseLabel
  $('[data-export="upper"] strong').textContent = upperLabel
  $('[data-export="both"] strong').textContent = upperLabel === 'Lid' ? 'Base and lid' : 'Both halves'
  $('[data-export="upper"]').hidden = !hasUpper
  $('[data-export="both"]').hidden = !hasUpper
  setView(hasUpper ? viewMode : 'base')
}

function commitModel(model, root) {
  currentModel = model
  lastResolvedRoot = root
  setPartOptions(model.layout)
  preview?.setModel(model)
  const { width, depth, height } = model.layout
  $('#size-value').textContent = [width, depth, height].map((value) => numberFormat.format(value)).join(' × ') + ' mm'
  if (preview) previewMessage.hidden = true
  saveLocally()
  setReady(true)
}

function applyEvaluation(evaluation) {
  const { issues } = evaluation
  inspector.applyEvaluation(evaluation)
  nameInput.setAttribute('aria-invalid', String(issues.some(({ field }) => field === 'name')))
  const tail = issues.length > 3 ? ' ' + (issues.length - 3) + ' more fields need attention.' : ''
  showNotice(issues.slice(0, 3).map(({ message }) => message).join(' ') + tail)
}

function updateModel() {
  const evaluation = evaluateProject(project)
  applyEvaluation(evaluation)
  if (evaluation.issues.length) {
    status('Unapplied changes', 'error')
    if (!currentModel && geometry && preview) previewMessage.textContent = 'Fix the highlighted settings to preview the enclosure.'
    return
  }
  if (!geometry) {
    status(loadError ? 'Geometry unavailable' : 'Starting editor…', loadError ? 'error' : 'pending')
    return
  }
  try {
    commitModel(buildEnclosure(geometry, evaluation.root), evaluation.root)
  } catch (error) {
    showNotice(error.message)
    status('Unapplied changes', 'error')
    if (!currentModel && preview) previewMessage.textContent = 'Adjust the project to generate a solid enclosure.'
  }
}

function scheduleUpdate() {
  setReady(false)
  if (geometry) status('Updating model…', 'pending')
  clearTimeout(modelTimer)
  modelTimer = setTimeout(updateModel, 105)
}

function replaceProject(nextProject, evaluated, nextModel) {
  clearTimeout(modelTimer)
  project = nextProject
  lastResolvedRoot = undefined
  viewMode = 'exploded'
  nameInput.value = project.name
  inspector.reset()
  showNotice('')
  if (nextModel) {
    applyEvaluation(evaluated)
    commitModel(nextModel, evaluated.root)
  } else {
    scheduleUpdate()
  }
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

const inspector = createInspector(() => project, () => {
  const evaluated = evaluateProject(project)
  return evaluated.issues.length ? lastResolvedRoot : evaluated.root
}, scheduleUpdate)

addIcons(document)
inspector.reset()
nameInput.value = project.name
setReady(false)
if (restoreError) showNotice('The saved project could not be loaded. The example is open.')

try {
  preview = createPreview($('#scene'), $('#axes'))
} catch {
  previewMessage.textContent = '3D preview needs WebGL. You can still edit and export this project.'
  for (const button of [...viewButtons, ...document.querySelectorAll('.viewport-tools button')]) button.disabled = true
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

nameInput.addEventListener('input', () => {
  project.name = nameInput.value
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
    const evaluated = evaluateProject(nextProject)
    const nextModel = geometry ? buildEnclosure(geometry, evaluated.root) : null
    replaceProject(nextProject, evaluated, nextModel)
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
  const label = option.querySelector('strong').textContent
  const suffix = part === 'both' ? part : label.toLowerCase().replaceAll(' ', '-')
  const contents = enclosureSTL(currentModel, part)
  download(contents, projectFilename() + '-' + suffix + '.stl', 'model/stl')
  exportOptions.hidePopover()
  notify(label + ' STL downloaded')
})

for (const button of viewButtons) button.addEventListener('click', () => setView(button.dataset.view))
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

const newDialog = $('#new-dialog')
const newType = $('#new-type')
const newLid = $('#new-has-lid')
$('#new-project').addEventListener('click', () => {
  newDialog.returnValue = 'cancel'
  newType.value = 'lidded'
  newLid.checked = true
  $('#new-lid-row').hidden = false
  newDialog.showModal()
})
newType.addEventListener('change', () => { $('#new-lid-row').hidden = newType.value !== 'lidded' })
newDialog.addEventListener('close', () => {
  if (newDialog.returnValue === 'create') replaceProject(newProject(newType.value, newLid.checked))
})

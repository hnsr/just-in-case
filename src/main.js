import '@fontsource-variable/dm-sans/wght.css'
import '@fontsource-variable/space-grotesk'
import './styles.css'
import wasmURL from 'manifold-3d/manifold.wasm?url'
import { initGeometry, buildEnclosure } from './geometry.js'
import { addIcons } from './icons.js'
import { createInspector } from './inspector.js'
import { createPreview } from './preview.js'
import {
  STORAGE_KEY, LEGACY_STORAGE_KEY, defaultProject, newProject, parseProject, projectJSON, evaluateProject, screwClosureDraftIssues,
} from './project.js'
import { enclosureSTL } from './stl.js'

const $ = (selector) => document.querySelector(selector)
const nameInput = $('#project-name')
const fileInput = $('#project-file')
const saveButton = $('#save-project')
const exportButton = $('#export-button')
const exportOptions = $('#export-options')
const previewMessage = $('#preview-message')
const bananaToggle = $('#banana-for-scale')
const notices = $('#notice')
const toast = $('#toast')
const viewButtons = [...document.querySelectorAll('[data-view]')]
const orientationButtons = [...document.querySelectorAll('[data-orientation]')]
const numberFormat = new Intl.NumberFormat('en', { maximumFractionDigits: 3, useGrouping: false })

let geometry
let preview
let currentModel
let lastResolvedRoot
let selectedObject
let modelObjectPaths = new Map()
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

function displayModel(model) {
  // Draft objects keep their identity even if their tree indices change before the next preview.
  modelObjectPaths = new Map()
  function rememberObject(object, path) {
    modelObjectPaths.set(object, path)
    object.children.forEach((child, index) => rememberObject(child, path + '.children.' + index))
  }
  rememberObject(project.root, 'root')
  setPartOptions(model.layout)
  preview?.setModel(model, modelObjectPaths.get(selectedObject), hiddenModelPaths())
  const { width, depth, height } = model.layout
  $('#size-value').textContent = [width, depth, height].map((value) => numberFormat.format(value)).join(' × ') + ' mm'
  if (preview) previewMessage.hidden = true
}

function hiddenModelPaths() {
  const paths = new Set()
  for (const [object, path] of modelObjectPaths) {
    if (inspector.isHidden(object)) paths.add(path)
  }
  return paths
}

function commitModel(model, root) {
  displayModel(model)
  currentModel = model
  lastResolvedRoot = root
  saveLocally()
  setReady(true)
}

function applyEvaluation(evaluation) {
  const { issues } = evaluation
  inspector.applyEvaluation(evaluation)
  nameInput.setAttribute('aria-invalid', String(issues.some(({ field }) => field === 'name')))
  const messages = [...new Set(issues.map(({ message }) => message))]
  const tail = messages.length > 3 ? ' ' + (messages.length - 3) + ' more issues need attention.' : ''
  showNotice(messages.slice(0, 3).join(' ') + tail)
}

function updateModel() {
  const evaluation = evaluateProject(project)
  const screwIssues = screwClosureDraftIssues(evaluation.root, evaluation.issues)
  if (evaluation.issues.length && !screwIssues.length) {
    applyEvaluation(evaluation)
    status('Unapplied changes', 'error')
    if (!currentModel && geometry && preview) previewMessage.textContent = 'Fix the highlighted settings to preview the enclosure.'
    return
  }
  if (!geometry) {
    applyEvaluation(evaluation)
    status(loadError ? 'Geometry unavailable' : 'Starting editor…', loadError ? 'error' : 'pending')
    return
  }
  try {
    const model = buildEnclosure(geometry, evaluation.root, { preview: true, screwIssues })
    applyEvaluation({ ...evaluation, issues: model.previewIssues })
    if (model.previewIssues.length) {
      displayModel(model)
      const placementOnly = model.previewIssues.every(({ field }) => field.endsWith('.placement'))
      status(placementOnly ? 'Placement needs adjustment' : 'Screw closure needs adjustment', 'error')
      setReady(false)
      return
    }
    commitModel(model, evaluation.root)
  } catch (error) {
    applyEvaluation(evaluation)
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
}, scheduleUpdate, (object) => {
  selectedObject = object
  preview?.setSelection(modelObjectPaths.get(object))
}, () => preview?.setHidden(hiddenModelPaths()))

addIcons(document)
inspector.reset()
nameInput.value = project.name
setReady(false)
if (restoreError) showNotice('The saved project could not be loaded. The example is open.')

try {
  preview = createPreview($('#scene'), $('#axes'))
} catch {
  previewMessage.textContent = 'The live preview needs WebGL. You can still edit and export this project.'
  for (const control of [...viewButtons, ...orientationButtons, ...document.querySelectorAll('.viewport-tools button'), bananaToggle]) {
    control.disabled = true
  }
}
preview?.setBananaVisible(bananaToggle.checked)
bananaToggle.addEventListener('change', () => preview?.setBananaVisible(bananaToggle.checked))

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
for (const button of orientationButtons) {
  button.addEventListener('click', () => {
    const { orientation } = button.dataset
    for (const option of orientationButtons) option.setAttribute('aria-pressed', String(option === button))
    $('#preview-help').textContent = orientation === '3d' ? 'Drag to orbit · Scroll to zoom' : 'Scroll to zoom'
    preview?.setOrientation(orientation)
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

const changeDialog = $('#change-dialog')
const changeType = $('#change-type')
const changeLid = $('#change-has-lid')
const changeLidRow = $('#change-lid-row')
$('#change-enclosure').addEventListener('click', () => {
  changeDialog.returnValue = 'cancel'
  changeType.value = 'lidded'
  changeLid.checked = true
  changeLidRow.hidden = false
  changeDialog.showModal()
})
changeType.addEventListener('change', () => { changeLidRow.hidden = changeType.value !== 'lidded' })
changeDialog.addEventListener('close', () => {
  if (changeDialog.returnValue === 'reset') replaceProject(newProject(changeType.value, changeLid.checked))
})

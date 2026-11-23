import { addIcons } from './icons.js'

const modes = [
  { value: 'system', label: 'System', icon: 'monitor' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'light', label: 'Light', icon: 'sun' },
]

export function initAppearance(button, onChange) {
  const root = document.documentElement
  const systemLight = window.matchMedia('(prefers-color-scheme: light)')
  const themeColor = document.querySelector('meta[name="theme-color"]')
  const label = button.querySelector('[data-appearance-label]')
  const icon = button.querySelector('[data-icon]')
  let index = Math.max(0, modes.findIndex(({ value }) => value === root.dataset.appearance))
  const nextIndex = () => (index + 1) % modes.length

  function update() {
    const mode = modes[index]
    const light = mode.value === 'light' || (mode.value === 'system' && systemLight.matches)
    root.dataset.appearance = mode.value
    root.dataset.colorScheme = light ? 'light' : 'dark'
    themeColor.content = getComputedStyle(root).getPropertyValue('--background').trim()
    label.textContent = mode.label
    icon.dataset.icon = mode.icon
    addIcons(button)
    button.setAttribute('aria-label', 'Appearance: ' + mode.label)
    button.title = 'Switch appearance to ' + modes[nextIndex()].label
    onChange(light)
  }

  button.addEventListener('click', () => {
    index = nextIndex()
    update()
    try { localStorage.setItem('just-in-case.appearance', modes[index].value) } catch {}
  })
  systemLight.addEventListener('change', () => {
    if (modes[index].value === 'system') update()
  })
  update()
}

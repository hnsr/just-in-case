import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const initialAngle = new THREE.Vector3(0.96, 0.76, 1.28).normalize()
const axes = [
  [new THREE.Vector3(1, 0, 0), '#e78a81', 'X'],
  [new THREE.Vector3(0, 0, -1), '#95c69f', 'Y'],
  [new THREE.Vector3(0, 1, 0), '#8fb2e2', 'Z'],
]

// Convert the model’s Z-up coordinates to the viewer’s Y-up coordinates.
function toGeometry({ vertices, triangles, stride }) {
  const position = new Float32Array(vertices.length / stride * 3)
  const normal = new Float32Array(position.length)
  for (let i = 0, j = 0; i < vertices.length; i += stride, j += 3) {
    position.set([vertices[i], vertices[i + 2], -vertices[i + 1]], j)
    normal.set([vertices[i + 3], vertices[i + 5], -vertices[i + 4]], j)
  }
  return new THREE.BufferGeometry()
    .setAttribute('position', new THREE.BufferAttribute(position, 3))
    .setAttribute('normal', new THREE.BufferAttribute(normal, 3))
    .setIndex(new THREE.BufferAttribute(triangles, 1))
}

function partObject(color) {
  const group = new THREE.Group()
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.03 })
  const ink = new THREE.LineBasicMaterial({ color: 0x4e2a13, transparent: true, opacity: 0.49 })
  const face = new THREE.Mesh(new THREE.BufferGeometry(), material)
  const edge = new THREE.LineSegments(new THREE.BufferGeometry(), ink)
  group.add(face, edge)
  return {
    group,
    set(mesh) {
      face.geometry.dispose()
      edge.geometry.dispose()
      face.geometry = toGeometry(mesh)
      edge.geometry = new THREE.EdgesGeometry(face.geometry, 32)
    },
  }
}

function lighting(scene) {
  scene.add(new THREE.HemisphereLight(0xfff4df, 0x827576, 2.0))
  const key = new THREE.DirectionalLight(0xffe2b8, 2.05)
  key.position.set(-80, 150, 78)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xd3e1ff, 0.75)
  fill.position.set(95, 30, -130)
  scene.add(fill)
}

function contactShadow() {
  const image = document.createElement('canvas')
  image.width = image.height = 128
  const context = image.getContext('2d')
  const fade = context.createRadialGradient(64, 64, 5, 64, 64, 62)
  fade.addColorStop(0, 'rgba(0,0,0,0.72)')
  fade.addColorStop(0.43, 'rgba(0,0,0,0.53)')
  fade.addColorStop(1, 'rgba(0,0,0,0)')
  context.fillStyle = fade
  context.fillRect(0, 0, 128, 128)
  const material = new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(image),
    transparent: true,
    depthWrite: false,
  })
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = -0.12
  return shadow
}

function drawAxes(canvas, camera) {
  const context = canvas.getContext('2d')
  const rotation = camera.quaternion.clone().invert()
  const origin = [36, 38]
  context.setTransform(2, 0, 0, 2, 0, 0)
  context.clearRect(0, 0, 72, 72)
  context.font = '600 11px system-ui'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  for (const [axis, color, label] of axes) {
    const vector = axis.clone().applyQuaternion(rotation)
    const point = [origin[0] + vector.x * 23, origin[1] - vector.y * 23]
    context.beginPath()
    context.moveTo(...origin)
    context.lineTo(...point)
    context.lineWidth = 1.6
    context.strokeStyle = color
    context.stroke()
    context.fillStyle = color
    context.fillText(label, origin[0] + vector.x * 32, origin[1] - vector.y * 32)
  }
  context.fillStyle = '#d6d1ca'
  context.beginPath()
  context.arc(...origin, 2, 0, Math.PI * 2)
  context.fill()
}

export function createPreview(container, axisCanvas) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.03
  renderer.domElement.tabIndex = 0
  renderer.domElement.setAttribute('aria-label', 'Enclosure preview. Use arrow keys to orbit, and plus or minus to zoom.')
  container.append(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 8000)
  camera.position.copy(initialAngle).multiplyScalar(700)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.enablePan = false
  controls.zoomToCursor = false
  controls.minZoom = 0.35
  controls.maxZoom = 5
  controls.maxPolarAngle = Math.PI * 0.96

  lighting(scene)
  const base = partObject(0xdf9137)
  const lid = partObject(0xf4aa49)
  scene.add(base.group, lid.group)

  const grid = new THREE.GridHelper(400, 40, 0x5e5650, 0x343239)
  grid.position.y = -0.25
  grid.material.transparent = true
  grid.material.opacity = 0.7
  const shadow = contactShadow()
  scene.add(grid, shadow)

  let project
  let mode = 'exploded'
  let frame

  function render() {
    frame = undefined
    controls.update()
    renderer.render(scene, camera)
    drawAxes(axisCanvas, camera)
  }

  function draw() {
    if (frame === undefined) frame = requestAnimationFrame(render)
  }

  function resize() {
    const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
    const width = project?.body.width ?? 100
    const depth = project?.body.depth ?? 70
    const height = project?.body.height ?? 30
    const widest = Math.hypot(width, depth)
    const span = Math.max(widest * 0.68, widest * 0.67 / aspect, height * 0.95)
    camera.left = -span * aspect
    camera.right = span * aspect
    camera.top = span
    camera.bottom = -span
    camera.updateProjectionMatrix()
    renderer.setSize(container.clientWidth, container.clientHeight, false)
    draw()
  }

  function arrange() {
    if (!project) return
    const { body, lid: top } = project
    const gap = Math.max(13, Math.min(39, Math.min(body.width, body.depth) * 0.36))
    const previousTarget = controls.target.y
    base.group.visible = mode !== 'lid'
    lid.group.visible = mode !== 'base'
    const isolated = mode === 'lid'
    // The exported lid sits face down. Flip it upright for both assembly views.
    lid.group.rotation.x = isolated ? 0 : Math.PI
    lid.group.position.y = isolated ? 0 : body.height + top.thickness + (mode === 'exploded' ? gap : 0)
    const highest = isolated ? top.thickness + top.lip : mode === 'base' ? body.height : lid.group.position.y
    controls.target.y = highest * 0.48
    camera.position.y += controls.target.y - previousTarget
    const gridStep = Math.max(0.5, Math.ceil(Math.max(body.width, body.depth) / 120))
    grid.scale.setScalar(gridStep)
    shadow.scale.set(body.width * 1.5, body.depth * 1.65, 1)
    controls.update()
    draw()
  }

  function resetCamera() {
    camera.position.copy(initialAngle).multiplyScalar(700).add(controls.target)
    camera.zoom = 1
    camera.updateProjectionMatrix()
    controls.update()
    draw()
  }

  renderer.domElement.addEventListener('keydown', (event) => {
    const movement = { ArrowLeft: [-0.15, 0], ArrowRight: [0.15, 0], ArrowUp: [0, -0.15], ArrowDown: [0, 0.15] }[event.key]
    if (movement) {
      const offset = camera.position.clone().sub(controls.target)
      const spherical = new THREE.Spherical().setFromVector3(offset)
      spherical.theta += movement[0]
      spherical.phi = THREE.MathUtils.clamp(spherical.phi + movement[1], 0.02, controls.maxPolarAngle)
      camera.position.copy(controls.target).add(offset.setFromSpherical(spherical))
    } else if (['+', '=', '-'].includes(event.key)) {
      camera.zoom = THREE.MathUtils.clamp(camera.zoom * (event.key === '-' ? 0.87 : 1.15), controls.minZoom, controls.maxZoom)
      camera.updateProjectionMatrix()
    } else {
      return
    }
    event.preventDefault()
    controls.update()
    draw()
  })

  controls.addEventListener('change', draw)
  const observer = new ResizeObserver(resize)
  observer.observe(container)
  resize()

  return {
    setModel(model, parameters) {
      project = parameters
      base.set(model.base)
      lid.set(model.lid)
      resize()
      arrange()
    },
    setMode(nextMode) {
      mode = nextMode
      arrange()
    },
    resetCamera,
    setGrid(visible) {
      grid.visible = visible
      draw()
    },
  }
}

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createBanana } from './banana.js'
import { createCutterOutline } from './cutter-outline.js'

const initialAngle = new THREE.Vector3(0.96, 0.76, 1.28).normalize()
const axes = [
  [new THREE.Vector3(1, 0, 0), '#e78a81', 'X'],
  [new THREE.Vector3(0, 0, -1), '#95c69f', 'Y'],
  [new THREE.Vector3(0, 1, 0), '#8fb2e2', 'Z'],
]

// Convert the model’s Z-up coordinates to the viewer’s Y-up coordinates.
function toGeometry({ vertices, triangles, stride }, includeNormals = true) {
  const position = new Float32Array(vertices.length / stride * 3)
  const normal = includeNormals ? new Float32Array(position.length) : null
  for (let i = 0, j = 0; i < vertices.length; i += stride, j += 3) {
    position.set([vertices[i], vertices[i + 2], -vertices[i + 1]], j)
    if (normal) normal.set([vertices[i + 3], vertices[i + 5], -vertices[i + 4]], j)
  }
  const geometry = new THREE.BufferGeometry()
    .setAttribute('position', new THREE.BufferAttribute(position, 3))
    .setIndex(new THREE.BufferAttribute(triangles, 1))
  if (normal) geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  return geometry
}

function partObject(color) {
  const group = new THREE.Group()
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.68, metalness: 0.03 })
  const highlight = material.clone()
  highlight.color.setHex(0x4cd5ce)
  const subdued = material.clone()
  subdued.color.multiplyScalar(0.54)
  const hidden = new THREE.MeshBasicMaterial({ visible: false })
  // Reuse the face groups and draw a translucent cue only behind the visible surface.
  const occluded = new THREE.MeshBasicMaterial({
    color: 0x41e8ff,
    toneMapped: false,
    transparent: true,
    opacity: 0.46,
    depthFunc: THREE.GreaterDepth,
    depthWrite: false,
  })
  const ink = new THREE.LineBasicMaterial({ color: 0x4e2a13, transparent: true, opacity: 0.49 })
  const face = new THREE.Mesh(new THREE.BufferGeometry(), [material, highlight, subdued])
  const ghost = new THREE.Mesh(face.geometry, [hidden, occluded, hidden])
  ghost.visible = false
  ghost.renderOrder = 1
  const edge = new THREE.LineSegments(new THREE.BufferGeometry(), ink)
  group.add(face, edge, ghost)
  let mesh

  function select(path) {
    if (!mesh) return
    const geometry = face.geometry
    geometry.clearGroups()
    ghost.visible = false

    if (!path || mesh.runs.length === 0) {
      geometry.addGroup(0, mesh.triangles.length, 0)
      return
    }

    for (const run of mesh.runs) {
      let tint = 0
      if (path === 'root' && run.path !== path) tint = 2
      if (path !== 'root' && run.path === path) tint = 1
      const previous = geometry.groups.at(-1)
      if (previous?.materialIndex === tint) previous.count += run.count
      else geometry.addGroup(run.start, run.count, tint)
      if (tint === 1) ghost.visible = true
    }
  }

  return {
    group,
    select,
    set(nextMesh, path) {
      mesh = nextMesh
      face.geometry.dispose()
      edge.geometry.dispose()
      face.geometry = toGeometry(mesh)
      ghost.geometry = face.geometry
      edge.geometry = new THREE.EdgesGeometry(face.geometry, 32)
      select(path)
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
  const cutterOutline = createCutterOutline()
  const placementGuides = { base: new THREE.Group(), upper: new THREE.Group() }
  const invalidSurface = new THREE.MeshStandardMaterial({
    color: 0xf03944, emissive: 0x70121e, roughness: 0.68,
  })
  const invalidOccluded = new THREE.MeshBasicMaterial({
    color: 0xff5967,
    toneMapped: false,
    transparent: true,
    opacity: 0.42,
    depthFunc: THREE.GreaterDepth,
    depthWrite: false,
  })
  base.group.add(placementGuides.base)
  lid.group.add(placementGuides.upper)
  scene.add(base.group, lid.group)

  const grid = new THREE.GridHelper(400, 40, 0x5e5650, 0x343239)
  grid.position.y = -0.25
  grid.material.transparent = true
  grid.material.opacity = 0.7
  const shadow = contactShadow()
  scene.add(grid, shadow)

  let model
  let selectedPath
  let cutterBounds
  let banana
  let bananaShadow
  let visibleHeight = 30
  let framingRadius = 0
  let cameraDistance = 700
  let mode = 'exploded'
  let frame

  function render() {
    frame = undefined
    controls.update()
    cutterOutline.update(camera, container.clientHeight * camera.zoom / (camera.top - camera.bottom))
    renderer.render(scene, camera)
    drawAxes(axisCanvas, camera)
  }

  function draw() {
    if (frame === undefined) frame = requestAnimationFrame(render)
  }

  function resize() {
    const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
    const width = model?.layout.width ?? 100
    const depth = model?.layout.depth ?? 70
    const widest = Math.hypot(width, depth)
    const span = Math.max(widest * 0.68, widest * 0.67 / aspect, visibleHeight * 0.67, framingRadius * 1.12 / Math.min(aspect, 1))
    camera.left = -span * aspect
    camera.right = span * aspect
    camera.top = span
    camera.bottom = -span
    camera.updateProjectionMatrix()
    renderer.setSize(container.clientWidth, container.clientHeight, false)
    draw()
  }

  function updateCutter() {
    const cutter = model?.cutters.get(selectedPath)
    if (!cutter) {
      cutterBounds = cutterOutline.set()
      cutterOutline.line.removeFromParent()
      return
    }
    const geometry = toGeometry(cutter, false)
    cutterBounds = cutterOutline.set(geometry)
    geometry.dispose()
    const part = cutter.part === 'base' ? base : lid
    part.group.add(cutterOutline.line)
  }

  function updatePlacementGuides() {
    for (const guide of Object.values(placementGuides)) {
      for (const object of guide.children) object.geometry.dispose()
      guide.clear()
    }
    for (const { part, mesh } of model.invalidPlacements) {
      const geometry = toGeometry(mesh)
      const object = new THREE.Mesh(geometry, invalidSurface)
      const ghost = new THREE.Mesh(geometry, invalidOccluded)
      ghost.renderOrder = 2
      object.add(ghost)
      placementGuides[part].add(object)
    }
  }

  function aimCamera(width, depth) {
    const target = new THREE.Vector3(0, visibleHeight * 0.48, 0)
    framingRadius = 0
    const referenceBounds = new THREE.Box3()
    const part = cutterOutline.line.parent
    if (cutterBounds && part?.visible) {
      part.updateWorldMatrix(true, false)
      referenceBounds.union(cutterBounds.clone().applyMatrix4(part.matrixWorld))
    }
    for (const guide of Object.values(placementGuides)) {
      if (guide.children.length && guide.parent.visible) {
        guide.updateWorldMatrix(true, false)
        referenceBounds.expandByObject(guide)
      }
    }
    if (banana?.visible) {
      referenceBounds.union(banana.geometry.boundingBox.clone().translate(banana.position))
    }
    if (!referenceBounds.isEmpty()) {
      const enclosure = new THREE.Box3(
        new THREE.Vector3(-width / 2, 0, -depth / 2),
        new THREE.Vector3(width / 2, visibleHeight, depth / 2),
      )
      const padding = Math.max(width, depth, visibleHeight) * 0.1
      if (!enclosure.clone().expandByScalar(padding).containsBox(referenceBounds)) {
        enclosure.union(referenceBounds).getCenter(target)
        framingRadius = enclosure.getSize(new THREE.Vector3()).length() / 2
      }
    }
    cameraDistance = Math.max(700, framingRadius * 2)
    camera.far = Math.max(8000, cameraDistance + framingRadius + 10)
    camera.position.sub(controls.target).setLength(cameraDistance).add(target)
    controls.target.copy(target)
  }

  function arrange() {
    if (!model) return
    const { width, depth, height, hasUpper } = model.layout
    const gap = Math.max(13, Math.min(39, Math.min(width, depth) * 0.36))
    const isolated = mode === 'upper'
    base.group.visible = !hasUpper || !isolated
    lid.group.visible = Boolean(hasUpper && mode !== 'base')
    // The upper part is face-down in its STL and in the isolated view.
    lid.group.rotation.x = isolated ? 0 : Math.PI
    lid.group.position.y = isolated ? 0 : height + (mode === 'exploded' ? gap : 0)
    visibleHeight = !hasUpper || mode === 'base' ? model.base.height
      : isolated ? model.upper.height : lid.group.position.y
    if (banana?.visible) {
      banana.position.set(-12, 0, depth / 2 + 14 - banana.geometry.boundingBox.min.z)
      bananaShadow.position.x = banana.position.x
      bananaShadow.position.z = banana.position.z
    }
    aimCamera(width, depth)
    const gridStep = Math.max(0.5, Math.ceil(Math.max(width, depth) / 120))
    grid.scale.setScalar(gridStep)
    shadow.scale.set(width * 1.5, depth * 1.65, 1)
    controls.update()
    resize()
  }

  function resetCamera() {
    camera.position.copy(initialAngle).multiplyScalar(cameraDistance).add(controls.target)
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
    setModel(nextModel, path) {
      model = nextModel
      selectedPath = path
      base.set(model.base, selectedPath)
      if (model.upper) lid.set(model.upper, selectedPath)
      updatePlacementGuides()
      updateCutter()
      arrange()
    },
    setSelection(path) {
      if (selectedPath === path) return
      selectedPath = path
      base.select(path)
      lid.select(path)
      updateCutter()
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
    setBananaVisible(visible) {
      if (visible && !banana) {
        banana = createBanana()
        bananaShadow = shadow.clone()
        const size = banana.geometry.boundingBox.getSize(new THREE.Vector3())
        bananaShadow.scale.set(size.x * 1.24, size.z * 1.35, 1)
        scene.add(banana, bananaShadow)
      }
      if (!banana) return
      banana.visible = visible
      bananaShadow.visible = visible
      arrange()
    },
  }
}

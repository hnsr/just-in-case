import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { createBanana } from './banana.js'
import { createCutterOutline } from './cutter-outline.js'

const initialAngle = new THREE.Vector3(0.96, 0.76, 1.28).normalize()
// View from +Z for the enclosure's front (its negative Y wall) and +X for its right side.
const alignmentViews = {
  top: { direction: [0, 1, 0], up: [0, 0, -1], horizontal: 'x', vertical: 'z' },
  front: { direction: [0, 0, 1], up: [0, 1, 0], horizontal: 'x', vertical: 'y' },
  side: { direction: [1, 0, 0], up: [0, 1, 0], horizontal: 'z', vertical: 'y' },
}
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
  const shaded = [material, highlight, subdued]
  const translucent = [material.color, highlight.color, subdued.color].map((color, index) => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: index === 1 ? 0.48 : 0.19, depthWrite: false, toneMapped: false,
  }))
  const alignmentInk = new THREE.LineBasicMaterial({
    color: 0xf6bc82, transparent: true, opacity: 0.63, depthWrite: false, toneMapped: false,
  })
  const face = new THREE.Mesh(new THREE.BufferGeometry(), shaded)
  const ghost = new THREE.Mesh(face.geometry, [hidden, occluded, hidden])
  ghost.visible = false
  ghost.renderOrder = 1
  const edge = new THREE.LineSegments(new THREE.BufferGeometry(), ink)
  group.add(face, edge, ghost)
  let mesh

  function updateEdges(geometry) {
    edge.geometry.dispose()
    const count = geometry.groups.reduce((sum, group) => sum + group.count, 0)
    const triangles = geometry.index.array
    if (count === triangles.length) {
      edge.geometry = new THREE.EdgesGeometry(geometry, 32)
      return
    }
    const visibleTriangles = new Uint32Array(count)
    let cursor = 0
    for (const { start, count } of geometry.groups) {
      visibleTriangles.set(triangles.subarray(start, start + count), cursor)
      cursor += count
    }
    const visibleFaces = new THREE.BufferGeometry()
      .setAttribute('position', geometry.getAttribute('position'))
      .setIndex(new THREE.BufferAttribute(visibleTriangles, 1))
    edge.geometry = new THREE.EdgesGeometry(visibleFaces, 32)
  }

  function select(path, isHidden, refreshEdges = false) {
    if (!mesh) return
    const geometry = face.geometry
    geometry.clearGroups()
    ghost.visible = false

    for (const run of mesh.runs) {
      if (isHidden(run.visiblePath)) continue
      let tint = 0
      if (path === 'root' && run.path !== path) tint = 2
      if (path !== 'root' && run.path === path && !isHidden(path)) tint = 1
      const previous = geometry.groups.at(-1)
      if (previous?.materialIndex === tint && previous.start + previous.count === run.start) previous.count += run.count
      else geometry.addGroup(run.start, run.count, tint)
      if (tint === 1 && face.material === shaded) ghost.visible = true
    }
    if (mesh.runs.length === 0) geometry.addGroup(0, mesh.triangles.length, 0)
    if (refreshEdges) updateEdges(geometry)
  }

  return {
    group,
    select,
    setTranslucent(enabled) {
      face.material = enabled ? translucent : shaded
      edge.material = enabled ? alignmentInk : ink
      edge.renderOrder = enabled ? 1 : 0
      ghost.visible = !enabled && face.geometry.groups.some(({ materialIndex }) => materialIndex === 1)
    },
    set(nextMesh, path, isHidden) {
      mesh = nextMesh
      face.geometry.dispose()
      face.geometry = toGeometry(mesh)
      ghost.geometry = face.geometry
      select(path, isHidden, true)
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

function drawAxes(canvas, camera, aligned) {
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
    if (aligned && Math.hypot(vector.x, vector.y) < 0.01) continue
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
  const alignmentCamera = camera.clone()
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
  const overlays = { base: new THREE.Group(), upper: new THREE.Group() }
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
  const invalidTranslucent = new THREE.MeshBasicMaterial({
    color: 0xff5967, transparent: true, opacity: 0.46, depthWrite: false, toneMapped: false,
  })
  const invalidOutline = new THREE.LineBasicMaterial({
    color: 0xff7784,
    toneMapped: false,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false,
  })
  const referenceSurface = new THREE.MeshStandardMaterial({
    color: 0x4799ff, roughness: 0.72, transparent: true, opacity: 0.48, depthWrite: false,
  })
  const selectedReference = referenceSurface.clone()
  selectedReference.color.setHex(0x6bbaff)
  selectedReference.opacity = 0.68
  const referenceOccluded = invalidOccluded.clone()
  referenceOccluded.color.setHex(0x67b6ff)
  referenceOccluded.opacity = 0.33
  base.group.add(overlays.base)
  lid.group.add(overlays.upper)
  scene.add(base.group, lid.group)

  const grid = new THREE.GridHelper(400, 40, 0x5e5650, 0x343239)
  grid.position.y = -0.25
  grid.material.transparent = true
  grid.material.opacity = 0.7
  const shadow = contactShadow()
  scene.add(grid, shadow)

  let model
  let selectedPath
  let hiddenPaths = new Set()
  let cutterBounds
  let banana
  let bananaShadow
  let bananaMaterials
  let visibleHeight = 30
  let framingRadius = 0
  let cameraDistance = 700
  let alignmentView
  const alignmentSize = new THREE.Vector2(100, 70)
  let mode = 'exploded'
  let frame

  function render() {
    frame = undefined
    if (!alignmentView) controls.update()
    const active = alignmentView ? alignmentCamera : camera
    cutterOutline.update(active, container.clientHeight * active.zoom / (active.top - active.bottom))
    renderer.render(scene, active)
    drawAxes(axisCanvas, active, alignmentView)
  }

  function draw() {
    if (frame === undefined) frame = requestAnimationFrame(render)
  }

  function resize() {
    const aspect = Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1)
    const active = alignmentView ? alignmentCamera : camera
    const widest = Math.hypot(model?.layout.width ?? 100, model?.layout.depth ?? 70)
    const span = alignmentView
      ? Math.max(alignmentSize.x / aspect, alignmentSize.y, 1) * 0.64
      : Math.max(widest * 0.68, widest * 0.67 / aspect, visibleHeight * 0.67, framingRadius * 1.12 / Math.min(aspect, 1))
    active.left = -span * aspect
    active.right = span * aspect
    active.top = span
    active.bottom = -span
    active.updateProjectionMatrix()
    renderer.setSize(container.clientWidth, container.clientHeight, false)
    draw()
  }

  function updateCutter() {
    const cutter = isHidden(selectedPath) ? undefined : model?.cutters.get(selectedPath)
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

  function isHidden(path) {
    if (!path) return false
    for (const hidden of hiddenPaths) {
      if (path === hidden || path.startsWith(hidden + '.')) return true
    }
    return false
  }

  function updateOverlayVisibility() {
    for (const group of Object.values(overlays)) {
      for (const object of group.children) {
        const { paths, referencePath } = object.userData
        object.visible = !paths.length || !paths.every(isHidden)
        if (referencePath) {
          const selected = referencePath === selectedPath
          object.material = selected ? selectedReference : referenceSurface
          object.children[0].visible = selected && !alignmentView
        } else if (object.isMesh) {
          object.material = alignmentView ? invalidTranslucent : invalidSurface
          object.children[0].visible = !alignmentView
        }
      }
    }
  }

  function updateOverlays() {
    for (const group of Object.values(overlays)) {
      for (const object of group.children) object.geometry.dispose()
      group.clear()
    }
    for (const { part, mesh, outline, paths } of model.previewGuides) {
      const geometry = toGeometry(mesh, !outline)
      if (outline) {
        const line = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), invalidOutline)
        geometry.dispose()
        line.renderOrder = 3
        line.userData.paths = paths
        overlays[part].add(line)
        continue
      }
      const object = new THREE.Mesh(geometry, invalidSurface)
      object.userData.paths = paths
      const ghost = new THREE.Mesh(geometry, invalidOccluded)
      ghost.renderOrder = 2
      object.add(ghost)
      overlays[part].add(object)
    }
    for (const { part, path, mesh } of model.references) {
      const geometry = toGeometry(mesh)
      const object = new THREE.Mesh(geometry, referenceSurface)
      object.userData = { paths: [path], referencePath: path }
      const ghost = new THREE.Mesh(geometry, referenceOccluded)
      ghost.renderOrder = 1
      object.add(ghost)
      overlays[part].add(object)
    }
    updateOverlayVisibility()
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
    for (const group of Object.values(overlays)) {
      if (group.children.length && group.parent.visible) {
        group.updateWorldMatrix(true, false)
        for (const object of group.children) {
          if (object.visible) referenceBounds.expandByObject(object)
        }
      }
    }
    if (banana?.visible) {
      referenceBounds.union(banana.geometry.boundingBox.clone().translate(banana.position))
    }
    const enclosure = new THREE.Box3(
      new THREE.Vector3(-width / 2, 0, -depth / 2),
      new THREE.Vector3(width / 2, visibleHeight, depth / 2),
    )
    if (alignmentView) {
      const bounds = enclosure.union(referenceBounds)
      const size = bounds.getSize(new THREE.Vector3())
      bounds.getCenter(target)
      alignmentSize.set(size[alignmentView.horizontal], size[alignmentView.vertical])
      const distance = Math.max(700, size.length())
      alignmentCamera.position.fromArray(alignmentView.direction).multiplyScalar(distance).add(target)
      alignmentCamera.up.fromArray(alignmentView.up)
      alignmentCamera.far = Math.max(8000, distance + size.length() + 10)
      alignmentCamera.lookAt(target)
      return
    }
    if (!referenceBounds.isEmpty()) {
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
    const showEnclosure = !isHidden('root')
    base.group.visible = showEnclosure && (!hasUpper || !isolated)
    lid.group.visible = showEnclosure && Boolean(hasUpper && mode !== 'base')
    shadow.visible = showEnclosure && !alignmentView
    // The upper part is face-down in its STL and in the isolated view.
    lid.group.rotation.x = isolated ? 0 : Math.PI
    lid.group.position.y = isolated ? 0 : height + (mode === 'exploded' ? gap : 0)
    visibleHeight = !hasUpper || mode === 'base' ? model.base.height
      : isolated ? model.upper.height : lid.group.position.y
    if (banana?.visible) {
      banana.position.set(-12, 0, depth / 2 + 14 - banana.geometry.boundingBox.min.z)
      banana.material = alignmentView ? bananaMaterials.translucent : bananaMaterials.shaded
      bananaShadow.visible = !alignmentView
      bananaShadow.position.x = banana.position.x
      bananaShadow.position.z = banana.position.z
    }
    aimCamera(width, depth)
    const gridStep = Math.max(0.5, Math.ceil(Math.max(width, depth) / 120))
    grid.scale.setScalar(gridStep)
    const front = alignmentView === alignmentViews.front
    const side = alignmentView === alignmentViews.side
    grid.rotation.set(front ? Math.PI / 2 : 0, 0, side ? Math.PI / 2 : 0)
    grid.position.set(side ? -width / 2 - 0.25 : 0, front || side ? 0 : -0.25, front ? -depth / 2 - 0.25 : 0)
    grid.material.depthWrite = !alignmentView
    grid.renderOrder = alignmentView ? -1 : 0
    shadow.scale.set(width * 1.5, depth * 1.65, 1)
    if (!alignmentView) controls.update()
    resize()
  }

  function resetCamera() {
    const active = alignmentView ? alignmentCamera : camera
    active.zoom = 1
    if (!alignmentView) {
      camera.position.copy(initialAngle).multiplyScalar(cameraDistance).add(controls.target)
      controls.update()
    }
    active.updateProjectionMatrix()
    draw()
  }

  function zoom(active, multiplier) {
    active.zoom = THREE.MathUtils.clamp(active.zoom * multiplier, controls.minZoom, controls.maxZoom)
    active.updateProjectionMatrix()
    draw()
  }

  renderer.domElement.addEventListener('wheel', (event) => {
    if (!alignmentView || !event.deltaY) return
    event.preventDefault()
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1)
    zoom(alignmentCamera, Math.exp(-delta * 0.0015))
  }, { passive: false })

  renderer.domElement.addEventListener('keydown', (event) => {
    const movement = { ArrowLeft: [-0.15, 0], ArrowRight: [0.15, 0], ArrowUp: [0, -0.15], ArrowDown: [0, 0.15] }[event.key]
    if (movement && !alignmentView) {
      const offset = camera.position.clone().sub(controls.target)
      const spherical = new THREE.Spherical().setFromVector3(offset)
      spherical.theta += movement[0]
      spherical.phi = THREE.MathUtils.clamp(spherical.phi + movement[1], 0.02, controls.maxPolarAngle)
      camera.position.copy(controls.target).add(offset.setFromSpherical(spherical))
      controls.update()
      draw()
    } else if (['+', '=', '-'].includes(event.key)) {
      zoom(alignmentView ? alignmentCamera : camera, event.key === '-' ? 0.87 : 1.15)
    } else {
      return
    }
    event.preventDefault()
  })

  controls.addEventListener('change', draw)
  const observer = new ResizeObserver(resize)
  observer.observe(container)
  resize()

  function refreshSelection(refreshEdges) {
    base.select(selectedPath, isHidden, refreshEdges)
    if (model?.upper) lid.select(selectedPath, isHidden, refreshEdges)
    updateOverlayVisibility()
    updateCutter()
    arrange()
  }

  return {
    setModel(nextModel, path, paths) {
      model = nextModel
      selectedPath = path
      hiddenPaths = paths
      base.set(model.base, selectedPath, isHidden)
      if (model.upper) lid.set(model.upper, selectedPath, isHidden)
      updateOverlays()
      updateCutter()
      arrange()
    },
    setSelection(path) {
      if (selectedPath === path) return
      selectedPath = path
      refreshSelection(false)
    },
    setHidden(paths) {
      hiddenPaths = paths
      refreshSelection(true)
    },
    setMode(nextMode) {
      mode = nextMode
      arrange()
    },
    setOrientation(orientation) {
      alignmentView = alignmentViews[orientation]
      controls.enabled = !alignmentView
      container.classList.toggle('is-aligned', Boolean(alignmentView))
      renderer.domElement.setAttribute('aria-label', alignmentView
        ? 'Enclosure ' + orientation + ' view. Use plus or minus to zoom.'
        : 'Enclosure preview. Use arrow keys to orbit, and plus or minus to zoom.')
      base.setTranslucent(Boolean(alignmentView))
      lid.setTranslucent(Boolean(alignmentView))
      updateOverlayVisibility()
      if (alignmentView) alignmentCamera.zoom = 1
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
        const translucent = banana.material.clone()
        translucent.transparent = true
        translucent.opacity = 0.56
        translucent.depthWrite = false
        bananaMaterials = { shaded: banana.material, translucent }
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

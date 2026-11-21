import * as THREE from 'three'

function meshEdges(geometry) {
  const positions = geometry.getAttribute('position')
  const triangles = geometry.getIndex().array
  const edges = new Map()
  const origin = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ac = new THREE.Vector3()
  const crease = Math.cos(Math.PI / 6)

  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i]
    const b = triangles[i + 1]
    const c = triangles[i + 2]
    origin.fromBufferAttribute(positions, a)
    ab.fromBufferAttribute(positions, b).sub(origin)
    ac.fromBufferAttribute(positions, c).sub(origin)
    const normal = new THREE.Vector3().crossVectors(ab, ac).normalize()
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const key = Math.min(from, to) * positions.count + Math.max(from, to)
      const edge = edges.get(key)
      if (edge) {
        edge.back = normal
        edge.crease = edge.front.dot(normal) < crease
      } else {
        edges.set(key, { from, to, front: normal })
      }
    }
  }
  return [...edges.values()]
}

export function createCutterOutline() {
  const material = new THREE.LineDashedMaterial({
    color: 0x70fff1,
    dashSize: 4,
    gapSize: 2.5,
    transparent: true,
    opacity: 0.94,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  })
  const line = new THREE.LineSegments(new THREE.BufferGeometry(), material)
  line.visible = false
  line.frustumCulled = false
  line.renderOrder = 2

  const direction = new THREE.Vector3()
  const lastDirection = new THREE.Vector3()
  const toLocal = new THREE.Matrix4()
  let edges
  let positions

  return {
    line,
    set(geometry) {
      line.geometry.dispose()
      line.geometry = new THREE.BufferGeometry()
      line.visible = Boolean(geometry)
      edges = undefined
      positions = undefined
      if (!geometry) return

      edges = meshEdges(geometry)
      positions = geometry.getAttribute('position')
      lastDirection.set(0, 0, 0)
      line.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(edges.length * 6), 3).setUsage(THREE.DynamicDrawUsage))
      line.geometry.setAttribute('lineDistance', new THREE.BufferAttribute(new Float32Array(edges.length * 2), 1).setUsage(THREE.DynamicDrawUsage))
      line.geometry.setDrawRange(0, 0)
      geometry.computeBoundingBox()
      return geometry.boundingBox
    },
    update(camera, pixelsPerUnit) {
      if (!line.visible || !line.parent?.visible) return
      material.scale = pixelsPerUnit
      line.parent.updateWorldMatrix(true, false)
      camera.getWorldDirection(direction).transformDirection(toLocal.copy(line.parent.matrixWorld).invert())
      if (direction.distanceToSquared(lastDirection) < 1e-10) return
      lastDirection.copy(direction)

      const { position, lineDistance } = line.geometry.attributes
      let count = 0
      let distance = 0
      for (const { from, to, front, back, crease } of edges) {
        // Adjacent faces pointing to opposite sides of the view form the silhouette.
        if (!crease && back && (front.dot(direction) < 0) === (back.dot(direction) < 0)) continue
        const x1 = positions.getX(from)
        const y1 = positions.getY(from)
        const z1 = positions.getZ(from)
        const x2 = positions.getX(to)
        const y2 = positions.getY(to)
        const z2 = positions.getZ(to)
        position.setXYZ(count, x1, y1, z1)
        position.setXYZ(count + 1, x2, y2, z2)
        lineDistance.setX(count, distance)
        distance += Math.hypot(x2 - x1, y2 - y1, z2 - z1)
        lineDistance.setX(count + 1, distance)
        count += 2
      }
      position.needsUpdate = true
      lineDistance.needsUpdate = true
      line.geometry.setDrawRange(0, count)
    },
  }
}

import * as THREE from 'three'

const LENGTH_MM = 180
const RINGS = 104
const SIDES = 36
const profile = [
  [-88, 14, -27, 2.8],
  [-80, 13, -14, 7.0],
  [-64, 14, 3, 12.1],
  [-42, 15, 17, 15.0],
  [-13, 15, 24, 15.7],
  [18, 16, 23, 15.0],
  [45, 19, 14, 12.5],
  [65, 21, 0, 9.3],
  [76, 23, -15, 5.1],
  [88, 29, -32, 4.1],
]

const peel = [
  [0, new THREE.Color(0x3c2514)],
  [0.05, new THREE.Color(0xa69013)],
  [0.19, new THREE.Color(0xf2d82a)],
  [0.58, new THREE.Color(0xeed51c)],
  [0.81, new THREE.Color(0xc4bc26)],
  [0.94, new THREE.Color(0x989137)],
  [1, new THREE.Color(0x5c421f)],
]

function peelColor(t, angle) {
  const end = peel.findIndex(([stop]) => stop >= t)
  const [from, dark] = peel[Math.max(0, end - 1)]
  const [to, light] = peel[end]
  const mix = end === 0 ? 0 : (t - from) / (to - from)
  return dark.clone().lerp(light, mix).multiplyScalar(0.94 + Math.cos(5 * angle) * 0.065)
}

function bananaGeometry() {
  const curve = new THREE.CatmullRomCurve3(profile.map(([x, y, z]) => new THREE.Vector3(x, y, z)))
  const positions = []
  const colors = []
  const uvs = []
  const indices = []
  const up = new THREE.Vector3(0, 1, 0)

  for (let ring = 0; ring <= RINGS; ring++) {
    const t = ring / RINGS
    const segment = t * (profile.length - 1)
    const start = Math.min(Math.floor(segment), profile.length - 2)
    const blend = THREE.MathUtils.smoothstep(segment - start, 0, 1)
    const radius = THREE.MathUtils.lerp(profile[start][3], profile[start + 1][3], blend)
    const center = curve.getPoint(t)
    const tangent = curve.getTangent(t)
    const side = tangent.clone().cross(up).normalize()
    const vertical = side.clone().cross(tangent)
    for (let j = 0; j <= SIDES; j++) {
      const angle = j / SIDES * Math.PI * 2 - Math.PI / 2
      const ridge = 1 + Math.cos(5 * angle) * 0.065
      const point = center.clone()
        .addScaledVector(side, radius * ridge * Math.cos(angle))
        .addScaledVector(vertical, radius * ridge * 0.87 * Math.sin(angle))
      positions.push(point.x, point.y, point.z)
      const color = peelColor(t, angle)
      colors.push(color.r, color.g, color.b)
      uvs.push(t, j / SIDES)

      if (ring === RINGS || j === SIDES) continue
      const a = ring * (SIDES + 1) + j
      const b = a + SIDES + 1
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }

  for (const end of [0, 1]) {
    const center = curve.getPoint(end)
    const color = peelColor(end, 0)
    const tip = positions.length / 3
    positions.push(center.x, center.y, center.z)
    colors.push(color.r, color.g, color.b)
    uvs.push(end, 0.5)
    for (let j = 0; j < SIDES; j++) {
      const a = end * RINGS * (SIDES + 1) + j
      if (end === 0) indices.push(tip, a, a + 1)
      else indices.push(tip, a + 1, a)
    }
  }

  const geometry = new THREE.BufferGeometry()
    .setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    .setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    .setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    .setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  const { min, max } = geometry.boundingBox
  const scale = LENGTH_MM / (max.x - min.x)
  geometry.translate(-(min.x + max.x) / 2, -min.y, -(min.z + max.z) / 2)
  geometry.scale(scale, scale, scale)
  geometry.computeBoundingBox()
  return geometry
}

function peelTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 256
  const context = canvas.getContext('2d')
  context.fillStyle = 'white'
  context.fillRect(0, 0, canvas.width, canvas.height)

  let seed = 37
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (let i = 0; i < 240; i++) {
    const x = (0.08 + random() * 0.83) * canvas.width
    const y = random() * canvas.height
    const size = 0.5 + random() ** 2 * 2.6
    context.fillStyle = 'rgba(115, 72, 25,' + (0.25 + random() * 0.45) + ')'
    context.beginPath()
    context.ellipse(x, y, size * 1.4, size, random() * Math.PI, 0, Math.PI * 2)
    context.fill()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function createBanana() {
  return new THREE.Mesh(bananaGeometry(), new THREE.MeshStandardMaterial({
    map: peelTexture(),
    vertexColors: true,
    roughness: 0.8,
  }))
}

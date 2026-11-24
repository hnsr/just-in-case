export function enclosureSTL(model, part) {
  if (model.previewIssues?.length) throw new Error(model.previewIssues[0].message)
  const separation = (model.layout.width + 8) / 2
  const parts = {
    base: [[model.base, 0]],
    upper: [[model.upper, 0]],
    both: [[model.base, -separation], [model.upper, separation]],
  }[part]
  if (!parts || parts.some(([mesh]) => !mesh)) throw new Error('This project does not have the requested parts.')
  return writeSTL(parts)
}

export function sampleSTL(sample) {
  return writeSTL([[sample.mesh, 0]])
}

function writeSTL(parts) {
  const triangleCount = parts.reduce((sum, [mesh]) => sum + mesh.triangles.length / 3, 0)
  const buffer = new ArrayBuffer(84 + 50 * triangleCount)
  const view = new DataView(buffer)
  new Uint8Array(buffer).set(new TextEncoder().encode('Just in Case | coordinates in millimetres'))
  view.setUint32(80, triangleCount, true)

  let cursor = 84
  for (const [{ vertices, triangles, stride }, dx] of parts) {
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i] * stride
      const b = triangles[i + 1] * stride
      const c = triangles[i + 2] * stride
      const ux = vertices[b] - vertices[a]
      const uy = vertices[b + 1] - vertices[a + 1]
      const uz = vertices[b + 2] - vertices[a + 2]
      const vx = vertices[c] - vertices[a]
      const vy = vertices[c + 1] - vertices[a + 1]
      const vz = vertices[c + 2] - vertices[a + 2]
      const normal = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
      const length = Math.hypot(...normal) || 1
      normal.forEach((component) => {
        view.setFloat32(cursor, component / length, true)
        cursor += 4
      })
      for (const offset of [a, b, c]) {
        view.setFloat32(cursor, vertices[offset] + dx, true)
        view.setFloat32(cursor + 4, vertices[offset + 1], true)
        view.setFloat32(cursor + 8, vertices[offset + 2], true)
        cursor += 12
      }
      cursor += 2
    }
  }
  return buffer
}

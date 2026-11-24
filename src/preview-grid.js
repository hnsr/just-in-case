import * as THREE from 'three'

// Use the finest interval that still leaves room between neighboring lines.
const gridIntervals = [0.1, 1, 10, 100]

export function gridInterval(pixelsPerMm) {
  return gridIntervals.find((interval) => interval * pixelsPerMm >= 6) ?? gridIntervals.at(-1)
}

export function createPreviewGrid() {
  const geometry = new THREE.PlaneGeometry(2400, 2400).rotateX(-Math.PI / 2)
  const material = new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      interval: { value: 10 },
      gridOpacity: { value: 0.7 },
      lineColor: { value: new THREE.Color(0x403d44) },
      majorColor: { value: new THREE.Color(0x655c59) },
    },
    vertexShader: `
      varying vec2 gridPosition;

      void main() {
        gridPosition = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 gridPosition;
      uniform float interval;
      uniform float gridOpacity;
      uniform vec3 lineColor;
      uniform vec3 majorColor;

      float lineCoverage(float stepSize) {
        vec2 cells = gridPosition / stepSize;
        vec2 footprint = fwidth(cells);
        vec2 distanceInPixels = abs(fract(cells + 0.5) - 0.5) / max(footprint, vec2(0.0001));
        // Fade lines that get too close to resolve when the grid tilts away.
        vec2 coverage = (1.0 - smoothstep(vec2(0.15), vec2(0.9), distanceInPixels))
          * (1.0 - smoothstep(vec2(0.25), vec2(0.5), footprint));
        return max(coverage.x, coverage.y);
      }

      void main() {
        float minor = lineCoverage(interval);
        float major = lineCoverage(interval * 10.0);
        float alpha = max(minor * 0.75, major) * gridOpacity;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(mix(lineColor, majorColor, major), alpha);
        #include <colorspace_fragment>
      }
    `,
  })
  return new THREE.Mesh(geometry, material)
}

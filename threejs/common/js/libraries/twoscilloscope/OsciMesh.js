/*
+ + +   three.twoscilloscope   + + +

A port of OsciMesh from Hansi Raber's Oscilloscope app, the renderer at the
heart of the audio-to-vector half of the library.

Every pair of neighbouring samples becomes a quad around the line between
them, and a shader fills the quad with the light a gaussian electron beam
leaves as it sweeps along that line (the technique from m1el's woscope).
A beam that moves quickly between two samples spreads its light thinly, so
fast strokes come out dim and slow ones bright, the way they do on a real
CRT. Drawn additively into a slowly fading render target (see Oscilloscope),
this is what gives the image its glow and persistence.

Differences from ofxTwoscilloscope:
* An OsciMesh is a THREE.Mesh. Its geometry is in scope units (-1..1, y up)
  and it goes wherever its position, scale or matrix puts it, as oF drew it
  through the current matrices. Its material is the beam shader, drawn
  additively, on both sides (a camera that flips y flips the triangles
  too), and without depth.
* uSize, uRgb and uIntensity are properties that reach the shader each time
  it's drawn. uRgb is a THREE.Color used as is, not colour managed, so set
  it with setRGB().
* addLines() takes typed arrays; pass subarray()s to start part way in.
*/

import {
    AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide,
    DynamicDrawUsage, Mesh, ShaderMaterial
} from 'three';
import { XYFloatArray } from './XYSoundBuffer.js';

// The beam: the light a gaussian spot leaves as it sweeps along one
// segment, integrated analytically with erf (after m1el's woscope).
// vUvl.x runs along the segment, vUvl.y across it, vUvl.z is its length.
// Normalized so a beam that stands still peaks at 1.
export const BEAM_FUNCTIONS = `
#define SQRT2 1.4142135623730951
#define TAUR 2.5066282746310002

// approximates the error function, needed for the gaussian integral
float erfApprox(float x) {
    float s = sign(x), a = abs(x);
    x = 1.0 + (0.278393 + (0.230389 + 0.000972 * a + 0.078108 * a * a) * a) * a;
    x *= x;
    return s - s / (x * x);
}

vec4 beam(vec3 uvl, float bright) {
    float len = uvl.z;
    vec2 xy = uvl.xy;
    float sigma = uSize / 3.0;
    float b;
    if (len < 1E-6) {
        // too short to integrate, the intensity at the position
        b = exp(-dot(xy, xy) / (2.0 * sigma * sigma));
    } else {
        b = erfApprox(xy.x / SQRT2 / sigma) - erfApprox((xy.x - len) / SQRT2 / sigma);
        b *= exp(-xy.y * xy.y / (2.0 * sigma * sigma)) * sigma * TAUR / (2.0 * len);
    }
    b *= bright * uIntensity;
    // where the beam is brightest it burns towards white
    vec3 col = uRgb * b + vec3(max(b - 1.0, 0.0) * 0.35);
    return vec4(col, 1.0);
}
`;

// three declares position (x, y and the brightness, here) and the matrices
const BEAM_VERT = `
attribute vec3 uvl; // the segment-space coordinates and length
varying vec3 vUvl;
varying float vBright;
void main() {
    vUvl = uvl;
    vBright = position.z;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, 0.0, 1.0);
}
`;

const BEAM_FRAG = `
uniform float uSize;
uniform float uIntensity;
uniform vec3 uRgb;
varying vec3 vUvl;
varying float vBright;
` + BEAM_FUNCTIONS + `
void main() {
    gl_FragColor = beam(vUvl, vBright);
}
`;

export class OsciMesh extends Mesh {

    constructor() {
        const material = new ShaderMaterial({
            uniforms: {
                uSize: { value: 0.01 },
                uIntensity: { value: 1 },
                uRgb: { value: new Color(1, 1, 1) }
            },
            vertexShader: BEAM_VERT,
            fragmentShader: BEAM_FRAG,
            blending: AdditiveBlending, // oF's OF_BLENDMODE_ADD: SRC_ALPHA, ONE
            transparent: true,
            depthTest: false,
            depthWrite: false,
            side: DoubleSide
        });
        super(new BufferGeometry(), material);
        this.type = 'OsciMesh';
        this.frustumCulled = false;

        // the original's shader parameters
        this.uSize = 0.01;               // beam radius in scope units
        this.uRgb = new Color(1, 1, 1);  // beam color, 0..1
        this.uIntensity = 1;

        // for each of 6 vertices a line: x, y and brightness, then u, v and length
        this.positions = new XYFloatArray(18 * 1024);
        this.uvls = new XYFloatArray(18 * 1024);
        this.last = { x: 0, y: 0 };
    }

    onBeforeRender() {
        const u = this.material.uniforms;
        u.uSize.value = this.uSize;
        u.uIntensity.value = this.uIntensity;
        u.uRgb.value.copy(this.uRgb);
    }

    // Add many lines at once.
    // left: x coordinates (-1..1)
    // right: y coordinates (-1..1)
    // bright: brightness (0..1), or null for full brightness
    // stride: step between samples in left and right (not bright)
    addLines(left, right, bright, n, stride = 1) {
        // no work? go home watch tv or something
        if (n <= 0 || stride <= 0) return;

        this.pushLine(this.last.x, this.last.y, left[0], right[0], bright ? bright[0] : 1);
        const lastIndex = Math.floor((n - 1) / stride) * stride;
        this.last = { x: left[lastIndex], y: right[lastIndex] };

        const more = 18 * (Math.floor(n / stride) + 1);
        this.positions.reserve(this.positions.length + more);
        this.uvls.reserve(this.uvls.length + more);
        for (let i = stride; i < n; i += stride) {
            this.pushLine(left[i - stride], right[i - stride], left[i], right[i], bright ? bright[i] : 1);
        }
        this.sync();
    }

    // Add one line from (x0, y0) to (x1, y1) (-1..1), with brightness 0..1.
    addLine(x0, y0, x1, y1, bright = 1) {
        this.pushLine(x0, y0, x1, y1, bright);
        this.sync();
    }

    pushLine(x0, y0, x1, y1, bright) {
        let dx = x1 - x0, dy = y1 - y0;
        const z = Math.sqrt(dx * dx + dy * dy);
        if (z > 1e-6) {
            dx /= z;
            dy /= z;
        } else {
            dx = 1;
            dy = 0;
        }

        const size = this.uSize;
        dx *= size;
        dy *= size;
        const nx = -dy, ny = dx;

        const ps = this.positions, us = this.uvls;
        if (ps.length + 18 > ps.data.length) {
            ps.reserve(ps.length + 18);
            us.reserve(us.length + 18);
        }
        const p = ps.data, u = us.data;
        let k = ps.length;
        const ax = x0 - dx, ay = y0 - dy;
        const bx = x1 + dx, by = y1 + dy;
        // p0 - dir - norm, p0 - dir + norm, p1 + dir - norm
        p[k] = ax - nx; p[k + 1] = ay - ny; p[k + 2] = bright; u[k] = -size; u[k + 1] = -size; u[k + 2] = z; k += 3;
        p[k] = ax + nx; p[k + 1] = ay + ny; p[k + 2] = bright; u[k] = -size; u[k + 1] = size; u[k + 2] = z; k += 3;
        p[k] = bx - nx; p[k + 1] = by - ny; p[k + 2] = bright; u[k] = z + size; u[k + 1] = -size; u[k + 2] = z; k += 3;
        // p0 - dir + norm, p1 + dir - norm, p1 + dir + norm
        p[k] = ax + nx; p[k + 1] = ay + ny; p[k + 2] = bright; u[k] = -size; u[k + 1] = size; u[k + 2] = z; k += 3;
        p[k] = bx - nx; p[k + 1] = by - ny; p[k + 2] = bright; u[k] = z + size; u[k + 1] = -size; u[k + 2] = z; k += 3;
        p[k] = bx + nx; p[k + 1] = by + ny; p[k + 2] = bright; u[k] = z + size; u[k + 1] = size; u[k + 2] = z; k += 3;
        ps.length = k;
        us.length = k;
    }

    getNumVertices() {
        return this.positions.length / 3;
    }

    clear() {
        this.positions.clear();
        this.uvls.clear();
        this.sync();
    }

    // Hand the vertices to the geometry: the same arrays while they fit, a new
    // geometry (freeing the old buffers) when they've grown.
    sync() {
        const count = this.positions.length / 3;
        let position = this.geometry.getAttribute('position');
        let uvl = this.geometry.getAttribute('uvl');
        if (!position || position.array !== this.positions.data || uvl.array !== this.uvls.data) {
            this.geometry.dispose();
            const geometry = new BufferGeometry();
            position = new BufferAttribute(this.positions.data, 3).setUsage(DynamicDrawUsage);
            uvl = new BufferAttribute(this.uvls.data, 3).setUsage(DynamicDrawUsage);
            geometry.setAttribute('position', position);
            geometry.setAttribute('uvl', uvl);
            this.geometry = geometry;
        }
        if (count > 0) {
            for (const attribute of [position, uvl]) {
                attribute.clearUpdateRanges();
                attribute.addUpdateRange(0, count * 3);
                attribute.needsUpdate = true;
            }
        }
        this.geometry.setDrawRange(0, count);
    }

    dispose() {
        this.geometry.dispose();
        this.material.dispose();
    }

}

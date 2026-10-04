// Draws a Latk animation through three.twoscilloscope, the way
// example-transform draws a shape: the current frame is projected through the
// camera, encoded as one loop of XY audio, run through the effect chain, and
// drawn back from the altered audio.
//
// The strokes are encoded here rather than by XYscope, so that every sample
// of the loop is known to belong to one stroke. The effects pass Z through
// untouched, so that still holds after them, and each stroke is drawn from
// its own samples in its own colour.
//
// beams (one OsciMesh per colour) and strokes (an XYShapes) are three.js
// objects in canvas pixels, y down; buildBeams() and buildStrokes() bring them
// up to date with the last update().

import { Color, Group, Matrix4, SRGBColorSpace } from 'three';
import { OsciMesh, XYDecoder, XYParameterGroup, XYShapes, XYSoundBuffer, XYTransformer } from 'twoscilloscope';

// Cuts the segment a-b to the canvas (Liang-Barsky). Returns null if none of
// it is inside, or [t0, t1], where the inside part starts and ends.
function clipSegment(ax, ay, bx, by, w, h) {
    const dx = bx - ax, dy = by - ay;
    const p = [-dx, dx, -dy, dy];
    const q = [ax, w - ax, ay, h - ay];
    let t0 = 0, t1 = 1;
    for (let i = 0; i < 4; i++) {
        if (p[i] === 0) {
            // parallel to this edge, so all in or all out
            if (q[i] < 0) return null;
            continue;
        }
        const t = q[i] / p[i];
        if (p[i] < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
        if (t0 > t1) return null;
    }
    return [t0, t1];
}

export class LatkScopeRenderer {

    constructor(sampleRate = 44100) {
        // shapes -> audio -> effects -> shapes; add effects to transformer.effects
        this.transformer = new XYTransformer();

        this.loopFreq = 5;      // Hz: lower gives the drawing more samples
        this.beamSize = 3;      // beam radius, px
        this.beamIntensity = 1; // brightness of a stroke drawn at an even speed
        this.parameters = new XYParameterGroup('scope');
        this.parameters.add(this, 'loopFreq', 'loop Hz', 1, 100);
        this.parameters.add(this, 'beamSize', 'beam size', 0.5, 12);
        this.parameters.add(this, 'beamIntensity', 'beam intensity', 0, 4);

        this.stats = {
            pieces: 0,
            dropped: 0,    // pieces left out because the loop is too short
            samples: 0,    // per loop
            pathLength: 0, // px
            ms: 0          // projecting, encoding and transforming
        };

        this.sampleRate = sampleRate;
        this.freq = 5;
        this.cycleFrames = 8820;
        this.canvasW = 0;
        this.canvasH = 0;

        // pieces of strokes, in canvas px: { points, color, key, length, start, lit }
        // start is the first sample (blanked, on the first point), then lit samples from end to end
        this.pieces = [];
        // one loop of the altered audio
        this.x = new Float32Array(0);
        this.y = new Float32Array(0);
        this.z = new Float32Array(0);

        // the altered audio drawn by the oscilloscope beam: one mesh per colour
        this.beams = new Group();
        this.meshes = [];
        this.beamExposure = 1;
        this.beamsDirty = true;

        // the altered audio decoded back into strokes
        this.strokes = new XYShapes();
        this.decoded = [];
        this.strokePieces = []; // the piece each stroke was decoded from
        this.strokesDirty = true;
    }

    getFreq() {
        return this.freq;
    }

    // Projects, encodes and transforms the current frame of each layer, as the
    // camera sees it, onto a width x height canvas.
    update(latk, camera, width, height) {
        const start = performance.now();
        this.beamsDirty = true;
        this.strokesDirty = true;
        if (width < 1 || height < 1) return;

        // The loop is a whole number of samples, so XYscope plays it back one
        // table entry per sample.
        this.cycleFrames = Math.max(2, Math.round(this.sampleRate / Math.max(0.1, this.loopFreq)));
        this.freq = this.sampleRate / this.cycleFrames;
        if (width !== this.canvasW || height !== this.canvasH || this.freq !== this.transformer.getFreq()) {
            this.transformer.setup(width, height, this.sampleRate, this.freq);
        }
        this.canvasW = width;
        this.canvasH = height;

        // The camera's matrix, computed once, as Vector3.project() would for every point.
        camera.updateMatrixWorld();
        const mvp = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this.project(latk, mvp.elements);
        this.encode();
        this.stats.ms = performance.now() - start;
    }

    project(latk, m) {
        this.pieces = [];
        const w = this.canvasW, h = this.canvasH;

        for (const layer of latk.layers) {
            const frame = layer.frames[layer.counter];
            if (!frame) continue;

            for (const stroke of frame.strokes) {
                // 8-bit, as ofxLatk keeps them
                const color = [Math.floor(255 * stroke.color[0]), Math.floor(255 * stroke.color[1]), Math.floor(255 * stroke.color[2])];
                const key = (color[0] << 16) | (color[1] << 8) | color[2];
                let open = false; // whether the next segment continues the last piece
                let lastValid = false;
                let lastX = 0, lastY = 0;
                for (const p of stroke.points) {
                    const [x, y, z] = p.co;
                    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
                    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
                    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
                    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
                    // Behind the camera or outside its depth range: break the stroke here.
                    const valid = cw > 0 && cz / cw >= -1 && cz / cw <= 1;
                    const sx = (cx / cw + 1) * 0.5 * w;
                    const sy = (1 - cy / cw) * 0.5 * h;

                    const t = valid && lastValid ? clipSegment(lastX, lastY, sx, sy, w, h) : null;
                    if (t) {
                        // The canvas is the scope's canvas, and past its edges the audio
                        // would clip, so cut the stroke where it leaves the canvas.
                        const ax = lastX + (sx - lastX) * t[0], ay = lastY + (sy - lastY) * t[0];
                        const bx = lastX + (sx - lastX) * t[1], by = lastY + (sy - lastY) * t[1];
                        if (!open || t[0] > 0) {
                            this.pieces.push({ points: [{ x: ax, y: ay }], color, key, length: 0, start: 0, lit: 0 });
                        }
                        const piece = this.pieces[this.pieces.length - 1];
                        piece.points.push({ x: bx, y: by });
                        piece.length += Math.hypot(bx - ax, by - ay);
                        open = t[1] === 1;
                    } else {
                        open = false;
                    }
                    lastX = sx;
                    lastY = sy;
                    lastValid = valid;
                }
            }
        }

        this.stats.pathLength = 0;
        for (const piece of this.pieces) this.stats.pathLength += piece.length;
    }

    encode() {
        const n = this.cycleFrames;
        const w = this.canvasW, h = this.canvasH;
        this.stats.samples = n;
        this.stats.dropped = 0;

        // Every piece takes a blank sample that jumps the beam to its start, and at
        // least two lit ones, for its ends. If the loop is too short for that, the
        // shortest pieces are left out.
        const maxPieces = Math.floor(n / 3);
        if (this.pieces.length > maxPieces) {
            // a stable sort, so equal lengths keep their order
            const order = this.pieces.map((piece, i) => i).sort((a, b) => this.pieces[b].length - this.pieces[a].length);
            const keep = new Uint8Array(this.pieces.length);
            for (let i = 0; i < maxPieces; i++) keep[order[i]] = 1;
            const kept = this.pieces.filter((piece, i) => keep[i] === 1);
            this.stats.dropped = this.pieces.length - kept.length;
            this.pieces = kept;
        }
        this.stats.pieces = this.pieces.length;

        // The rest of the loop is shared out by length, so the beam moves at an
        // even speed, as it does in XYscope's waveforms.
        let totalLength = 0;
        for (const piece of this.pieces) totalLength += piece.length;
        const spare = n - 3 * this.pieces.length;

        // one loop in XYscope's format: X, Y and Z interleaved, the canvas mapped
        // to -1..1 with +Y up, and Z blanking the beam between pieces
        const levels = this.transformer.decoder;
        const cycle = new Float32Array(n * 3);
        let i = 0;
        const write = (x, y, lit) => {
            cycle[i * 3] = x / w * 2 - 1;
            cycle[i * 3 + 1] = 1 - y / h * 2;
            cycle[i * 3 + 2] = lit ? levels.zMax : levels.zMin;
            i++;
        };

        let before = 0; // length of the pieces so far
        for (let k = 0; k < this.pieces.length; k++) {
            const piece = this.pieces[k];
            const pts = piece.points;
            // rounded from running totals, so the shares add up to exactly the spare samples
            const after = before + piece.length;
            let share;
            if (totalLength > 0) {
                share = Math.round(spare * after / totalLength) - Math.round(spare * before / totalLength);
            } else {
                share = Math.floor(spare * (k + 1) / this.pieces.length) - Math.floor(spare * k / this.pieces.length);
            }
            before = after;

            piece.start = i;
            piece.lit = 2 + share;
            write(pts[0].x, pts[0].y, false);

            // lit samples at even steps along the piece, from its first point to its last
            let seg = 0;
            let segStart = 0; // length along the piece to points[seg]
            let segLength = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
            for (let j = 0; j < piece.lit; j++) {
                const at = piece.length * j / (piece.lit - 1);
                while (seg + 2 < pts.length && segStart + segLength < at) {
                    segStart += segLength;
                    seg++;
                    segLength = Math.hypot(pts[seg + 1].x - pts[seg].x, pts[seg + 1].y - pts[seg].y);
                }
                const t = segLength > 0 ? Math.min(1, Math.max(0, (at - segStart) / segLength)) : 1;
                write(pts[seg].x + (pts[seg + 1].x - pts[seg].x) * t, pts[seg].y + (pts[seg + 1].y - pts[seg].y) * t, true);
            }
        }
        // with nothing to draw, the beam rests blanked in the middle
        while (i < n) write(w / 2, h / 2, false);

        // XYTransformer runs the effects over a few loops, so that filters and
        // echoes settle, and keeps the last one.
        const loops = Math.max(0, this.transformer.settleCycles) + 1;
        const encoded = new XYSoundBuffer(n * loops, 3, this.sampleRate);
        for (let l = 0; l < loops; l++) encoded.samples.set(cycle, l * cycle.length);
        this.transformer.transform(encoded);
        const waves = this.transformer.getProcessedWaves();
        this.x = waves.x;
        this.y = waves.y;
        this.z = waves.z;
    }

    // Rebuild the beams from the last update().
    buildBeams() {
        if (!this.beamsDirty) return;
        this.beamsDirty = false;
        for (const mesh of this.meshes) mesh.visible = false;
        if (this.x.length !== this.cycleFrames) return;

        // Scope units: -1..1 up the canvas, and as far across it as its shape
        // allows, so the beam stays round in any window.
        const aspect = this.canvasW / this.canvasH;
        const sx = new Float32Array(this.x.length);
        for (let i = 0; i < this.x.length; i++) sx[i] = this.x[i] * aspect;
        const size = this.beamSize / (this.canvasH / 2);

        // OsciMesh joins each run of samples to the end of the last one, lit as
        // the run's first sample. Keep that jump dark.
        const bright = new Float32Array(this.x.length).fill(1);
        bright[0] = 0;

        // One mesh per colour: the beams add up, so the drawing order doesn't matter.
        const meshOfColor = new Map();
        let stepSum = 0;
        let steps = 0;
        for (const piece of this.pieces) {
            let mesh = meshOfColor.get(piece.key);
            if (!mesh) {
                const index = meshOfColor.size;
                if (index === this.meshes.length) {
                    mesh = new OsciMesh();
                    this.meshes.push(mesh);
                    this.beams.add(mesh);
                }
                mesh = this.meshes[index];
                mesh.clear();
                mesh.visible = true;
                mesh.uSize = size;
                mesh.uRgb.setRGB(piece.color[0] / 255, piece.color[1] / 255, piece.color[2] / 255);
                // scope +Y is up, the canvas's pixels go down
                mesh.position.set(this.canvasW / 2, this.canvasH / 2, 0);
                mesh.scale.set(this.canvasH / 2, -this.canvasH / 2, 1);
                meshOfColor.set(piece.key, mesh);
            }
            const first = piece.start + 1;
            mesh.addLines(sx.subarray(first), this.y.subarray(first), bright, piece.lit);
            for (let i = first + 1; i < first + piece.lit; i++) {
                stepSum += Math.hypot(sx[i] - sx[i - 1], this.y[i] - this.y[i - 1]);
                steps++;
            }
        }

        // A beam leaves less light on a line the faster it moves, so a longer
        // drawing or a shorter loop comes out dimmer. Scale the light by the
        // average step, so a stroke peaks at about beamIntensity either way.
        const sigma = size / 3;
        this.beamExposure = steps > 0 ? (stepSum / steps) / (sigma * Math.sqrt(2 * Math.PI)) : 1;
        for (const mesh of this.meshes) mesh.uIntensity = this.beamIntensity * this.beamExposure;
    }

    decodeStrokes() {
        this.strokesDirty = false;
        this.decoded = [];
        this.strokePieces = [];
        if (this.x.length !== this.cycleFrames) return;

        const settings = this.transformer.decoder.copy();
        settings.width = this.canvasW;
        settings.height = this.canvasH;
        settings.sampleRate = this.sampleRate;
        settings.freq = this.freq;
        for (const piece of this.pieces) {
            // Each piece's samples, blank and all, decoded on their own so that
            // whatever the effects made of them keeps the piece's colour.
            const s = piece.start;
            const e = piece.start + piece.lit + 1;
            const z = this.z.length > 0 ? this.z.subarray(s, e) : null;
            for (const line of XYDecoder.decodeCycle(this.x.subarray(s, e), this.y.subarray(s, e), z, e - s, settings)) {
                this.decoded.push(line);
                this.strokePieces.push(piece);
            }
        }
    }

    // The decoded strokes, on a canvas the size of the viewport.
    getStrokes() {
        if (this.strokesDirty) this.decodeStrokes();
        return this.decoded;
    }

    // Rebuild the decoded strokes from the last update(), each in its piece's colour.
    buildStrokes() {
        const strokes = this.getStrokes();
        const color = new Color();
        this.strokes.setShapes(strokes, (i) => {
            const c = this.strokePieces[i].color;
            return color.setRGB(c[0] / 255, c[1] / 255, c[2] / 255, SRGBColorSpace);
        });
    }

}

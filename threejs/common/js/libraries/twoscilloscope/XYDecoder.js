/*
+ + +   three.twoscilloscope   + + +
*/

import { Vector2 } from 'three';
import { XYPolyline } from './XYPolyline.js';
import { XYSoundBuffer } from './XYSoundBuffer.js';
import { clamp, saveBlob } from './XYUtils.js';

/*
Turns XY audio back into vector shapes: XYPolylines on an XYscope-style
canvas (pixels, y down).

The Oscilloscope app only ever drew the beam. This goes one step further and
recovers the drawing itself, the inverse of XYscope.buildWaves():

1. Find the period: the signal loops at XYscope's freq(), so the shape is one
   cycle long. Given freq it's sampleRate / freq; otherwise it's found with
   the YIN difference function.
2. Take the most recent full cycle and map each sample to the canvas:
   px = (x + 1) / 2 * width,  py = (1 - y) / 2 * height.
3. Cut it into strokes wherever the beam blanks (Z below zThreshold, when
   there's a Z channel) or jumps (a step much longer than the typical one,
   which is XYscope's pen moving from one shape to the next).
4. Join the stroke that runs off the end of the cycle back onto the one at
   the start, since the cycle loops, then simplify each stroke.

Differences from ofxTwoscilloscope: the signal comes as Float32Arrays (or an
XYSoundBuffer), and saveSvg() downloads the file.
*/
export class XYDecoderSettings {

    constructor() {
        // the canvas the shapes are mapped to
        this.width = 512;
        this.height = 512;

        this.sampleRate = 44100;
        // loop frequency of the signal (XYscope's freq()), 0 to detect it
        this.freq = 0;
        // range searched when detecting
        this.minFreq = 20;
        this.maxFreq = 1000;

        // strokes break where a step is longer than this many pixels...
        this.jumpThreshold = 0;
        // ...or, when jumpThreshold is 0, longer than jumpFactor x the median step
        this.jumpFactor = 8;

        // with a Z channel, break the strokes where the beam is blanked
        this.useZ = true;
        this.zMin = -1;          // XYscope's blanked level
        this.zMax = 1;           // XYscope's beam-on level
        this.zThreshold = 0.5;   // 0..1 between zMin and zMax

        // close strokes whose ends are this close (pixels): 0 for 2.5 x the median step, -1 never
        this.closeThreshold = 0;

        // Douglas-Peucker tolerance in pixels, 0 keeps every sample
        this.simplify = 0.5;
        // strokes with fewer points than this are dropped
        this.minPoints = 2;
        // shorter strokes than this (in pixels) are dropped
        this.minLength = 0;
    }

    copy() {
        return Object.assign(new XYDecoderSettings(), this);
    }

}

function decodeSamples(x, y, z, n, s, cyclic) {
    const result = [];
    if (n < 2) return result;

    // samples -> canvas, inverting XYscope's mapping
    const ptsX = new Float64Array(n), ptsY = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        ptsX[i] = (x[i] + 1) * 0.5 * s.width;
        ptsY[i] = (1 - y[i]) * 0.5 * s.height;
    }

    const blank = new Uint8Array(n);
    if (z && s.useZ && s.zMax !== s.zMin) {
        for (let i = 0; i < n; i++) blank[i] = (z[i] - s.zMin) / (s.zMax - s.zMin) < s.zThreshold ? 1 : 0;
    }

    // step[i] is the distance from the previous sample (wrapping, for a loop)
    const step = new Float64Array(n);
    for (let i = 1; i < n; i++) step[i] = Math.hypot(ptsX[i] - ptsX[i - 1], ptsY[i] - ptsY[i - 1]);
    step[0] = cyclic ? Math.hypot(ptsX[0] - ptsX[n - 1], ptsY[0] - ptsY[n - 1]) : 0;

    const moving = [];
    for (let i = 1; i < n; i++) {
        if (step[i] > 1e-4 && !blank[i]) moving.push(step[i]);
    }
    let median = 0;
    if (moving.length > 0) {
        moving.sort((a, b) => a - b);
        median = moving[Math.floor(moving.length / 2)];
    }
    const threshold = s.jumpThreshold > 0 ? s.jumpThreshold : Math.max(1, s.jumpFactor * median);
    const closeThreshold = s.closeThreshold > 0 ? s.closeThreshold : 2.5 * median;

    // walk the samples, cutting at blanks and jumps
    const strokes = []; // { start, end (inclusive), points: [indices] }
    let open = false;
    for (let i = 0; i < n; i++) {
        if (blank[i]) {
            // the beam is still where the stroke ended when it blanks
            // (XYscope blanks right on a shape's last point), so keep that spot
            if (open && step[i] <= threshold) {
                const last = strokes[strokes.length - 1];
                last.points.push(i);
                last.end = i;
            }
            open = false;
            continue;
        }
        if (open && step[i] > threshold) open = false;
        if (!open) {
            strokes.push({ start: i, end: i, points: [] });
            open = true;
        }
        const last = strokes[strokes.length - 1];
        last.points.push(i);
        last.end = i;
    }

    // the cycle loops, so a stroke running off the end continues at the start
    const joined = cyclic && !blank[0] && !blank[n - 1] && step[0] <= threshold;
    let closedLoop = false;
    if (joined && strokes.length > 0 && strokes[0].start === 0 && strokes[strokes.length - 1].end === n - 1) {
        if (strokes.length > 1) {
            const last = strokes[strokes.length - 1];
            last.points = last.points.concat(strokes[0].points);
            strokes.shift();
        } else {
            closedLoop = true; // one unbroken loop
        }
    }

    for (const stroke of strokes) {
        const poly = new XYPolyline();
        const pts = poly.points;
        for (const i of stroke.points) {
            const prev = pts[pts.length - 1];
            if (pts.length === 0 || Math.hypot(prev.x - ptsX[i], prev.y - ptsY[i]) > 1e-3) {
                pts.push(new Vector2(ptsX[i], ptsY[i]));
            }
        }
        // XYscope blanks a closed shape's last point, which leaves a gap of a sample or two
        if (closedLoop || (s.closeThreshold >= 0 && pts.length > 3 &&
            Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) <= closeThreshold)) {
            poly.setClosed(true);
        }
        if (s.simplify > 0 && poly.size() > 2) poly.simplify(s.simplify);
        if (poly.size() < s.minPoints) continue;
        if (s.minLength > 0 && poly.getPerimeter() < s.minLength) continue;
        result.push(poly);
    }

    return result;
}

// After YIN (de Cheveigné & Kawahara 2002), on both channels at once.
function yinPeriod(x, y, n, minPeriod, maxPeriod) {
    const minLag = Math.max(2, Math.floor(minPeriod));
    const maxLag = Math.min(Math.floor(n / 2), Math.ceil(maxPeriod));
    if (maxLag <= minLag + 1) return 0;

    // compare the most recent window against itself, shifted by up to maxLag + 1
    const window = Math.min(n - maxLag - 1, 2048);
    const t0 = n - maxLag - 1 - window;
    if (window < 1) return 0;

    let energy = 0;
    for (let t = t0; t < t0 + window; t++) energy += x[t] * x[t] + y[t] * y[t];
    if (energy < 1e-9 * window) return 0; // silence

    const d = new Float64Array(maxLag + 2);
    for (let tau = 1; tau <= maxLag + 1; tau++) {
        let sum = 0;
        for (let t = t0; t < t0 + window; t++) {
            const dx = x[t] - x[t + tau];
            const dy = y[t] - y[t + tau];
            sum += dx * dx + dy * dy;
        }
        d[tau] = sum;
    }

    // cumulative mean normalized difference
    const dn = new Float64Array(maxLag + 2).fill(1);
    let running = 0;
    for (let tau = 1; tau <= maxLag + 1; tau++) {
        running += d[tau];
        dn[tau] = running > 0 ? d[tau] * tau / running : 1;
    }

    let best = -1;
    const threshold = 0.1;
    for (let tau = minLag; tau <= maxLag; tau++) {
        if (dn[tau] < threshold) {
            while (tau + 1 <= maxLag && dn[tau + 1] < dn[tau]) tau++;
            best = tau;
            break;
        }
    }
    if (best < 0) {
        best = minLag;
        for (let tau = minLag; tau <= maxLag; tau++) {
            if (dn[tau] < dn[best]) best = tau;
        }
        if (dn[best] > 0.5) return 0; // not periodic enough to trust
    }

    // parabolic interpolation for a fractional period
    let refined = best;
    if (best > 1 && best < maxLag + 1) {
        const a = dn[best - 1], b = dn[best], c = dn[best + 1];
        const denom = a - 2 * b + c;
        if (Math.abs(denom) > 1e-12) refined = best + 0.5 * (a - c) / denom;
    }
    return refined;
}

export const XYDecoder = {

    // decode(x, y, z, n, settings): the latest full cycle of a signal. z can be null.
    // decode(buffer, settings): an XYSoundBuffer, X on channel 0, Y on 1, Z on 2
    // (if any). Mono buffers decode with the signal on Y, the way the
    // Oscilloscope app draws them.
    decode(x, y, z, n, settings) {
        if (x instanceof XYSoundBuffer) return XYDecoder.decodeBuffer(x, y || new XYDecoderSettings());
        let period;
        if (settings.freq > 0) {
            period = settings.sampleRate / settings.freq;
        } else {
            period = XYDecoder.detectPeriod(x, y, n, settings.sampleRate / Math.max(1, settings.maxFreq),
                settings.sampleRate / Math.max(1, settings.minFreq));
        }

        const m = Math.round(period);
        if (m < 2 || m > n) {
            // nothing loops: decode everything we have, as one open run
            return decodeSamples(x, y, z, n, settings, false);
        }

        const start = n - m;
        return decodeSamples(x.subarray(start), y.subarray(start), z ? z.subarray(start) : null, m, settings, true);
    },

    decodeBuffer(buffer, settings) {
        settings = settings.copy();
        const nCh = buffer.numChannels;
        const n = buffer.numFrames;
        if (nCh === 0 || n === 0) return [];
        if (buffer.sampleRate > 0) settings.sampleRate = buffer.sampleRate;
        const samples = buffer.samples;

        const x = new Float32Array(n), y = new Float32Array(n);
        if (nCh === 1) {
            // a mono signal is a waveform: time across, signal up
            for (let i = 0; i < n; i++) {
                x[i] = -1 + 2 * i / Math.max(1, n - 1);
                y[i] = samples[i];
            }
            return decodeSamples(x, y, null, n, settings, false);
        }

        for (let i = 0; i < n; i++) {
            x[i] = samples[i * nCh];
            y[i] = samples[i * nCh + 1];
        }
        let z = null;
        if (nCh === 3) {
            z = new Float32Array(n);
            for (let i = 0; i < n; i++) z[i] = samples[i * nCh + 2];
        }
        return XYDecoder.decode(x, y, z, n, settings);
    },

    // Decode exactly these samples as one loop, no period detection.
    decodeCycle(x, y, z, n, settings) {
        return decodeSamples(x, y, z, n, settings, true);
    },

    // Period in samples (fractional), or 0 if nothing periodic was found.
    detectPeriod(x, y, n, minPeriod, maxPeriod) {
        // Search a decimated copy first, so long periods stay cheap...
        const factor = Math.max(1, Math.ceil(maxPeriod / 512));
        if (factor === 1) return yinPeriod(x, y, n, minPeriod, maxPeriod);

        const m = Math.floor(n / factor);
        const offset = n - m * factor; // line the blocks up with the newest sample
        const xd = new Float32Array(m), yd = new Float32Array(m);
        for (let i = 0; i < m; i++) {
            let sx = 0, sy = 0;
            for (let k = 0; k < factor; k++) {
                sx += x[offset + i * factor + k];
                sy += y[offset + i * factor + k];
            }
            xd[i] = sx / factor;
            yd[i] = sy / factor;
        }
        const coarse = yinPeriod(xd, yd, m, minPeriod / factor, maxPeriod / factor);
        if (coarse <= 0) return 0;

        // ...then refine around its answer at full resolution.
        const center = Math.round(coarse * factor);
        const lo = Math.max(2, center - 2 * factor);
        const hi = center + 2 * factor;
        const window = Math.min(n - hi - 2, 1024);
        if (window < 64) return coarse * factor;
        const t0 = n - hi - 2 - window;

        const d = new Float64Array(hi - lo + 3);
        for (let tau = lo - 1; tau <= hi + 1; tau++) {
            if (tau < 1) continue;
            let sum = 0;
            for (let t = t0; t < t0 + window; t++) {
                const dx = x[t] - x[t + tau];
                const dy = y[t] - y[t + tau];
                sum += dx * dx + dy * dy;
            }
            d[tau - lo + 1] = sum;
        }
        let best = lo;
        for (let tau = lo; tau <= hi; tau++) {
            if (d[tau - lo + 1] < d[best - lo + 1]) best = tau;
        }
        const a = d[best - lo], b = d[best - lo + 1], c = d[best - lo + 2];
        const denom = a - 2 * b + c;
        let refined = best;
        if (best - 1 >= 1 && Math.abs(denom) > 1e-12) refined = best + 0.5 * (a - c) / denom;
        return refined;
    },

    // How well the end of the signal repeats after period samples:
    // 0 for a perfect loop, around 1 for no relation at all.
    periodError(x, y, n, period) {
        const p = Math.round(period);
        if (p < 1 || p + 16 > n) return 1;
        const window = Math.min(n - p, 1024);
        const t0 = n - p - window;

        let mx = 0, my = 0;
        for (let t = t0; t < t0 + window + p; t++) {
            mx += x[t];
            my += y[t];
        }
        mx /= window + p;
        my /= window + p;

        let diff = 0, energy = 0;
        for (let t = t0; t < t0 + window; t++) {
            const ax = x[t] - mx, ay = y[t] - my;
            const bx = x[t + p] - mx, by = y[t + p] - my;
            diff += (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
            energy += ax * ax + ay * ay + bx * bx + by * by;
        }
        return energy > 1e-12 ? diff / energy : 1;
    },

    // Shapes as an SVG of open (or closed) paths. stroke is [r, g, b], 0..255.
    toSvg(shapes, width, height, stroke = [0, 0, 0], strokeWidth = 1) {
        const hex = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
        const color = '#' + hex(stroke[0]) + hex(stroke[1]) + hex(stroke[2]);
        let svg = '<?xml version="1.0" encoding="UTF-8"?>\n';
        svg += '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height +
            '" viewBox="0 0 ' + width + ' ' + height + '">\n';
        for (const shape of shapes) {
            const poly = XYPolyline.from(shape);
            const verts = poly.points;
            if (verts.length < 2) continue;
            svg += '  <path fill="none" stroke="' + color + '" stroke-width="' + strokeWidth +
                '" stroke-linecap="round" stroke-linejoin="round" d="M';
            for (let i = 0; i < verts.length; i++) {
                svg += (i === 0 ? ' ' : ' L ') + verts[i].x.toFixed(2) + ' ' + verts[i].y.toFixed(2);
            }
            if (poly.closed) svg += ' Z';
            svg += '"/>\n';
        }
        svg += '</svg>\n';
        return svg;
    },

    // Download shapes as an SVG.
    saveSvg(filename, shapes, width, height, stroke = [0, 0, 0], strokeWidth = 1) {
        saveBlob(new Blob([XYDecoder.toSvg(shapes, width, height, stroke, strokeWidth)], { type: 'image/svg+xml' }), filename);
        return true;
    }

};

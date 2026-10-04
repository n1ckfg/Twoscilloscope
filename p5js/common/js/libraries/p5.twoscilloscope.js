/*
+ + +   p5.twoscilloscope: vectors to audio, audio to vectors, and back   + + +
+ + +   Nick Fox-Gieg  https://fox-gieg.com                                + + +

A p5.js port of ofxTwoscilloscope, which joins two oscilloscope projects at
the audio:

    XYscope        vector shapes -> XY audio, ported from XYscope (Processing)
    Oscilloscope   XY audio -> beam rendering + vector shapes, ported from Oscilloscope (oF)
    XYTransformer  vector shape -> audio -> effects -> new vector shape

    let xy, scope, xform;

    function setup() {
        createCanvas(512, 512);
        xy = new XYscope();
        xy.setup();
        xy.openAudioOut();               // plays after the first click or key press

        scope = new Oscilloscope();
        scope.setup(512, 512);
        xy.onAudioOut = (buffer) => scope.addBuffer(buffer);

        xform = new XYTransformer();
        xform.setup(512, 512);
        xform.effects.add(new XYLowPass());
    }

    function draw() {
        xy.clearWaves();
        xy.circle(256, 256, 200);
        xy.buildWaves();

        scope.update();
        scope.draw();
        let shapes = scope.getShapes(512, 512);
        let altered = xform.transform(shapes);
    }

What it's built on: p5.js and the browser, nothing else.
* p5.js draws everything, gives the beam renderer a WEBGL p5.Graphics of its
  own, and builds the effect panel out of its DOM functions.
* The Web Audio API makes the sound. An AudioWorklet runs XYscope's
  oscillators on the audio thread, which is the job ofSoundStream did. An
  AudioBufferSourceNode plays files for XYPlayer, and getUserMedia is the
  line input.
* Plain JavaScript does the rest: the effects, the decoder and WAV files.
  p5.sound, Tone.js and genish.js aren't needed. XYTransformer has to run its
  effects synchronously, sample by sample, inside an encode -> effects ->
  decode round trip every frame, and a Web Audio graph can't do that.

Differences from ofxTwoscilloscope (each section lists its own):
* Browsers start audio only after a click or a key press. Until then,
  isAudioRunning() is false and a sketch keeps things moving on the frame
  clock with XYscope.process() and XYPlayer.update().
* Fonts and WAVs are fetched, so serve the sketch over http (see run.command).
  Recordings, WAVs and SVGs are saved as downloads.
* There's one thread for the sketch. The audio thread only synthesizes, and
  sends what it played back in blocks, so nothing needs a mutex.
* ofParameters are plain properties (effect.cutoff = 1500), listed in an
  XYParameterGroup so XYPanel can build sliders for them, as ofxGui did.

LGPL v3, as ofxTwoscilloscope: XYscope, XYWavetable and HersheyFont are
ports of XYscope by Ted Davis (https://teddavis.org/xyscope). The parts from
Hansi Raber's Oscilloscope (https://github.com/kritzikratzi/Oscilloscope) are
also MIT licensed.
*/

(function () {

'use strict';

if (typeof p5 === 'undefined') {
    console.warn('p5.twoscilloscope: load p5.js before this library');
}

const VERSION = '1.0.0';

// where this file lives, so the Hershey fonts can be found next to it
const SCRIPT_URL = document.currentScript && document.currentScript.src ? document.currentScript.src : window.location.href;

//==============================================================
// helpers
//==============================================================

const PI = Math.PI;
const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

function degToRad(degrees) {
    return degrees * PI / 180;
}

// ofMap without clamping
function mapValue(v, inMin, inMax, outMin, outMax) {
    return outMin + (v - inMin) / (inMax - inMin) * (outMax - outMin);
}

// A date and time as text, like ofGetTimestampString():
// %Y year, %m month, %d day, %H hours, %M minutes, %S seconds, %i milliseconds
function timestamp(format = '%Y-%m-%d-%H-%M-%S-%i') {
    const d = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const codes = {
        Y: d.getFullYear(), m: pad(d.getMonth() + 1), d: pad(d.getDate()),
        H: pad(d.getHours()), M: pad(d.getMinutes()), S: pad(d.getSeconds()), i: pad(d.getMilliseconds(), 3)
    };
    return format.replace(/%([YmdHMSi])/g, (match, code) => codes[code]);
}

// Hand the browser a file to save.
function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// HSB (all 0..1) to RGB (0..1), like ofFloatColor::fromHsb()
function hsbToRgb(h, s, v) {
    h = (h - Math.floor(h)) * 6;
    const i = Math.floor(h);
    const f = h - i;
    const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    switch (i % 6) {
        case 0: return [v, t, p];
        case 1: return [q, v, p];
        case 2: return [p, v, t];
        case 3: return [p, q, v];
        case 4: return [t, p, v];
        default: return [v, p, q];
    }
}

// The sketch the library draws into, when no other target is given.
// Caught as the sketch starts, so it works in global and instance mode.
let p5Instance = null;

function getP5() {
    if (p5Instance) return p5Instance;
    if (typeof p5 !== 'undefined' && p5.instance) return p5.instance;
    return null;
}

function getTarget(target) {
    const g = target || getP5();
    if (!g) throw new Error('p5.twoscilloscope: there is no p5 sketch to draw into yet');
    return g;
}

function sketchMouseX() {
    const p = getP5();
    return p ? p.mouseX : 0;
}

// {x, y}, [x, y] and p5.Vector all work as points
function px(p) {
    return Array.isArray(p) ? p[0] : p.x;
}

function py(p) {
    return Array.isArray(p) ? p[1] : p.y;
}

function pz(p) {
    const z = Array.isArray(p) ? p[2] : p.z;
    return z === undefined ? 0 : z;
}

//==============================================================
// XYFloatArray: a Float32Array that grows, in place of std::vector<float>
//==============================================================

class XYFloatArray {

    constructor(capacity = 1024) {
        this.data = new Float32Array(Math.max(1, capacity));
        this.length = 0;
    }

    reserve(n) {
        if (n <= this.data.length) return;
        let capacity = this.data.length;
        while (capacity < n) capacity *= 2;
        const data = new Float32Array(capacity);
        data.set(this.data.subarray(0, this.length));
        this.data = data;
    }

    push(v) {
        if (this.length === this.data.length) this.reserve(this.length + 1);
        this.data[this.length++] = v;
    }

    append(src, start = 0, end = src.length) {
        const n = end - start;
        if (n <= 0) return;
        this.reserve(this.length + n);
        this.data.set(src.subarray ? src.subarray(start, end) : src.slice(start, end), this.length);
        this.length += n;
    }

    eraseFront(n) {
        n = Math.min(n, this.length);
        if (n <= 0) return;
        this.data.copyWithin(0, n, this.length);
        this.length -= n;
    }

    clear() {
        this.length = 0;
    }

    // the contents, without copying (valid until the array changes)
    view() {
        return this.data.subarray(0, this.length);
    }

    toArray() {
        return this.data.slice(0, this.length);
    }

}

//==============================================================
// XYSoundBuffer: interleaved audio, in place of ofSoundBuffer
//==============================================================

class XYSoundBuffer {

    constructor(numFrames = 0, numChannels = 1, sampleRate = 44100) {
        this.numChannels = Math.max(1, numChannels | 0);
        this.sampleRate = sampleRate;
        this.samples = new Float32Array(Math.max(0, Math.floor(numFrames)) * this.numChannels);
    }

    // a buffer around samples that already exist, without copying them
    static wrap(samples, numChannels, sampleRate) {
        const buffer = new XYSoundBuffer(0, numChannels, sampleRate);
        buffer.samples = samples;
        return buffer;
    }

    get numFrames() {
        return Math.floor(this.samples.length / this.numChannels);
    }

    getNumFrames() { return this.numFrames; }
    getNumChannels() { return this.numChannels; }
    getSampleRate() { return this.sampleRate; }
    getDuration() { return this.sampleRate > 0 ? this.numFrames / this.sampleRate : 0; }

    allocate(numFrames, numChannels = this.numChannels) {
        this.numChannels = Math.max(1, numChannels | 0);
        this.samples = new Float32Array(Math.max(0, Math.floor(numFrames)) * this.numChannels);
        return this;
    }

    set(value = 0) {
        this.samples.fill(value);
        return this;
    }

    copy() {
        return XYSoundBuffer.wrap(this.samples.slice(), this.numChannels, this.sampleRate);
    }

    // one channel, deinterleaved
    getChannel(channel) {
        const n = this.numFrames;
        const out = new Float32Array(n);
        if (channel < 0 || channel >= this.numChannels) return out;
        for (let i = 0; i < n; i++) out[i] = this.samples[i * this.numChannels + channel];
        return out;
    }

}

//==============================================================
// XYPolyline: a run of points, in place of ofPolyline
//==============================================================

// Douglas-Peucker on vt[j..k], marking the points to keep in mk. ofPolyline's
// recursion, with a stack of its own so long strokes can't overflow.
function simplifyDP(tol2, vt, j0, k0, mk) {
    const stack = [j0, k0];
    while (stack.length > 0) {
        const k = stack.pop();
        const j = stack.pop();
        if (k <= j + 1) continue; // there is nothing to simplify

        // check for adequate approximation by segment S from vt[j] to vt[k]
        const p0 = vt[j], p1 = vt[k];
        const ux = p1.x - p0.x, uy = p1.y - p0.y;
        const cu = ux * ux + uy * uy; // segment length squared
        let maxi = j;
        let maxd2 = 0;
        for (let i = j + 1; i < k; i++) {
            const v = vt[i];
            const wx = v.x - p0.x, wy = v.y - p0.y;
            const cw = wx * ux + wy * uy;
            let dv2;
            if (cw <= 0) {
                dv2 = wx * wx + wy * wy;
            } else if (cu <= cw) {
                const dx = v.x - p1.x, dy = v.y - p1.y;
                dv2 = dx * dx + dy * dy;
            } else {
                const b = cw / cu;
                const dx = v.x - (p0.x + ux * b), dy = v.y - (p0.y + uy * b);
                dv2 = dx * dx + dy * dy;
            }
            if (dv2 <= maxd2) continue;
            maxi = i;
            maxd2 = dv2;
        }
        if (maxd2 > tol2) {
            // split at the farthest point and simplify both halves
            mk[maxi] = 1;
            stack.push(j, maxi, maxi, k);
        }
    }
}

class XYPolyline {

    // points: {x, y}, [x, y] or p5.Vector
    constructor(points, closed = false) {
        this.points = [];
        this.closed = closed;
        if (points) {
            for (const p of points) this.points.push({ x: px(p), y: py(p) });
        }
    }

    // An XYPolyline as is, or a new one from an array of points.
    static from(shape) {
        if (shape instanceof XYPolyline) return shape;
        if (shape && Array.isArray(shape.points)) return new XYPolyline(shape.points, !!shape.closed);
        return new XYPolyline(shape || []);
    }

    addVertex(x, y) {
        if (typeof x === 'object') {
            y = py(x);
            x = px(x);
        }
        this.points.push({ x, y });
        return this;
    }

    getVertices() { return this.points; }
    size() { return this.points.length; }
    isClosed() { return this.closed; }

    setClosed(closed) {
        this.closed = closed;
        return this;
    }

    clear() {
        this.points = [];
        return this;
    }

    copy() {
        return new XYPolyline(this.points, this.closed);
    }

    // length around the line, including the closing segment if it's closed
    getPerimeter() {
        const pts = this.points;
        if (pts.length < 2) return 0;
        let length = 0;
        for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        if (this.closed) length += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
        return length;
    }

    // ofPolyline::simplify(): drops points closer than tolerance to the one
    // before, then Douglas-Peucker with the same tolerance
    simplify(tolerance = 0.3) {
        const pts = this.points;
        const n = pts.length;
        if (n < 2) return this;
        const tol2 = tolerance * tolerance;

        // stage 1: vertex reduction within tolerance of prior vertex cluster
        const vt = [pts[0]];
        let pv = 0;
        for (let i = 1; i < n; i++) {
            const dx = pts[i].x - pts[pv].x, dy = pts[i].y - pts[pv].y;
            if (dx * dx + dy * dy < tol2) continue;
            vt.push(pts[i]);
            pv = i;
        }
        if (pv < n - 1) vt.push(pts[n - 1]);

        // stage 2: Douglas-Peucker polyline simplification
        const mk = new Uint8Array(vt.length);
        mk[0] = mk[vt.length - 1] = 1;
        simplifyDP(tol2, vt, 0, vt.length - 1, mk);
        this.points = vt.filter((p, i) => mk[i] === 1);
        return this;
    }

    // Draw with the current stroke, into the sketch or a p5.Graphics.
    draw(target) {
        const g = getTarget(target);
        g.beginShape();
        for (const p of this.points) g.vertex(p.x, p.y);
        g.endShape(this.closed ? 'close' : undefined);
    }

}

//==============================================================
// matrices: column-major mat4s like glm's, for XYscope's transform stack
//==============================================================

const Mat4 = {

    identity() {
        const m = new Float64Array(16);
        m[0] = m[5] = m[10] = m[15] = 1;
        return m;
    },

    multiply(a, b) {
        const o = new Float64Array(16);
        for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) {
                o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
            }
        }
        return o;
    },

    // glm::translate(m, v): m * T
    translate(m, x, y, z) {
        const o = m.slice();
        for (let r = 0; r < 4; r++) o[12 + r] = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r];
        return o;
    },

    // glm::scale(m, v): m * S
    scale(m, x, y, z) {
        const o = m.slice();
        for (let r = 0; r < 4; r++) {
            o[r] *= x;
            o[4 + r] *= y;
            o[8 + r] *= z;
        }
        return o;
    },

    // glm::rotate(m, angle, axis) for the x, y and z axes: m * R
    rotate(m, angle, axis) {
        const c = Math.cos(angle), s = Math.sin(angle);
        const r = Mat4.identity();
        if (axis === 0) {
            r[5] = c; r[6] = s; r[9] = -s; r[10] = c;
        } else if (axis === 1) {
            r[0] = c; r[2] = -s; r[8] = s; r[10] = c;
        } else {
            r[0] = c; r[1] = s; r[4] = -s; r[5] = c;
        }
        return Mat4.multiply(m, r);
    },

    // m * (x, y, z, 1)
    transform(m, x, y, z) {
        return [
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
            m[3] * x + m[7] * y + m[11] * z + m[15]
        ];
    }

};

//==============================================================
// XYParameterGroup: settings for a panel, in place of ofParameterGroup
//==============================================================

/*
ofParameters become plain properties here, so effect.cutoff = 1500 works
the way lowPass->cutoff = 1500 did. A group lists which properties are
settings, with a label and a range, and can hold other groups, which is
all XYPanel needs to build sliders and checkboxes for them.
*/
class XYParameterGroup {

    constructor(name = '') {
        this.name = name;
        this.items = [];
    }

    getName() {
        return this.name;
    }

    // add(object, key, label, min, max, type): object[key] is a setting.
    // type is 'float', 'int' or 'bool' (the default follows the value).
    // add(group) adds a group of settings.
    add(object, key, label = key, min = 0, max = 1, type) {
        if (object instanceof XYParameterGroup) {
            this.items.push({ type: 'group', group: object });
            return this;
        }
        if (type === undefined) type = typeof object[key] === 'boolean' ? 'bool' : 'float';
        this.items.push({ type, object, key, label, min, max });
        return this;
    }

    // a setting by its label
    get(label) {
        return this.items.find((item) => item.label === label);
    }

    clear() {
        this.items = [];
        return this;
    }

}

//==============================================================
// the audio context, shared by everything that makes or hears sound
//==============================================================

/*
In place of ofSoundStream. There's one AudioContext for the page. Browsers
keep it suspended until the page gets a click, a tap or a key press, so this
listens for the first one and starts it then.
*/
const XYAudio = {

    context: null,
    unavailable: false,
    workletReady: null,

    // The shared AudioContext, created on first use, at sampleRate if the
    // browser allows it. null if there's no Web Audio.
    getContext(sampleRate = 44100) {
        if (this.context || this.unavailable) return this.context;
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            this.unavailable = true;
            console.warn('p5.twoscilloscope: this browser has no Web Audio');
            return null;
        }
        try {
            this.context = new AudioContextClass({ sampleRate, latencyHint: 'interactive' });
        } catch (e) {
            try {
                this.context = new AudioContextClass({ latencyHint: 'interactive' });
            } catch (e2) {
                this.unavailable = true;
                console.warn('p5.twoscilloscope: couldn\'t create an AudioContext', e2);
                return null;
            }
        }
        this.installUnlock();
        return this.context;
    },

    // Start the context on the first click, tap or key press.
    installUnlock() {
        const ctx = this.context;
        const events = ['pointerdown', 'mousedown', 'touchend', 'keydown'];
        const unlock = () => {
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        };
        const remove = () => {
            if (ctx.state !== 'running' && ctx.state !== 'closed') return;
            for (const e of events) window.removeEventListener(e, unlock, true);
            ctx.removeEventListener('statechange', remove);
        };
        for (const e of events) window.addEventListener(e, unlock, true);
        ctx.addEventListener('statechange', remove);
        unlock(); // in case the page already has permission
    },

    isRunning() {
        return this.context !== null && this.context.state === 'running';
    },

    // 'none' (not asked for yet), 'unavailable', 'suspended' (waiting for a
    // click or a key press), 'running' or 'closed'
    state() {
        if (this.unavailable) return 'unavailable';
        return this.context ? this.context.state : 'none';
    },

    resume() {
        if (this.context && this.context.state === 'suspended') return this.context.resume().catch(() => {});
        return Promise.resolve();
    },

    // Loads the AudioWorklet processors below (once). Resolves to false if
    // the browser can't run them: AudioWorklet needs a secure context, which
    // means https://, or http://localhost or 127.0.0.1.
    loadWorklet() {
        if (this.workletReady) return this.workletReady;
        const ctx = this.context;
        if (!ctx || !ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
            console.warn('p5.twoscilloscope: no AudioWorklet here, so no audio. It needs https://, or http://localhost or 127.0.0.1');
            this.workletReady = Promise.resolve(false);
            return this.workletReady;
        }
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
        this.workletReady = ctx.audioWorklet.addModule(url).then(() => true, (err) => {
            console.error('p5.twoscilloscope: couldn\'t load the audio worklet', err);
            return false;
        }).finally(() => URL.revokeObjectURL(url));
        return this.workletReady;
    }

};

//==============================================================
// the audio thread
//==============================================================

/*
The AudioWorklet processors, kept here as a function and loaded from its
source text, so the library stays one file.

xyscope-processor is XYscope::synth() on the audio thread: it reads the
wavetables with a phase accumulator and pans X and Y with Minim's
equal-power law, exactly as XYscope's render() does on the main thread. The
main thread sends it new tables and settings, and it sends back what it
played, a block at a time, for the previews, the recorder and anything
listening to onAudioOut. Tables arrive together in one message, so X, Y and
Z always come from the same buildWaves().

xycapture-processor sends the input it hears back to the main thread, for
XYAudioInput.
*/
function workletMain() {

    function valueAt(wave, at) {
        const n = wave.length;
        if (n === 0) return 0;
        const whichSample = n * (at - Math.floor(at));
        const lowSamp = Math.floor(whichSample) % n;
        const hiSamp = (lowSamp + 1) % n;
        const rem = whichSample - Math.floor(whichSample);
        return wave[lowSamp] + rem * (wave[hiSamp] - wave[lowSamp]);
    }

    class XYscopeProcessor extends AudioWorkletProcessor {

        constructor(options) {
            super();
            const o = options.processorOptions || {};
            this.numChannels = Math.max(1, o.numChannels || 2);
            this.blockFrames = Math.max(128, o.blockFrames || 512);
            this.params = o.params;
            this.tables = o.tables;
            this.phaseX = 0;
            this.phaseY = 0;
            this.phaseZ = 0;
            this.block = new Float32Array(this.blockFrames * this.numChannels);
            this.blockPos = 0;
            this.running = true;
            this.port.onmessage = (e) => {
                const m = e.data;
                if (m.type === 'tables') this.tables = m.tables;
                else if (m.type === 'params') this.params = m.params;
                else if (m.type === 'reset') this.phaseX = this.phaseY = this.phaseZ = 0;
                else if (m.type === 'stop') this.running = false;
            };
        }

        process(inputs, outputs) {
            if (!this.running) return false;
            const out = outputs[0];
            const nOut = out.length;
            const frames = nOut > 0 ? out[0].length : 128;
            const p = this.params;
            const waveX = this.tables.x, waveY = this.tables.y, waveZ = this.tables.z;
            const useZ = p.useZ && waveZ.length > 0;

            // Minim's Pan: equal power, -1 is all left and 1 is all right
            const thetaX = (p.pan[0] + 1) * Math.PI / 4;
            const thetaY = (p.pan[1] + 1) * Math.PI / 4;
            const lx = Math.cos(thetaX), rx = Math.sin(thetaX);
            const ly = Math.cos(thetaY), ry = Math.sin(thetaY);
            const stepX = p.freq[0] / sampleRate;
            const stepY = p.freq[1] / sampleRate;
            const stepZ = p.freq[2] / sampleRate;
            const nCh = this.numChannels;

            for (let i = 0; i < frames; i++) {
                const x = p.amp[0] * valueAt(waveX, this.phaseX);
                const y = p.amp[1] * valueAt(waveY, this.phaseY);
                // no Z wave means the beam stays on
                const z = useZ ? p.amp[2] * valueAt(waveZ, this.phaseZ) : p.zMax;

                this.phaseX += stepX;
                this.phaseY += stepY;
                this.phaseZ += stepZ;
                this.phaseX -= Math.floor(this.phaseX);
                this.phaseY -= Math.floor(this.phaseY);
                this.phaseZ -= Math.floor(this.phaseZ);

                const l = x * lx + y * ly;
                const r = x * rx + y * ry;
                for (let c = 0; c < nOut; c++) out[c][i] = c === 0 ? l : c === 1 ? r : c === 2 ? z : 0;

                const k = this.blockPos * nCh;
                this.block[k] = l;
                if (nCh > 1) this.block[k + 1] = r;
                if (nCh > 2) this.block[k + 2] = z;
                if (++this.blockPos === this.blockFrames) {
                    this.port.postMessage({ type: 'audio', samples: this.block, numChannels: nCh, sampleRate }, [this.block.buffer]);
                    this.block = new Float32Array(this.blockFrames * nCh);
                    this.blockPos = 0;
                }
            }
            return true;
        }

    }

    class XYCaptureProcessor extends AudioWorkletProcessor {

        constructor(options) {
            super();
            const o = options.processorOptions || {};
            this.blockFrames = Math.max(128, o.blockFrames || 512);
            this.maxChannels = Math.max(1, o.maxChannels || 2);
            this.numChannels = 0;
            this.block = null;
            this.blockPos = 0;
            this.running = true;
            this.port.onmessage = (e) => {
                if (e.data.type === 'stop') this.running = false;
            };
        }

        process(inputs) {
            if (!this.running) return false;
            const input = inputs[0];
            if (!input || input.length === 0) return true; // nothing connected yet
            const nCh = Math.min(input.length, this.maxChannels);
            if (nCh !== this.numChannels) {
                this.numChannels = nCh;
                this.block = new Float32Array(this.blockFrames * nCh);
                this.blockPos = 0;
            }
            const frames = input[0].length;
            for (let i = 0; i < frames; i++) {
                const k = this.blockPos * nCh;
                for (let c = 0; c < nCh; c++) this.block[k + c] = input[c][i];
                if (++this.blockPos === this.blockFrames) {
                    this.port.postMessage({ type: 'audio', samples: this.block, numChannels: nCh, sampleRate }, [this.block.buffer]);
                    this.block = new Float32Array(this.blockFrames * nCh);
                    this.blockPos = 0;
                }
            }
            return true;
        }

    }

    registerProcessor('xyscope-processor', XYscopeProcessor);
    registerProcessor('xycapture-processor', XYCaptureProcessor);

}

const WORKLET_SOURCE = '(' + workletMain.toString() + ')();\n';

//==============================================================
// XYWavetable
//==============================================================

/*
A port of XYscope's XYWavetable.java, itself Hansi Raber's fix of Minim's
Wavetable: a float array you can sample with a normalized [0,1] position.

The Java version fixed an ArrayIndexOutOfBoundsException that happened when
the drawing thread replaced the array while the audio thread was reading it.
Here the audio thread has copies of its own (XYscope sends them over), so
the table is just a Float32Array that gets replaced, never edited in place.

Differences from the Java original:
* The transform methods (scale, smooth, warp...) build a new table and swap
  it in.
* smooth() is a true moving average. Minim's divided a window of n+1
  samples by n.
*/
class XYWavetable {

    constructor(sizeOrWaveform = 0) {
        this.waveform = typeof sizeOrWaveform === 'number' ? new Float32Array(Math.max(0, sizeOrWaveform)) : Float32Array.from(sizeOrWaveform);
        // called whenever the table changes (XYscope uses it to update the audio thread)
        this.onChange = null;
    }

    setWaveform(waveform) {
        this.setWaveformOwned(Float32Array.from(waveform));
    }

    // Takes the array itself rather than a copy. Don't change it afterwards.
    setWaveformOwned(waveform) {
        this.waveform = waveform;
        if (this.onChange) this.onChange(this);
    }

    // A copy of the current table.
    getWaveform() {
        return this.waveform.slice();
    }

    // The current table itself. Read it, don't change it.
    getWaveformRef() {
        return this.waveform;
    }

    get(i) {
        return i >= 0 && i < this.waveform.length ? this.waveform[i] : 0;
    }

    set(i, value) {
        this.modify((w) => {
            if (i >= 0 && i < w.length) w[i] = value;
        });
    }

    size() {
        return this.waveform.length;
    }

    // Sample the table at a position in [0,1], with linear interpolation.
    // Positions outside [0,1] wrap around, so does the last sample, which
    // interpolates back to the first one.
    value(at) {
        return XYWavetable.valueAt(this.waveform, at);
    }

    static valueAt(wave, at) {
        const n = wave.length;
        if (n === 0) return 0;
        const wrapped = at - Math.floor(at);
        const whichSample = n * wrapped;

        // linearly interpolate between the two samples we want
        const lowSamp = Math.floor(whichSample) % n;
        const hiSamp = (lowSamp + 1) % n;
        const rem = whichSample - Math.floor(whichSample);

        return wave[lowSamp] + rem * (wave[hiSamp] - wave[lowSamp]);
    }

    modify(func) {
        const next = this.getWaveform();
        func(next);
        this.setWaveformOwned(next);
    }

    scale(scale) {
        this.modify((w) => {
            for (let i = 0; i < w.length; i++) w[i] *= scale;
        });
    }

    offset(amount) {
        this.modify((w) => {
            for (let i = 0; i < w.length; i++) w[i] += amount;
        });
    }

    normalize() {
        this.modify((w) => {
            let max = 0;
            for (let i = 0; i < w.length; i++) max = Math.max(max, Math.abs(w[i]));
            if (max > 0) {
                for (let i = 0; i < w.length; i++) w[i] /= max;
            }
        });
    }

    invert() {
        this.flip(0);
    }

    flip(about) {
        this.modify((w) => {
            for (let i = 0; i < w.length; i++) w[i] = about - (w[i] - about);
        });
    }

    // gaussian noise with a standard deviation of sigma
    addNoise(sigma) {
        this.modify((w) => {
            for (let i = 0; i < w.length; i++) {
                // Box-Muller
                const u = 1 - Math.random(), v = Math.random();
                w[i] += Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v) * sigma;
            }
        });
    }

    rectify() {
        this.modify((w) => {
            for (let i = 0; i < w.length; i++) w[i] = Math.abs(w[i]);
        });
    }

    smooth(windowLength) {
        if (windowLength < 1) return;
        this.modify((w) => {
            const temp = w.slice();
            for (let i = windowLength; i < w.length; i++) {
                let avg = 0;
                for (let j = i - windowLength; j <= i; j++) avg += temp[j];
                w[i] = avg / (windowLength + 1);
            }
        });
    }

    warp(warpPoint, warpTarget) {
        this.modify((w) => {
            const source = w.slice();
            for (let s = 0; s < w.length; s++) {
                let lookup = s / w.length;
                if (lookup <= warpTarget) {
                    // normalize look up to [0,warpTarget], expand to [0,warpPoint]
                    lookup = warpTarget > 0 ? (lookup / warpTarget) * warpPoint : 0;
                } else {
                    // map (warpTarget,1] to (warpPoint,1]
                    lookup = warpPoint + (1 - (1 - lookup) / (1 - warpTarget)) * (1 - warpPoint);
                }
                w[s] = XYWavetable.valueAt(source, lookup);
            }
        });
    }

}

//==============================================================
// HersheyFont
//==============================================================

/*
Hershey single-stroke vector fonts, the text engine from XYscope.java
(which credits https://github.com/ixd-hof/HersheyFont).

Hershey glyphs are made of open strokes rather than filled outlines, so
they draw cleanly with a single beam. Give load() one of the names in
getFontNames() to read common/data/hershey_fonts/<name>.jhf (or wherever
HersheyFont.dataPath points), or the URL of any .jhf file. The "futural"
font is built in, so text works even without the data folder.

Differences from ofxTwoscilloscope:
* Fonts are fetched, so they arrive later. load() is instant for a font
  that's already here and otherwise starts fetching it and returns false;
  call it again (XYscope.textFont() each frame does) once it's in. To have
  fonts ready from the first frame, load them in preload() with
  loadHersheyFont(name), or wait for HersheyFont.preload(names).
* Text alignment takes p5's constants: LEFT, CENTER, RIGHT and TOP, CENTER,
  BOTTOM, BASELINE.

As in ofxTwoscilloscope, glyphs are placed with their left and right
bearings, and the .jhf parser counts the vertices each glyph declares, so it
copes with glyphs that wrap onto several lines.
*/

// The "futural" (simplex roman) font, built in so text works without any
// data files. See common/data/hershey_fonts/hershey.txt for the Hershey font
// acknowledgements.
const HERSHEY_FUTURAL_JHF = [
    "12345  1JZ",
    "12345  9MWRFRT RRYQZR[SZRY",
    "12345  6JZNFNM RVFVM",
    "12345 12H]SBLb RYBRb RLOZO RKUYU",
    "12345 27H\\PBP_ RTBT_ RYIWGTFPFMGKIKKLMMNOOUQWRXSYUYXWZT[P[MZKX",
    "12345 32F^[FI[ RNFPHPJOLMMKMIKIIJGLFNFPGSHVHYG[F RWTUUTWTYV[X[ZZ[X[VYTWT",
    "12345 35E_\\O\\N[MZMYNXPVUTXRZP[L[JZIYHWHUISJRQNRMSKSIRGPFNGMIMKNNPQUXWZY[[[\\Z\\Y",
    "12345  8MWRHQGRFSGSIRKQL",
    "12345 11KYVBTDRGPKOPOTPYR]T`Vb",
    "12345 11KYNBPDRGTKUPUTTYR]P`Nb",
    "12345  9JZRLRX RMOWU RWOMU",
    "12345  6E_RIR[ RIR[R",
    "12345  8NVSWRXQWRVSWSYQ[",
    "12345  3E_IR[R",
    "12345  6NVRVQWRXSWRV",
    "12345  3G][BIb",
    "12345 18H\\QFNGLJKOKRLWNZQ[S[VZXWYRYOXJVGSFQF",
    "12345  5H\\NJPISFS[",
    "12345 15H\\LKLJMHNGPFTFVGWHXJXLWNUQK[Y[",
    "12345 16H\\MFXFRNUNWOXPYSYUXXVZS[P[MZLYKW",
    "12345  7H\\UFKTZT RUFU[",
    "12345 18H\\WFMFLOMNPMSMVNXPYSYUXXVZS[P[MZLYKW",
    "12345 24H\\XIWGTFRFOGMJLOLTMXOZR[S[VZXXYUYTXQVOSNRNOOMQLT",
    "12345  6H\\YFO[ RKFYF",
    "12345 30H\\PFMGLILKMMONSOVPXRYTYWXYWZT[P[MZLYKWKTLRNPQOUNWMXKXIWGTFPF",
    "12345 24H\\XMWPURRSQSNRLPKMKLLINGQFRFUGWIXMXRWWUZR[P[MZLX",
    "12345 12NVROQPRQSPRO RRVQWRXSWRV",
    "12345 14NVROQPRQSPRO RSWRXQWRVSWSYQ[",
    "12345  4F^ZIJRZ[",
    "12345  6E_IO[O RIU[U",
    "12345  4F^JIZRJ[",
    "12345 21I[LKLJMHNGPFTFVGWHXJXLWNVORQRT RRYQZR[SZRY",
    "12345 56E`WNVLTKQKOLNMMPMSNUPVSVUUVS RQKOMNPNSOUPV RWKVSVUXVZV\\T]Q]O\\L[JYHWGTFQFNGLHJJILHOHRIUJWLYNZQ[T[WZYYZX RXKWSWUXV",
    "12345  9I[RFJ[ RRFZ[ RMTWT",
    "12345 24G\\KFK[ RKFTFWGXHYJYLXNWOTP RKPTPWQXRYTYWXYWZT[K[",
    "12345 19H]ZKYIWGUFQFOGMILKKNKSLVMXOZQ[U[WZYXZV",
    "12345 16G\\KFK[ RKFRFUGWIXKYNYSXVWXUZR[K[",
    "12345 12H[LFL[ RLFYF RLPTP RL[Y[",
    "12345  9HZLFL[ RLFYF RLPTP",
    "12345 23H]ZKYIWGUFQFOGMILKKNKSLVMXOZQ[U[WZYXZVZS RUSZS",
    "12345  9G]KFK[ RYFY[ RKPYP",
    "12345  3NVRFR[",
    "12345 11JZVFVVUYTZR[P[NZMYLVLT",
    "12345  9G\\KFK[ RYFKT RPOY[",
    "12345  6HYLFL[ RL[X[",
    "12345 12F^JFJ[ RJFR[ RZFR[ RZFZ[",
    "12345  9G]KFK[ RKFY[ RYFY[",
    "12345 22G]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF",
    "12345 14G\\KFK[ RKFTFWGXHYJYMXOWPTQKQ",
    "12345 25G]PFNGLIKKJNJSKVLXNZP[T[VZXXYVZSZNYKXIVGTFPF RSWY]",
    "12345 17G\\KFK[ RKFTFWGXHYJYLXNWOTPKP RRPY[",
    "12345 21H\\YIWGTFPFMGKIKKLMMNOOUQWRXSYUYXWZT[P[MZKX",
    "12345  6JZRFR[ RKFYF",
    "12345 11G]KFKULXNZQ[S[VZXXYUYF",
    "12345  6I[JFR[ RZFR[",
    "12345 12F^HFM[ RRFM[ RRFW[ R\\FW[",
    "12345  6H\\KFY[ RYFK[",
    "12345  7I[JFRPR[ RZFRP",
    "12345  9H\\YFK[ RKFYF RK[Y[",
    "12345 12KYOBOb RPBPb ROBVB RObVb",
    "12345  3KYKFY^",
    "12345 12KYTBTb RUBUb RNBUB RNbUb",
    "12345  6JZRDJR RRDZR",
    "12345  3I[Ib[b",
    "12345  8NVSKQMQORPSORNQO",
    "12345 18I\\XMX[ RXPVNTMQMONMPLSLUMXOZQ[T[VZXX",
    "12345 18H[LFL[ RLPNNPMSMUNWPXSXUWXUZS[P[NZLX",
    "12345 15I[XPVNTMQMONMPLSLUMXOZQ[T[VZXX",
    "12345 18I\\XFX[ RXPVNTMQMONMPLSLUMXOZQ[T[VZXX",
    "12345 18I[LSXSXQWOVNTMQMONMPLSLUMXOZQ[T[VZXX",
    "12345  9MYWFUFSGRJR[ ROMVM",
    "12345 23I\\XMX]W`VaTbQbOa RXPVNTMQMONMPLSLUMXOZQ[T[VZXX",
    "12345 11I\\MFM[ RMQPNRMUMWNXQX[",
    "12345  9NVQFRGSFREQF RRMR[",
    "12345 12MWRFSGTFSERF RSMS^RaPbNb",
    "12345  9IZMFM[ RWMMW RQSX[",
    "12345  3NVRFR[",
    "12345 19CaGMG[ RGQJNLMOMQNRQR[ RRQUNWMZM\\N]Q][",
    "12345 11I\\MMM[ RMQPNRMUMWNXQX[",
    "12345 18I\\QMONMPLSLUMXOZQ[T[VZXXYUYSXPVNTMQM",
    "12345 18H[LMLb RLPNNPMSMUNWPXSXUWXUZS[P[NZLX",
    "12345 18I\\XMXb RXPVNTMQMONMPLSLUMXOZQ[T[VZXX",
    "12345  9KXOMO[ ROSPPRNTMWM",
    "12345 18J[XPWNTMQMNNMPNRPSUTWUXWXXWZT[Q[NZMX",
    "12345  9MYRFRWSZU[W[ ROMVM",
    "12345 11I\\MMMWNZP[S[UZXW RXMX[",
    "12345  6JZLMR[ RXMR[",
    "12345 12G]JMN[ RRMN[ RRMV[ RZMV[",
    "12345  6J[MMX[ RXMM[",
    "12345 10JZLMR[ RXMR[P_NaLbKb",
    "12345  9J[XMM[ RMMXM RM[X[",
    "12345 40KYTBRCQDPFPHQJRKSMSOQQ RRCQEQGRISJTLTNSPORSTTVTXSZR[Q]Q_Ra RQSSUSWRYQZP\\P^Q`RaTb",
    "12345  3NVRBRb",
    "12345 40KYPBRCSDTFTHSJRKQMQOSQ RRCSESGRIQJPLPNQPURQTPVPXQZR[S]S_Ra RSSQUQWRYSZT\\T^S`RaPb",
    "12345 24F^IUISJPLONOPPTSVTXTZS[Q RISJQLPNPPQTTVUXUZT[Q[O",
    "12345 35JZJFJ[K[KFLFL[M[MFNFN[O[OFPFP[Q[QFRFR[S[SFTFT[U[UFVFV[W[WFXFX[Y[YFZFZ["
].join('\n');

const HERSHEY_FONT_NAMES = [
    'astrology', 'cursive', 'cyrilc_1', 'cyrillic', 'futural', 'futuram', 'gothgbt', 'gothgrt',
    'gothiceng', 'gothicger', 'gothicita', 'gothitt', 'greek', 'greekc', 'greeks', 'japanese',
    'markers', 'mathlow', 'mathupp', 'meteorology', 'music', 'rowmand', 'rowmans', 'rowmant',
    'scriptc', 'scripts', 'symbolic', 'timesg', 'timesi', 'timesib', 'timesr', 'timesrb'
];

// In Hershey units, the top of a capital is at y = -12 and the baseline at y = 9.
const HERSHEY_BASELINE = 9;
const HERSHEY_R = 'R'.charCodeAt(0);

// .jhf text by font, null for fonts that failed to load
const hersheyText = new Map([['futural', HERSHEY_FUTURAL_JHF]]);
// parsed glyphs by font
const hersheyGlyphs = new Map();
// fetches in progress
const hersheyFetches = new Map();

function resolveHersheyFont(nameOrPath) {
    if (HERSHEY_FONT_NAMES.includes(nameOrPath)) {
        return { key: nameOrPath, name: nameOrPath, url: HersheyFont.dataPath + nameOrPath + '.jhf' };
    }
    const base = nameOrPath.split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
    return { key: nameOrPath, name: base, url: nameOrPath };
}

function splitLines(text) {
    return String(text).replace(/\r/g, '').split('\n');
}

class HersheyFont {

    constructor() {
        this.glyphs = [];
        this.name = '';
        this.load('futural');
    }

    static getFontNames() {
        return HERSHEY_FONT_NAMES;
    }

    // Fetch fonts (names or URLs) ahead of time. Resolves when they're all in.
    static preload(...namesOrPaths) {
        return Promise.all(namesOrPaths.flat().map((n) => HersheyFont.fetch(n).then((text) => text !== null)));
    }

    // The .jhf text of a font, fetched once and kept. Resolves to null if it couldn't be found.
    static fetch(nameOrPath) {
        const font = resolveHersheyFont(nameOrPath);
        if (hersheyText.has(font.key)) return Promise.resolve(hersheyText.get(font.key));
        if (!hersheyFetches.has(font.key)) {
            const request = fetch(font.url).then((response) => {
                if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
                return response.text();
            }).then((text) => {
                hersheyText.set(font.key, text);
                return text;
            }, (err) => {
                console.error('HersheyFont: couldn\'t load ' + font.url + ' (' + err.message + '). ' +
                    'Serve the sketch over http, and set HersheyFont.dataPath if the fonts live somewhere else.');
                hersheyText.set(font.key, null);
                return null;
            }).finally(() => hersheyFetches.delete(font.key));
            hersheyFetches.set(font.key, request);
        }
        return hersheyFetches.get(font.key);
    }

    // Switch to a font if it's here, and return true. If it isn't, start
    // fetching it and return false, keeping the font that's loaded now.
    load(nameOrPath) {
        const font = resolveHersheyFont(nameOrPath);
        let glyphs = hersheyGlyphs.get(font.key);
        if (!glyphs) {
            if (!hersheyText.has(font.key)) {
                HersheyFont.fetch(nameOrPath);
                return false;
            }
            const text = hersheyText.get(font.key);
            if (text === null) return false;
            glyphs = HersheyFont.parse(text, font.name);
            if (!glyphs) return false;
            hersheyGlyphs.set(font.key, glyphs);
        }
        this.glyphs = glyphs;
        this.name = font.name;
        return true;
    }

    // Fetch a font if need be, then switch to it. Resolves to true if it loaded.
    loadAsync(nameOrPath) {
        return HersheyFont.fetch(nameOrPath).then(() => this.load(nameOrPath));
    }

    loadFromString(jhf, name = '') {
        const glyphs = HersheyFont.parse(jhf, name);
        if (!glyphs) return false;
        this.glyphs = glyphs;
        this.name = name;
        return true;
    }

    // Each glyph starts with a 5 character id and a 3 character vertex count,
    // followed by that many coordinate pairs. The first pair holds the left and
    // right bearings, and " R" lifts the pen. A long glyph may wrap onto the
    // next line, so keep reading until all of its pairs have been collected.
    static parse(jhf, name = '') {
        const parsed = [];
        let data = '';
        let wanted = 0;

        const coord = (s, i) => s.charCodeAt(i) - HERSHEY_R;
        const finishGlyph = () => {
            const glyph = { left: coord(data, 0), right: coord(data, 1), strokes: [] };
            let stroke = [];
            for (let i = 2; i + 1 < data.length; i += 2) {
                if (data[i] === ' ' && data[i + 1] === 'R') {
                    if (stroke.length > 1) glyph.strokes.push(stroke);
                    stroke = [];
                } else {
                    stroke.push({ x: coord(data, i), y: coord(data, i + 1) });
                }
            }
            if (stroke.length > 1) glyph.strokes.push(stroke);
            parsed.push(glyph);
            data = '';
            wanted = 0;
        };

        for (let line of String(jhf).split('\n')) {
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (line.length === 0) continue;

            if (wanted === 0) {
                if (line.length < 8) continue;
                wanted = (parseInt(line.substr(5, 3).trim(), 10) || 0) * 2;
                if (wanted <= 0) {
                    wanted = 0;
                    continue;
                }
                line = line.substr(8);
            }

            data += line.substr(0, wanted - data.length);
            if (data.length >= wanted) finishGlyph();
        }

        if (parsed.length === 0) {
            console.error('HersheyFont: no glyphs found in ' + (name || 'font data'));
            return null;
        }
        return parsed;
    }

    isLoaded() {
        return this.glyphs.length > 0;
    }

    getName() {
        return this.name;
    }

    // Glyphs start at ASCII 32 (space).
    getGlyph(codePoint) {
        if (codePoint < 32) return null;
        return this.glyphs[codePoint - 32] || null;
    }

    getLineWidth(line, factor) {
        let width = 0;
        const space = this.getGlyph(32);
        for (const ch of line) {
            const glyph = this.getGlyph(ch.codePointAt(0)) || space;
            if (glyph) width += (glyph.right - glyph.left) * factor;
        }
        return width;
    }

    // Width of the widest line, in pixels.
    getWidth(text, size) {
        const factor = size / HersheyFont.CAP_HEIGHT;
        let width = 0;
        for (const line of splitLines(text)) width = Math.max(width, this.getLineWidth(line, factor));
        return width;
    }

    // Lay out a string (with \n for line breaks) as XYPolyline strokes in
    // pixels. size is the height of a capital letter, leading is the distance
    // from one baseline to the next.
    getStrokes(text, x, y, size, leading, alignX = 'left', alignY = 'top') {
        const result = [];
        const factor = size / HersheyFont.CAP_HEIGHT;
        const lines = splitLines(text);
        const blockHeight = size + (lines.length - 1) * leading;

        // baseline of the first line
        let baseline = y;
        if (alignY === 'top') baseline = y + size;
        else if (alignY === 'center') baseline = y - blockHeight / 2 + size;
        else if (alignY === 'bottom') baseline = y - (lines.length - 1) * leading;

        const space = this.getGlyph(32);
        for (const line of lines) {
            let penX = x;
            if (alignX === 'center') penX -= this.getLineWidth(line, factor) / 2;
            else if (alignX === 'right') penX -= this.getLineWidth(line, factor);

            for (const ch of line) {
                const glyph = this.getGlyph(ch.codePointAt(0)) || space;
                if (!glyph) continue;
                for (const stroke of glyph.strokes) {
                    const polyline = new XYPolyline();
                    for (const p of stroke) {
                        polyline.addVertex(penX + (p.x - glyph.left) * factor, baseline + (p.y - HERSHEY_BASELINE) * factor);
                    }
                    result.push(polyline);
                }
                penX += (glyph.right - glyph.left) * factor;
            }
            baseline += leading;
        }

        return result;
    }

}

// Hershey units from the top of a capital letter to the baseline.
HersheyFont.CAP_HEIGHT = 21;
// Where the .jhf files are: common/data/hershey_fonts, next to this file's folder.
HersheyFont.dataPath = new URL('../../data/hershey_fonts/', SCRIPT_URL).href;

//==============================================================
// XYscope
//==============================================================

/*
A port of XYscope.java by Ted Davis (https://teddavis.org/xyscope), the
vector-to-audio half of the library.

Drawing commands don't draw to the screen. They collect shapes, and
buildWaves() turns those shapes into wavetables that loop at freq() Hz:
X on the left channel, Y on the right, and an optional Z (beam blanking)
channel. Play them through a DC-coupled sound card into an oscilloscope in
X-Y mode, a modded Vectrex or a laser, and the shapes appear on the display.

    let xy;

    function setup() {
        createCanvas(512, 512);
        xy = new XYscope();
        xy.setup();          // canvas = sketch size, 44.1kHz, 512 sample waves
        xy.openAudioOut();   // default sound card, once the page is clicked
    }

    function draw() {
        if (!xy.isAudioRunning()) xy.process(deltaTime / 1000);
        background(0);
        xy.clearWaves();
        xy.circle(width / 2, height / 2, height / 2);
        xy.buildWaves();
        xy.drawXY();         // preview of what the scope will show
    }

Coordinates work like p5's: pixels on a canvas (the sketch, by default)
with y pointing down. "XYscope format" audio maps the canvas to -1..1, with
+Y up: x = 2 * px / width - 1, y = 1 - 2 * py / height.

Differences from ofxTwoscilloscope:
* openAudioOut() plays through an AudioWorklet. Sound starts once the page
  has been clicked or a key pressed, and isAudioRunning() says when. Until
  then, process() keeps the previews and the recorder going.
* What the sound card plays comes back to the main thread a block
  (bufferSize() frames) at a time, for the previews, the recorder and
  onAudioOut(buffer), which is the place to pass it on, to an Oscilloscope
  say. Several XYscopes playing at once add up in the browser's mixer, which
  is what audioOutAdd() was for.
* The output device can't be picked, so listDevices() is gone, and the
  oscillators run at the browser's sample rate (sampleRate(), if the browser
  allows it).
* openAudioOut(numChannels, deviceChannels) can make, and report, more
  channels than it sends to the speakers, so Z can go to a scope without
  going out, as example-transform did by hand.
* recorderEnd() downloads the WAV.
* Getters and setters share a name, the p5 way: freq() reads, freq(50) sets.
* rectMode() and textAlign() take p5's constants. textAlign() still starts at
  TOP, as in ofxTwoscilloscope.
* path(ofPath) is gone. polylines() takes XYPolylines or arrays of points.
*/
class XYscope {

    constructor() {
        this.xyWidth = 512;
        this.xyHeight = 512;
        this.sampleRateVal = 44100;
        this.bufferSizeVal = 512;
        this.waveSizeVal = 512;
        this.stepsSize = 24;

        this.useLimitPoints = false;
        this.limitPointsVal = 512;
        this.useLimitPath = false;
        this.limitVal = 1;

        this.freqVal = { x: 50, y: 50, z: 50 };
        this.ampVal = { x: 1, y: 1, z: 1 };
        this.panVal = { x: -1, y: 1 };
        this.useZ = true;
        this.zaxisMin = -1;
        this.zaxisMax = 1;

        this.useVectrex = false;
        this.vectrexAmp = 0.82;
        this.vectrexAmpInit = 0.6;
        this.vectrexRotation = 0;

        this.rectM = 'corner';
        this.ellipseDetailVal = 30;
        this.debugWave = false;

        this.shapes = [];
        this.shapeOpen = false;

        this.matrixStack = [];
        this.matrix = Mat4.identity();
        this.usePerspectiveVal = true;

        this.font = new HersheyFont();
        this.textSizeVal = HersheyFont.CAP_HEIGHT;
        this.textLeadingVal = HersheyFont.CAP_HEIGHT * 1.5;
        this.textAlignX = 'left';
        this.textAlignY = 'top';

        // the live oscillators, for process() and audioOut()
        this.liveOscs = { phaseX: 0, phaseY: 0, phaseZ: 0 };
        this.processRemainder = 0;
        // the most recent output, for drawXY() and drawWave()
        this.lastBuffer = new XYFloatArray(4096);
        this.lastChannels = 0;
        this.lastSampleRate = 44100;
        this.recording = false;
        this.recordingPath = '';
        this.recordBuffer = new XYFloatArray(4096);
        this.recordChannels = 0;
        this.recordSampleRate = 44100;

        // Called with every buffer of live output: from the sound card, or
        // from process() when there's none.
        this.onAudioOut = null;

        // the sound card
        this.node = null;
        this.audioOutOpen = false;
        this.audioChannels = 2;
        this.deviceChannels = 2;
        this.openRequest = null;
        this.tablesDirty = false;
        this.paramsDirty = false;

        this.tableX = new XYWavetable(this.waveSizeVal);
        this.tableY = new XYWavetable(this.waveSizeVal);
        this.tableZ = new XYWavetable(new Float32Array(this.waveSizeVal).fill(this.zaxisMax));
        const tablesChanged = () => this.tablesChanged();
        this.tableX.onChange = tablesChanged;
        this.tableY.onChange = tablesChanged;
        this.tableZ.onChange = tablesChanged;
    }

    // ---------------------------------------------------------------- setup

    // width/height of 0 use the sketch's size.
    setup(width = 0, height = 0, sampleRate = 44100, bufferSize = 512) {
        const g = getP5();
        this.setCanvasSize(width > 0 ? width : (g ? g.width : 512), height > 0 ? height : (g ? g.height : 512));
        this.sampleRateVal = sampleRate;
        this.bufferSizeVal = Math.max(16, bufferSize | 0);
        this.waveSize(this.bufferSizeVal);
        this.limitPointsVal = this.bufferSizeVal;
        console.log('XYscope 3.0.0 for p5.js - https://teddavis.org/xyscope');
        return this;
    }

    // Play out of the default sound card: X on channel 0, Y on 1, Z on 2.
    // numChannels is how many channels are made (and passed to onAudioOut and
    // the recorder), deviceChannels how many of those reach the speakers.
    // Resolves to true once the output is set up; it plays as soon as the page
    // has been clicked or a key pressed.
    openAudioOut(numChannels = 2, deviceChannels = numChannels) {
        this.closeAudioOut();
        this.audioChannels = Math.max(1, numChannels | 0);
        this.deviceChannels = clamp(deviceChannels | 0, 1, this.audioChannels);
        const ctx = XYAudio.getContext(this.sampleRateVal);
        if (!ctx) {
            console.warn('XYscope: couldn\'t open an audio output, use process() to run without one');
            return Promise.resolve(false);
        }
        this.audioOutOpen = true;
        const request = this.openRequest = {};
        return XYAudio.loadWorklet().then((ok) => {
            if (request !== this.openRequest) return false; // closed or reopened meanwhile
            if (!ok) {
                this.audioOutOpen = false;
                console.warn('XYscope: couldn\'t open an audio output, use process() to run without one');
                return false;
            }
            const destination = ctx.destination;
            const channels = Math.min(this.deviceChannels, Math.max(1, destination.maxChannelCount || 2));
            if (channels > destination.channelCount) {
                try {
                    destination.channelCount = channels;
                } catch (e) {
                    // keep the channels it has
                }
            }
            this.node = new AudioWorkletNode(ctx, 'xyscope-processor', {
                numberOfInputs: 0,
                numberOfOutputs: 1,
                outputChannelCount: [channels],
                processorOptions: {
                    numChannels: this.audioChannels,
                    blockFrames: this.bufferSizeVal,
                    params: this.getParams(),
                    tables: this.getTables()
                }
            });
            this.node.port.onmessage = (e) => this.receive(e.data);
            this.node.connect(destination);
            this.tablesDirty = false;
            this.paramsDirty = false;
            return true;
        });
    }

    closeAudioOut() {
        this.openRequest = null;
        if (this.node) {
            this.node.port.postMessage({ type: 'stop' });
            this.node.port.onmessage = null;
            this.node.disconnect();
            this.node = null;
        }
        this.audioOutOpen = false;
    }

    // openAudioOut() was called, and hasn't failed
    isAudioOutOpen() {
        return this.audioOutOpen;
    }

    // the sound card is playing (false until the page is clicked)
    isAudioRunning() {
        return this.node !== null && XYAudio.isRunning();
    }

    // a block of what the sound card played
    receive(message) {
        if (message.type !== 'audio') return;
        const buffer = XYSoundBuffer.wrap(message.samples, message.numChannels, message.sampleRate);
        this.finishBuffer(buffer);
        if (this.onAudioOut) this.onAudioOut(buffer);
    }

    getParams() {
        return {
            freq: [this.freqVal.x, this.freqVal.y, this.freqVal.z],
            amp: [this.ampVal.x, this.ampVal.y, this.ampVal.z],
            pan: [this.panVal.x, this.panVal.y],
            useZ: this.useZ,
            zMax: this.zaxisMax
        };
    }

    getTables() {
        return { x: this.tableX.getWaveformRef(), y: this.tableY.getWaveformRef(), z: this.tableZ.getWaveformRef() };
    }

    // Changes reach the audio thread together, once the current task is done.
    tablesChanged() {
        if (!this.node || this.tablesDirty) return;
        this.tablesDirty = true;
        queueMicrotask(() => this.flush());
    }

    paramsChanged() {
        if (!this.node || this.paramsDirty) return;
        this.paramsDirty = true;
        queueMicrotask(() => this.flush());
    }

    flush() {
        if (this.node) {
            if (this.tablesDirty) this.node.port.postMessage({ type: 'tables', tables: this.getTables() });
            if (this.paramsDirty) this.node.port.postMessage({ type: 'params', params: this.getParams() });
        }
        this.tablesDirty = false;
        this.paramsDirty = false;
    }

    setCanvasSize(width, height) {
        this.xyWidth = Math.max(1, width);
        this.xyHeight = Math.max(1, height);
    }

    getWidth() { return this.xyWidth; }
    getHeight() { return this.xyHeight; }

    // the rate process() and render() run at, and the one asked of the browser
    sampleRate(rate) {
        if (rate === undefined) return this.sampleRateVal;
        this.sampleRateVal = rate;
        return this;
    }

    // the default wave size, and the block size the sound card's output comes back in
    bufferSize(size) {
        if (size === undefined) return this.bufferSizeVal;
        if (size > 16) this.bufferSizeVal = size | 0;
        if (this.node) this.openAudioOut(this.audioChannels, this.deviceChannels);
        return this;
    }

    // ---------------------------------------------------------------- audio

    synth(buffer, add, o) {
        const p = this.getParams();
        const waveX = this.tableX.getWaveformRef();
        const waveY = this.tableY.getWaveformRef();
        const waveZ = this.tableZ.getWaveformRef();

        const nCh = buffer.numChannels;
        const nFrames = buffer.numFrames;
        const sr = buffer.sampleRate > 0 ? buffer.sampleRate : this.sampleRateVal;
        const out = buffer.samples;

        // Minim's Pan: equal power, -1 is all left and 1 is all right
        const thetaX = (p.pan[0] + 1) * PI / 4;
        const thetaY = (p.pan[1] + 1) * PI / 4;
        const lx = Math.cos(thetaX), rx = Math.sin(thetaX);
        const ly = Math.cos(thetaY), ry = Math.sin(thetaY);

        const stepX = p.freq[0] / sr;
        const stepY = p.freq[1] / sr;
        const stepZ = p.freq[2] / sr;
        const useZ = p.useZ && waveZ.length > 0;
        const values = [0, 0, 0];

        for (let i = 0; i < nFrames; i++) {
            const x = p.amp[0] * XYWavetable.valueAt(waveX, o.phaseX);
            const y = p.amp[1] * XYWavetable.valueAt(waveY, o.phaseY);
            // no Z wave means the beam stays on
            const z = useZ ? p.amp[2] * XYWavetable.valueAt(waveZ, o.phaseZ) : p.zMax;

            o.phaseX += stepX;
            o.phaseY += stepY;
            o.phaseZ += stepZ;
            o.phaseX -= Math.floor(o.phaseX);
            o.phaseY -= Math.floor(o.phaseY);
            o.phaseZ -= Math.floor(o.phaseZ);

            values[0] = x * lx + y * ly;
            values[1] = x * rx + y * ry;
            values[2] = z;
            const frame = i * nCh;
            for (let c = 0; c < nCh && c < 3; c++) {
                out[frame + c] = add ? out[frame + c] + values[c] : values[c];
            }
            if (!add) {
                for (let c = 3; c < nCh; c++) out[frame + c] = 0;
            }
        }
    }

    previewFrames() {
        const slowest = Math.max(1, Math.min(this.freqVal.x, this.freqVal.y));
        return Math.max(this.bufferSizeVal, Math.min(this.sampleRateVal, Math.ceil(this.sampleRateVal / slowest)));
    }

    finishBuffer(buffer) {
        // keep at least one full cycle for drawXY() and drawWave()
        const keep = this.previewFrames();
        const nCh = buffer.numChannels;
        if (this.lastChannels !== nCh) {
            this.lastBuffer.clear();
            this.lastChannels = nCh;
        }
        this.lastBuffer.append(buffer.samples);
        if (this.lastBuffer.length > keep * nCh) this.lastBuffer.eraseFront(this.lastBuffer.length - keep * nCh);
        this.lastSampleRate = buffer.sampleRate;

        if (this.recording) {
            if (this.recordBuffer.length === 0) {
                this.recordChannels = nCh;
                this.recordSampleRate = buffer.sampleRate;
            }
            if (this.recordChannels === nCh) this.recordBuffer.append(buffer.samples);
        }
    }

    // Fill an XYSoundBuffer from the live oscillators: X -> channel 0, Y -> 1, Z -> 2.
    audioOut(buffer) {
        this.synth(buffer, false, this.liveOscs);
        this.finishBuffer(buffer);
    }

    // The same, but adds to what's already in the buffer.
    audioOutAdd(buffer) {
        this.synth(buffer, true, this.liveOscs);
        this.finishBuffer(buffer);
    }

    // Run the oscillators for this many seconds without a sound card,
    // feeding the recorder, the drawXY()/drawWave() previews and onAudioOut.
    process(seconds, numChannels = 2) {
        const frames = seconds * this.sampleRateVal + this.processRemainder;
        const numFrames = Math.max(0, Math.floor(frames));
        this.processRemainder = frames - numFrames;
        if (numFrames === 0) return;

        const buffer = new XYSoundBuffer(numFrames, Math.max(1, numChannels), this.sampleRateVal);
        this.audioOut(buffer);
        if (this.onAudioOut) this.onAudioOut(buffer);
    }

    // Render audio offline. Starts from phase 0 every time and doesn't
    // touch the live oscillators, so it can run while audio is playing.
    render(seconds, numChannels = 2) {
        const buffer = new XYSoundBuffer(0, numChannels, this.sampleRateVal);
        this.renderInto(buffer, Math.floor(Math.max(0, seconds) * this.sampleRateVal), numChannels);
        return buffer;
    }

    renderInto(buffer, numFrames, numChannels = 2) {
        buffer.allocate(numFrames, Math.max(1, numChannels));
        buffer.sampleRate = this.sampleRateVal;
        this.synth(buffer, false, { phaseX: 0, phaseY: 0, phaseZ: 0 });
        return buffer;
    }

    // The most recent output (at least one loop of it).
    getLastBuffer() {
        return XYSoundBuffer.wrap(this.lastBuffer.toArray(), Math.max(1, this.lastChannels), this.lastSampleRate);
    }

    // ---------------------------------------------------------------- waves

    clearWaves() {
        this.shapes = [];
        this.shapeOpen = false;
        // p5 resets the matrix at the start of every draw(), and XYscope
        // drew through Processing's matrix, so start each frame from scratch too.
        this.resetMatrix();
    }

    buildWaves() {
        if (this.shapeOpen) this.endShape();
        if (this.shapes.length === 0) {
            this.emptyWave();
            return;
        }

        // waveform gen v4 (mar 2020): spread each shape's segments over the
        // wave in proportion to their length, so the beam moves at an even speed
        let totalPoints = 0;
        let totalDist = 0;
        for (const shape of this.shapes) {
            totalPoints += shape.length;
            for (let j = 0; j + 1 < shape.length; j++) {
                totalDist += Math.hypot(shape[j + 1].x - shape[j].x, shape[j + 1].y - shape[j].y);
            }
        }
        const waveSizeD = totalPoints * this.stepsSize;

        // x, y and a blank flag on each shape's last point
        const colX = [], colY = [], colBlank = [];
        for (const shape of this.shapes) {
            for (let j = 0; j + 1 < shape.length; j++) {
                const p1 = shape[j], p2 = shape[j + 1];
                const lineDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                const secPer = Math.round(1 + (totalDist > 0 ? lineDist / totalDist * waveSizeD : 0));
                const lastSegment = j + 2 === shape.length;
                for (let k = 0; k <= secPer; k++) {
                    const t = k / secPer;
                    colX.push(p1.x + (p2.x - p1.x) * t);
                    colY.push(p1.y + (p2.y - p1.y) * t);
                    colBlank.push(lastSegment && k === secPer);
                }
            }
        }

        const n = this.waveSizeVal;
        const m = colX.length;
        const mfx = new Float32Array(n), mfy = new Float32Array(n), mfz = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const from = Math.floor(i * m / n);
            const to = Math.max(from + 1, Math.floor((i + 1) * m / n));
            mfx[i] = colX[from] * 2 - 1;
            mfy[i] = colY[from] * -2 + 1;

            // blank if any point that falls in this sample ends a shape,
            // so the blanking can't get skipped over by the resampling
            let blank = false;
            for (let k = from; k < to && k < m; k++) blank = blank || colBlank[k];
            mfz[i] = blank ? this.zaxisMin : this.zaxisMax;

            if (this.useVectrex) {
                const tfxx = mfx[i];
                const tfyy = mfy[i];
                if (this.vectrexRotation === 90) {
                    mfx[i] = tfyy;
                    mfy[i] = -tfxx;
                } else if (this.vectrexRotation === -90) {
                    mfx[i] = -tfyy;
                    mfy[i] = tfxx;
                } else {
                    mfx[i] = -tfxx;
                    mfy[i] = -tfyy;
                }
            }
        }

        this.setWaveformsOwned(mfx, mfy, mfz);
    }

    // Waveforms in -1..1, as built by buildWaves(). Z is optional.
    setWaveforms(x, y, z = []) {
        this.setWaveformsOwned(Float32Array.from(x), Float32Array.from(y), Float32Array.from(z));
    }

    setWaveformsOwned(mfx, mfy, mfz) {
        const limit = this.limitPointsVal;
        if (this.useLimitPoints && (mfx.length > limit || mfy.length > limit)) {
            const reduce = (src) => {
                if (src.length === 0) return src;
                const dst = new Float32Array(limit);
                for (let i = 0; i < limit; i++) dst[i] = src[Math.floor(i * src.length / limit)];
                return dst;
            };
            mfx = reduce(mfx);
            mfy = reduce(mfy);
            mfz = reduce(mfz);
        }
        this.tableX.setWaveformOwned(mfx);
        this.tableY.setWaveformOwned(mfy);
        if (this.useZ) this.tableZ.setWaveformOwned(mfz);
    }

    emptyWave() {
        this.tableX.setWaveformOwned(new Float32Array(0));
        this.tableY.setWaveformOwned(new Float32Array(0));
        if (this.useZ) this.tableZ.setWaveformOwned(new Float32Array(0));
    }

    // Custom waveforms in 0..1, resampled to waveSize().
    buildX(wave) {
        this.buildTable(this.tableX, wave, -1, 1);
    }

    buildY(wave) {
        this.buildTable(this.tableY, wave, 1, -1);
    }

    buildZ(wave) {
        this.buildTable(this.tableZ, wave, this.zaxisMin, this.zaxisMax);
    }

    buildTable(table, wave, outMin, outMax) {
        if (!wave || wave.length === 0) return;
        const out = new Float32Array(this.waveSizeVal);
        for (let i = 0; i < this.waveSizeVal; i++) {
            out[i] = mapValue(wave[Math.floor(i * wave.length / this.waveSizeVal)], 0, 1, outMin, outMax);
        }
        table.setWaveformOwned(out);
    }

    waveSize(newSize) {
        if (newSize === undefined) return this.waveSizeVal;
        this.waveSizeVal = Math.max(2, newSize | 0);
        return this;
    }

    steps(newSteps) {
        if (newSteps === undefined) return this.stepsSize;
        this.stepsSize = Math.max(1, Math.floor(newSteps));
        return this;
    }

    // Resample the waves to at most this many points; 0 turns the limit off.
    limitPoints(newLimit) {
        if (newLimit === undefined) return this.limitPointsVal;
        if (newLimit === 0) {
            this.useLimitPoints = false;
        } else {
            this.limitPointsVal = Math.abs(newLimit | 0);
            this.useLimitPoints = true;
        }
        return this;
    }

    // Break shapes where they come within this many pixels of the canvas edge.
    limitPath(newLimit) {
        if (newLimit === undefined) return this.limitVal;
        this.limitVal = newLimit;
        this.useLimitPath = true;
        return this;
    }

    waveReset() {
        this.liveOscs = { phaseX: 0, phaseY: 0, phaseZ: 0 };
        if (this.node) this.node.port.postMessage({ type: 'reset' });
    }

    resetWaves() {
        this.waveReset();
    }

    // ---------------------------------------------------------------- oscillators

    // freq() returns {x, y, z}. freq(f) sets all three, freq(fx, fy) X and Y,
    // freq(fx, fy, fz) or freq({x, y, z}) each one.
    freq(fx, fy, fz) {
        if (fx === undefined) return { x: this.freqVal.x, y: this.freqVal.y, z: this.freqVal.z };
        if (typeof fx === 'object') {
            fz = fx.z;
            fy = fx.y;
            fx = fx.x;
        } else if (fy === undefined) {
            fy = fz = fx;
        } else if (fz === undefined) {
            fz = this.freqVal.z;
        }
        this.freqVal = { x: fx, y: fy, z: fz };
        this.paramsChanged();
        return this;
    }

    // amp() returns {x, y, z}; set it like freq(). Each is clamped to 0..1.
    amp(ax, ay, az) {
        if (ax === undefined) return { x: this.ampVal.x, y: this.ampVal.y, z: this.ampVal.z };
        if (typeof ax === 'object') {
            az = ax.z;
            ay = ax.y;
            ax = ax.x;
        } else if (ay === undefined) {
            ay = az = ax;
        } else if (az === undefined) {
            az = this.ampVal.z;
        }
        this.ampVal.x = clamp(ax, 0, 1);
        if (this.useVectrex) this.ampVal.x *= this.vectrexAmp;
        this.ampVal.y = clamp(ay, 0, 1);
        this.ampVal.z = clamp(az, 0, 1);
        this.paramsChanged();
        return this;
    }

    // Equal power pan for the X and Y oscillators, -1 (left) to 1 (right).
    // The default (-1, 1) sends X left and Y right; (1, -1) swaps them.
    pan(panX, panY) {
        if (panX === undefined) return { x: this.panVal.x, y: this.panVal.y };
        this.panVal = { x: clamp(panX, -1, 1), y: clamp(panY, -1, 1) };
        this.paramsChanged();
        return this;
    }

    // Z output for beam off (min) and on (max). Swap them for inverted Z inputs.
    zRange(zMin, zMax) {
        if (zMin === undefined) return { min: this.zaxisMin, max: this.zaxisMax };
        this.zaxisMin = zMin;
        this.zaxisMax = zMax;
        this.paramsChanged();
        return this;
    }

    zAuto(useZ) {
        if (useZ === undefined) return this.useZ;
        this.useZ = useZ;
        this.paramsChanged();
        return this;
    }

    // ---------------------------------------------------------------- vectrex

    // vectrex(rotation): match the canvas to a modded Vectrex, 310 x 410,
    // with rotation 0, 90 or -90. vectrex(width, height, initAmp, rotation).
    vectrex(a = 0, height, initAmp, rotation) {
        if (height === undefined) {
            if (a === 90 || a === -90) this.vectrex(410, 310, this.vectrexAmpInit, a);
            else this.vectrex(310, 410, this.vectrexAmpInit, 0);
            return this;
        }
        this.useVectrex = true;
        this.vectrexRotation = rotation;
        this.setCanvasSize(a, height);
        this.vectrexAmpInit = initAmp;
        this.amp(this.vectrexAmpInit);
        return this;
    }

    vectrexRatio(ratio) {
        if (ratio === undefined) return this.vectrexAmp;
        this.vectrexAmp = clamp(ratio, 0, 1);
        this.amp(this.vectrexAmpInit);
        return this;
    }

    // ---------------------------------------------------------------- shapes

    beginShape() {
        if (this.shapeOpen) this.endShape();
        this.shapes.push([]);
        this.shapeOpen = true;
    }

    // vertex(x, y), vertex(x, y, z), or a point: {x, y, z}, [x, y, z], p5.Vector
    vertex(x, y, z = 0) {
        if (typeof x === 'object') this.vertexAdd(px(x), py(x), pz(x));
        else this.vertexAdd(x, y, z);
    }

    // Sent as a normal vertex, as in XYscope.
    curveVertex(x, y, z) {
        this.vertex(x, y, z);
    }

    project(x, y, z) {
        const t = Mat4.transform(this.matrix, x, y, z);
        if (!this.usePerspectiveVal || t[2] === 0) return { x: t[0], y: t[1], valid: true };

        // Processing's default P3D camera: the eye sits in front of the middle
        // of the canvas, far enough back that z = 0 maps 1:1 to pixels
        const cameraZ = (this.xyHeight / 2) / Math.tan(PI / 6);
        const depth = cameraZ - t[2];
        if (depth < cameraZ * 0.1) {
            return { x: t[0], y: t[1], valid: false }; // closer than Processing's near plane
        }
        const s = cameraZ / depth;
        return {
            x: this.xyWidth / 2 + (t[0] - this.xyWidth / 2) * s,
            y: this.xyHeight / 2 + (t[1] - this.xyHeight / 2) * s,
            valid: true
        };
    }

    vertexAdd(x, y, z) {
        if (!this.shapeOpen) this.beginShape();

        const screen = this.project(x, y, z);
        let valid = screen.valid;
        if (this.useLimitPath) {
            const l = this.limitVal;
            valid = valid && screen.x >= l && screen.x <= this.xyWidth - l && screen.y >= l && screen.y <= this.xyHeight - l;
        }

        if (valid) {
            this.shapes[this.shapes.length - 1].push({ x: screen.x / this.xyWidth, y: screen.y / this.xyHeight, z: 0 });
        } else {
            // break the shape where it leaves the canvas
            this.endShape();
            this.beginShape();
        }
    }

    // endShape(CLOSE) or endShape(true) joins the last point to the first.
    endShape(close = false) {
        if (!this.shapeOpen || this.shapes.length === 0) return;
        const shape = this.shapes[this.shapes.length - 1];
        if (close && shape.length > 0) shape.push({ x: shape[0].x, y: shape[0].y, z: 0 });
        if (shape.length > 1) {
            shape[shape.length - 1].z = 1; // the beam blanks here, on its way to the next shape
        } else {
            this.shapes.pop();
        }
        this.shapeOpen = false;
    }

    point(x, y, z) {
        if (z === undefined) this.line(x, y, x + 1, y + 1);
        else this.line(x, y, z, x + 1, y + 1, z + 1);
    }

    // line(x1, y1, x2, y2) or line(x1, y1, z1, x2, y2, z2)
    line(...args) {
        this.beginShape();
        if (args.length >= 6) {
            this.vertex(args[0], args[1], args[2]);
            this.vertex(args[3], args[4], args[5]);
        } else {
            this.vertex(args[0], args[1]);
            this.vertex(args[2], args[3]);
        }
        this.endShape();
    }

    rect(x, y, w, h = w) {
        switch (this.rectM) {
            case 'center':
                x -= w / 2;
                y -= h / 2;
                break;
            case 'radius':
                x -= w;
                y -= h;
                w *= 2;
                h *= 2;
                break;
            case 'corners':
                w -= x;
                h -= y;
                break;
        }
        this.vertexRect(x, y, w, h);
    }

    square(x, y, extent) {
        this.rect(x, y, extent, extent);
    }

    // CORNER (the default), CENTER, CORNERS or RADIUS
    rectMode(mode) {
        this.rectM = mode;
    }

    vertexRect(x1, y1, w1, h1) {
        this.beginShape();
        this.vertex(x1, y1);
        this.vertex(x1 + w1, y1);
        this.vertex(x1 + w1, y1 + h1);
        this.vertex(x1, y1 + h1);
        this.vertex(x1, y1);
        this.endShape();
    }

    // based on http://stackoverflow.com/questions/5886628/effecient-way-to-draw-ellipse-with-opengl-or-d3d
    ellipse(cx, cy, rx, ry = rx) {
        const theta = TWO_PI / this.ellipseDetailVal;
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        let x = 0.5; // start at angle = 0
        let y = 0;

        this.beginShape();
        for (let ii = 0; ii < this.ellipseDetailVal + 1; ii++) {
            this.vertex(x * rx + cx, y * ry + cy);
            // apply the rotation matrix
            const t = x;
            x = c * x - s * y;
            y = s * t + c * y;
        }
        this.endShape();
    }

    circle(x, y, d) {
        this.ellipse(x, y, d, d);
    }

    ellipseDetail(detail) {
        if (detail === undefined) return this.ellipseDetailVal;
        this.ellipseDetailVal = Math.max(3, Math.abs(detail | 0));
        return this;
    }

    lissajous(xPos, yPos, radius, ratioA, ratioB, phase, resolution) {
        resolution = clamp(resolution, 1, 360);
        const theta = TWO_PI / resolution;
        this.beginShape();
        for (let i = 0; i < resolution + 1; i++) {
            const x = Math.sin(i * theta * ratioA) * radius;
            const y = Math.sin(degToRad(phase) + i * theta * ratioB) * radius;
            this.vertex(xPos + x, yPos + y);
        }
        this.endShape();
    }

    // extended from: https://stackoverflow.com/a/72277489/10885535
    box(w, h = w, d = w) {
        // half size: keep the pivot at the center of the mesh
        const rx = w * 0.5;
        const ry = h * 0.5;
        const rz = d * 0.5;
        this.beginShape();
        // back (-z)
        this.vertex(-rx, -ry, -rz);
        this.vertex(+rx, -ry, -rz);
        this.vertex(+rx, +ry, -rz);
        this.vertex(-rx, +ry, -rz);
        // slide to otherside
        this.vertex(-rx, -ry, -rz);
        // front (+z)
        this.vertex(-rx, -ry, +rz);
        this.vertex(+rx, -ry, +rz);
        this.vertex(+rx, +ry, +rz);
        this.vertex(-rx, +ry, +rz);
        // top (-y)
        this.vertex(-rx, -ry, +rz);
        this.vertex(-rx, -ry, -rz);
        this.vertex(+rx, -ry, -rz);
        this.vertex(+rx, -ry, +rz);
        // bottom (+y)
        this.vertex(+rx, +ry, +rz);
        this.vertex(+rx, +ry, -rz);
        this.vertex(-rx, +ry, -rz);
        this.vertex(-rx, +ry, +rz);
        // left (-x)
        this.vertex(-rx, -ry, +rz);
        this.vertex(-rx, -ry, -rz);
        this.vertex(-rx, +ry, -rz);
        this.vertex(-rx, +ry, +rz);
        // slide to otherside
        this.vertex(-rx, -ry, +rz);
        // right (+x)
        this.vertex(+rx, -ry, +rz);
        this.vertex(+rx, -ry, -rz);
        this.vertex(+rx, +ry, -rz);
        this.vertex(+rx, +ry, +rz);
        this.endShape();
    }

    sphere(r, detail = 24) {
        this.ellipsoid(r, r, r, detail, detail);
    }

    // based on: Processing Examples » Topics » Textures » Texture Sphere
    ellipsoid(rx, ry, rz, dx = 24, dy = 24) {
        const numvW = Math.floor(clamp(dx, 1, 50));
        const numvH2pi = Math.floor(clamp(dy, 1, 50));

        // the number of points around the width and height
        const numPointsW = numvW + 1;
        const numPointsH2pi = numvH2pi; // how many actual points around the sphere (not just from top to bottom)
        const numPointsH = Math.ceil(numPointsH2pi / 2) + 1; // how many points from top to bottom

        const coorX = new Float64Array(numPointsW); // all the x-coor in a horizontal circle radius 1
        const coorY = new Float64Array(numPointsH); // all the y-coor in a vertical circle radius 1
        const coorZ = new Float64Array(numPointsW); // all the z-coor in a horizontal circle radius 1
        const multXZ = new Float64Array(numPointsH); // the radius of each horizontal circle

        for (let i = 0; i < numPointsW; i++) {
            const thetaW = i * 2 * PI / (numPointsW - 1);
            coorX[i] = Math.sin(thetaW);
            coorZ[i] = Math.cos(thetaW);
        }

        for (let i = 0; i < numPointsH; i++) {
            if (numPointsH2pi % 2 !== 0 && i === numPointsH - 1) { // odd numPointsH2pi and the last point
                const thetaH = (i - 1) * 2 * PI / numPointsH2pi;
                coorY[i] = Math.cos(PI + thetaH);
                multXZ[i] = 0;
            } else {
                // allows a flat bottom if numPointsH is odd
                const thetaH = i * 2 * PI / numPointsH2pi;
                // PI+ makes the top always the point instead of the bottom
                coorY[i] = Math.cos(PI + thetaH);
                multXZ[i] = Math.sin(thetaH);
            }
        }

        this.beginShape();
        for (let i = 0; i < numPointsH - 1; i++) {
            for (let j = 0; j < numPointsW; j++) {
                this.vertex(coorX[j] * multXZ[i] * rx, coorY[i] * ry, coorZ[j] * multXZ[i] * rz);
                this.vertex(coorX[j] * multXZ[i + 1] * rx, coorY[i + 1] * ry, coorZ[j] * multXZ[i + 1] * rz);
            }
        }
        this.endShape();
    }

    // built upon: https://processing.org/examples/toroid.html
    torus(radius, tubeRadius, dx = 24, dy = 24) {
        dx = Math.floor(clamp(dx, 1, 50));
        dy = Math.floor(clamp(dy, 1, 50));

        const vertices = [];
        const vertices2 = [];
        for (let i = 0; i <= dx; i++) {
            vertices.push({ x: 0, y: 0, z: 0 });
            vertices2.push({ x: 0, y: 0, z: 0 });
        }

        let angle = 0;
        for (let i = 0; i <= dx; i++) {
            vertices[i].x = radius + Math.sin(degToRad(angle)) * tubeRadius;
            vertices[i].z = Math.cos(degToRad(angle)) * tubeRadius;
            angle += 360 / dx;
        }

        let latheAngle = 0;
        for (let i = 0; i <= dy; i++) {
            this.beginShape();
            for (let j = 0; j <= dx; j++) {
                if (i > 0) this.vertex(vertices2[j].x, vertices2[j].y, vertices2[j].z);
                vertices2[j].x = Math.cos(degToRad(latheAngle)) * vertices[j].x;
                vertices2[j].y = Math.sin(degToRad(latheAngle)) * vertices[j].x;
                vertices2[j].z = vertices[j].z;
                this.vertex(vertices2[j].x, vertices2[j].y, vertices2[j].z);
            }
            latheAngle += 360 / dy;
            this.endShape();
        }
    }

    // An XYPolyline, or an array of points.
    polyline(shape) {
        const poly = XYPolyline.from(shape);
        const verts = poly.points;
        if (verts.length < 2) return;
        this.beginShape();
        for (const v of verts) this.vertex(v.x, v.y);
        if (poly.closed) this.vertex(verts[0].x, verts[0].y);
        this.endShape();
    }

    polylines(shapes) {
        for (const shape of shapes) this.polyline(shape);
    }

    // ---------------------------------------------------------------- transforms

    pushMatrix() {
        this.matrixStack.push(this.matrix);
    }

    popMatrix() {
        if (this.matrixStack.length === 0) {
            console.warn('XYscope: popMatrix() without a pushMatrix()');
            return;
        }
        this.matrix = this.matrixStack.pop();
    }

    // p5's names for them
    push() {
        this.pushMatrix();
    }

    pop() {
        this.popMatrix();
    }

    resetMatrix() {
        this.matrix = Mat4.identity();
        this.matrixStack = [];
    }

    translate(x, y, z = 0) {
        this.matrix = Mat4.translate(this.matrix, x, y, z);
    }

    // angles in radians, whatever p5's angleMode() is
    rotate(angle) {
        this.rotateZ(angle);
    }

    rotateX(angle) {
        this.matrix = Mat4.rotate(this.matrix, angle, 0);
    }

    rotateY(angle) {
        this.matrix = Mat4.rotate(this.matrix, angle, 1);
    }

    rotateZ(angle) {
        this.matrix = Mat4.rotate(this.matrix, angle, 2);
    }

    // scale(s), scale(x, y) or scale(x, y, z)
    scale(x, y, z) {
        if (y === undefined) this.matrix = Mat4.scale(this.matrix, x, x, x);
        else this.matrix = Mat4.scale(this.matrix, x, y, z === undefined ? 1 : z);
    }

    // Perspective for 3D points, on by default. Off flattens z.
    perspective(usePerspective) {
        this.usePerspectiveVal = usePerspective;
    }

    // ---------------------------------------------------------------- text

    static fonts() {
        return HersheyFont.getFontNames();
    }

    // True if the font is here; if not, it starts loading and the current font stays.
    textFont(fontName) {
        return this.font.load(fontName);
    }

    // size is the height of a capital letter; setting it also resets the leading
    textSize(size) {
        if (size === undefined) return this.textSizeVal;
        this.textSizeVal = size;
        this.textLeadingVal = size * 1.5;
        return this;
    }

    textLeading(leading) {
        if (leading === undefined) return this.textLeadingVal;
        this.textLeadingVal = leading;
        return this;
    }

    // LEFT, CENTER or RIGHT, and TOP, CENTER, BOTTOM or BASELINE
    textAlign(alignX, alignY = 'top') {
        this.textAlignX = alignX;
        this.textAlignY = alignY;
    }

    text(s, x, y) {
        for (const stroke of this.textPaths(s, x, y)) {
            this.beginShape();
            for (const v of stroke.points) this.vertex(v.x, v.y);
            this.endShape();
        }
    }

    textWidth(s) {
        return this.font.getWidth(s, this.textSizeVal);
    }

    textPaths(s, x, y) {
        return this.font.getStrokes(s, x, y, this.textSizeVal, this.textLeadingVal, this.textAlignX, this.textAlignY);
    }

    getFont() {
        return this.font;
    }

    // ---------------------------------------------------------------- inspection

    // Shapes as normalized 0..1 points. z is 1 on a shape's last point,
    // where the beam blanks, as in XYscope.
    getShapes() {
        return this.shapes;
    }

    // Shapes in canvas pixels.
    getPolylines() {
        return this.shapes.map((shape) => {
            const poly = new XYPolyline();
            for (const p of shape) poly.addVertex(p.x * this.xyWidth, p.y * this.xyHeight);
            return poly;
        });
    }

    wavePoints() {
        return this.shapes.flat();
    }

    // ---------------------------------------------------------------- drawing

    // These draw into the sketch, or into target (a p5.Graphics), with the
    // current stroke weight. Colors are anything stroke() takes.

    drawAll(target) {
        this.drawPath(undefined, target);
        this.drawWaveform(undefined, undefined, target);
        this.drawWave(undefined, target);
        this.drawXY(undefined, target);
        this.drawPoints(undefined, target);
    }

    drawPath(color = 255, target) {
        const g = getTarget(target);
        g.push();
        g.noFill();
        g.stroke(color);
        for (const poly of this.getPolylines()) poly.draw(g);
        g.pop();
    }

    drawPoints(color = [0, 255, 0], target) {
        const g = getTarget(target);
        g.push();
        g.noStroke();
        g.fill(color);
        for (const shape of this.shapes) {
            for (const p of shape) g.circle(p.x * this.xyWidth, p.y * this.xyHeight, 3);
        }
        g.pop();
    }

    // The output signal plotted X against Y, like the scope will show it.
    drawXY(color = [50, 255, 50], target) {
        const nCh = this.lastChannels;
        const samples = this.lastBuffer.view();
        const nFrames = nCh > 0 ? Math.floor(samples.length / nCh) : 0;
        if (nCh < 2 || nFrames < 2) return;

        const g = getTarget(target);
        const hw = this.xyWidth / 2, hh = this.xyHeight / 2;
        g.push();
        g.noFill();
        g.stroke(color);
        g.translate(hw, hh);
        g.beginShape();
        for (let i = 0; i < nFrames; i++) {
            const l = samples[i * nCh];
            const r = samples[i * nCh + 1];
            let lAudio = l * hw;
            let rAudio = r * hh;
            if (this.useVectrex) {
                // undo the Vectrex wiring, so the preview stays upright
                if (this.vectrexRotation === 90) {
                    lAudio = -r * hw;
                    rAudio = l * hh;
                } else if (this.vectrexRotation === -90) {
                    lAudio = r * hw;
                    rAudio = -l * hh;
                } else {
                    lAudio = -l * hw;
                    rAudio = -r * hh;
                }
            }
            g.vertex(lAudio, -rAudio);
        }
        g.endShape();

        if (this.debugWave) {
            const mouseT = sketchMouseX() / this.xyWidth;
            const mx = this.tableX.value(mouseT) * hw * this.ampVal.x;
            const my = -this.tableY.value(mouseT) * hh * this.ampVal.y;
            g.fill(color);
            g.circle(mx, my, 10);
        }
        g.pop();
    }

    // The wavetables: X in the top half, Y in the bottom, Z through the middle.
    drawWaveform(colorX = [50, 50, 255], colorY = [255, 50, 50], target) {
        const g = getTarget(target);
        const w = Math.max(2, Math.floor(this.xyWidth));
        const h = this.xyHeight;
        const plot = (table, centerY) => {
            const wave = table.getWaveformRef();
            g.beginShape();
            for (let i = 0; i < w; i++) g.vertex(i, centerY - h * 0.125 * XYWavetable.valueAt(wave, i / w));
            g.endShape();
        };

        g.push();
        g.noFill();
        g.stroke(colorX);
        plot(this.tableX, h * 0.25);
        g.stroke(colorY);
        plot(this.tableY, h * 0.75);
        if (this.useZ) {
            g.stroke(50, 255, 50);
            plot(this.tableZ, h * 0.5);
        }

        if (this.debugWave) {
            const mouseX = sketchMouseX();
            const t = mouseX / this.xyWidth;
            g.noStroke();
            g.fill(colorX);
            g.circle(mouseX, h * 0.25 - h * 0.125 * this.tableX.value(t), 10);
            g.fill(colorY);
            g.circle(mouseX, h * 0.75 - h * 0.125 * this.tableY.value(t), 10);
        }
        g.pop();
    }

    // The output signal over time: left channel on top, right below.
    drawWave(color = 255, target) {
        const nCh = this.lastChannels;
        const samples = this.lastBuffer.view();
        const nFrames = nCh > 0 ? Math.floor(samples.length / nCh) : 0;
        if (nFrames < 2) return;

        const g = getTarget(target);
        const h = this.xyHeight;
        const centers = [h * 0.25, h * 0.75, h * 0.5];
        g.push();
        g.noFill();
        g.stroke(color);
        for (let c = 0; c < nCh && c < 3; c++) {
            g.beginShape();
            for (let i = 0; i < nFrames; i++) {
                g.vertex(mapValue(i, 0, nFrames, 0, this.xyWidth), centers[c] - h * 0.25 * samples[i * nCh + c]);
            }
            g.endShape();
        }
        g.pop();
    }

    debugView(debug) {
        if (debug === undefined) return this.debugWave;
        this.debugWave = debug;
        return this;
    }

    // ---------------------------------------------------------------- recording

    // Record the output, to download as <name>_<timestamp>.wav
    recorderBegin(name = 'XYscope') {
        this.recordingPath = name + '_' + timestamp('%Y_%m_%d_%H%M%S%i') + '.wav';
        this.recordBuffer.clear();
        this.recordChannels = 0;
        this.recording = true;
        console.log('XYscope: beginRecord');
    }

    // Stop recording and download the WAV. Returns its name, or '' if nothing was recorded.
    recorderEnd() {
        if (!this.recording) return '';
        this.recording = false;
        if (this.recordBuffer.length === 0) {
            console.warn('XYscope: endRecord: nothing was recorded');
            return '';
        }
        const buffer = XYSoundBuffer.wrap(this.recordBuffer.toArray(), this.recordChannels, this.recordSampleRate);
        this.recordBuffer = new XYFloatArray(4096);
        WavFile.save(this.recordingPath, buffer, WavFile.PCM_16);
        console.log('XYscope: endRecord + saved ' + this.recordingPath);
        return this.recordingPath;
    }

    isRecording() {
        return this.recording;
    }

}

//==============================================================
// StreamResampler
//==============================================================

/*
Streaming sample rate conversion for one channel of audio.

The Oscilloscope app drew its lines from audio upsampled to a high
"visual" sample rate (192kHz or more) with FFmpeg's swresample, so the beam
follows the band-limited curve between samples instead of cutting straight
across. This does the same job without FFmpeg: SINC is a windowed sinc
(Lanczos, 4 lobes), like swresample's default filter, and LINEAR matches the
app's "interpolate = false" option.
*/
class StreamResampler {

    constructor() {
        this.inRate = 44100;
        this.outRate = 192000;
        this.interpolation = StreamResampler.SINC;
        this.taps = 4;
        this.step = 44100 / 192000;
        this.history = new XYFloatArray(64);
        this.pos = 0;
        this.reset();
    }

    setup(inRate, outRate, interpolation = StreamResampler.SINC) {
        this.inRate = Math.max(1, inRate);
        this.outRate = Math.max(1, outRate);
        this.interpolation = interpolation;
        this.taps = interpolation === StreamResampler.SINC ? 4 : 1;
        this.step = this.inRate / this.outRate;
        this.reset();
    }

    reset() {
        // start with a little silence, so the first samples have neighbours
        this.history.clear();
        for (let i = 0; i < this.taps; i++) this.history.push(0);
        this.pos = this.taps;
    }

    kernel(x) {
        if (x === 0) return 1;
        const a = this.taps;
        if (Math.abs(x) >= a) return 0;
        const px = PI * x;
        return a * Math.sin(px) * Math.sin(px / a) / (px * px);
    }

    // Converts the next n input samples (input[offset], input[offset + stride]...)
    // and appends the output samples to out, an XYFloatArray.
    process(input, offset, n, stride, out) {
        for (let i = 0; i < n; i++) this.history.push(input[offset + i * stride]);
        const h = this.history.data;
        const size = this.history.length;
        const taps = this.taps;

        // an output sample at pos needs input samples up to floor(pos) + taps
        while (Math.floor(this.pos) + taps < size) {
            const i0 = Math.floor(this.pos);
            const frac = this.pos - i0;

            if (this.interpolation === StreamResampler.LINEAR) {
                out.push(h[i0] + frac * (h[i0 + 1] - h[i0]));
            } else {
                // kernel(pos - k) for each tap. sin(PI * (frac + m)) for a whole
                // number m is just +/- sin(PI * frac), so that one's worked out once.
                const sinFrac = Math.sin(PI * frac);
                let sum = 0;
                let weights = 0;
                for (let k = i0 - taps + 1; k <= i0 + taps; k++) {
                    const x = this.pos - k;
                    let w;
                    if (x === 0) {
                        w = 1;
                    } else if (Math.abs(x) >= taps) {
                        w = 0;
                    } else {
                        const xp = PI * x;
                        const sinX = ((i0 - k) & 1) === 0 ? sinFrac : -sinFrac;
                        w = taps * sinX * Math.sin(xp / taps) / (xp * xp);
                    }
                    sum += w * h[k];
                    weights += w;
                }
                out.push(weights !== 0 ? sum / weights : 0);
            }
            this.pos += this.step;
        }

        // drop the samples that no future output will need
        let keepFrom = Math.floor(this.pos) - taps + 1;
        if (keepFrom > 0) {
            keepFrom = Math.min(keepFrom, size);
            this.history.eraseFront(keepFrom);
            this.pos -= keepFrom;
        }
    }

    getInRate() { return this.inRate; }
    getOutRate() { return this.outRate; }

}

StreamResampler.LINEAR = 'linear';
StreamResampler.SINC = 'sinc';

//==============================================================
// the beam shader
//==============================================================

// The beam: the light a gaussian spot leaves as it sweeps along one
// segment, integrated analytically with erf (after m1el's woscope).
// vUvl.x runs along the segment, vUvl.y across it, vUvl.z is its length.
// Normalized so a beam that stands still peaks at 1.
const BEAM_FUNCTIONS = `
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

const BEAM_VERT = `
attribute vec3 aPosition; // x, y in scope units, and brightness
attribute vec3 aUvl;      // the segment-space coordinates and length
uniform mat3 uTransform;  // scope units -> clip space
varying vec3 vUvl;
varying float vBright;
void main() {
    vUvl = aUvl;
    vBright = aPosition.z;
    vec3 p = uTransform * vec3(aPosition.xy, 1.0);
    gl_Position = vec4(p.xy, 0.0, 1.0);
}
`;

const BEAM_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
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

const FADE_VERT = `
attribute vec2 aPosition;
void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const FADE_FRAG = `
precision mediump float;
uniform vec4 uColor;
void main() {
    gl_FragColor = uColor;
}
`;

/*
The beam draws with WebGL directly, into a WEBGL p5.Graphics of its own
(OsciMesh.createCanvas()). p5 never draws into that canvas, so the two
never trip over each other's GL state, and the result goes into the sketch
with image(), whichever renderer the sketch uses. GLSL ES 1.00, so it runs
on WebGL 1 and 2.
*/
const BeamGL = {

    contexts: new WeakMap(),

    compile(gl, vertSource, fragSource) {
        const shader = (type, source) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, source);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
                console.error('OsciMesh: couldn\'t compile the beam shader\n' + gl.getShaderInfoLog(s));
                return null;
            }
            return s;
        };
        const vert = shader(gl.VERTEX_SHADER, vertSource);
        const frag = shader(gl.FRAGMENT_SHADER, fragSource);
        if (!vert || !frag) return null;
        const program = gl.createProgram();
        gl.attachShader(program, vert);
        gl.attachShader(program, frag);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error('OsciMesh: couldn\'t link the beam shader\n' + gl.getProgramInfoLog(program));
            return null;
        }
        return program;
    },

    // the programs for one GL context, built the first time it's used
    get(gl) {
        if (!gl || typeof gl.createProgram !== 'function') {
            console.error('OsciMesh: draw into a WEBGL p5.Graphics, such as OsciMesh.createCanvas() makes');
            return null;
        }
        if (this.contexts.has(gl)) return this.contexts.get(gl);

        let programs = null;
        const beam = this.compile(gl, BEAM_VERT, BEAM_FRAG);
        const fade = this.compile(gl, FADE_VERT, FADE_FRAG);
        if (beam && fade) {
            const quad = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, quad);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
            programs = {
                beam: {
                    program: beam,
                    aPosition: gl.getAttribLocation(beam, 'aPosition'),
                    aUvl: gl.getAttribLocation(beam, 'aUvl'),
                    uTransform: gl.getUniformLocation(beam, 'uTransform'),
                    uSize: gl.getUniformLocation(beam, 'uSize'),
                    uIntensity: gl.getUniformLocation(beam, 'uIntensity'),
                    uRgb: gl.getUniformLocation(beam, 'uRgb')
                },
                fade: {
                    program: fade,
                    aPosition: gl.getAttribLocation(fade, 'aPosition'),
                    uColor: gl.getUniformLocation(fade, 'uColor')
                },
                quad
            };
        }
        this.contexts.set(gl, programs);
        return programs;
    },

    prepare(gl) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);
        gl.disable(gl.SCISSOR_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.colorMask(true, true, true, true);
    },

    clear(gl, r = 0, g = 0, b = 0, a = 1) {
        this.prepare(gl);
        gl.clearColor(r, g, b, a);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    },

    // Keep this much of what's there: a black rectangle with multiply
    // blending (DST_COLOR, ONE_MINUS_SRC_ALPHA), as oF's OF_BLENDMODE_MULTIPLY.
    fade(gl, keep) {
        const programs = this.get(gl);
        if (!programs) return;
        this.prepare(gl);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA);
        const p = programs.fade;
        gl.useProgram(p.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, programs.quad);
        gl.enableVertexAttribArray(p.aPosition);
        gl.vertexAttribPointer(p.aPosition, 2, gl.FLOAT, false, 0, 0);
        gl.uniform4f(p.uColor, 0, 0, 0, 1 - clamp(keep, 0, 1));
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.disableVertexAttribArray(p.aPosition);
    }

};

//==============================================================
// OsciMesh
//==============================================================

/*
A port of OsciMesh from Hansi Raber's Oscilloscope app, the renderer at the
heart of the audio-to-vector half of the library.

Every pair of neighbouring samples becomes a quad around the line between
them, and a shader fills the quad with the light a gaussian electron beam
leaves as it sweeps along that line (the technique from m1el's woscope).
A beam that moves quickly between two samples spreads its light thinly, so
fast strokes come out dim and slow ones bright, the way they do on a real
CRT. Drawn additively into a slowly fading canvas (see Oscilloscope), this
is what gives the image its glow and persistence.

Differences from ofxTwoscilloscope:
* draw(target, transform) draws into a WEBGL p5.Graphics, which
  OsciMesh.createCanvas() makes, rather than with the current oF matrices.
  transform is an affine {a, b, c, d, e, f} from scope units (-1..1, y up)
  to the target's pixels, as in canvas setTransform():
  x' = a x + c y + e, y' = b x + d y + f. Leave it out to fit -1..1 to the
  shorter side, centered.
* addLines() takes typed arrays; pass subarray()s to start part way in.
*/
class OsciMesh {

    constructor() {
        // the original's shader parameters
        this.uSize = 0.01;       // beam radius in scope units
        this.uRgb = [1, 1, 1];   // beam color, 0..1
        this.uIntensity = 1;
        // x, y, brightness, then u, v and length, for each of 6 vertices a line
        this.vertices = new XYFloatArray(36 * 1024);
        this.last = { x: 0, y: 0 };
        this.gl = null;
        this.buffer = null;
    }

    // A canvas for beams: a WEBGL p5.Graphics, cleared to black.
    static createCanvas(width, height) {
        const p = getP5();
        if (!p) throw new Error('OsciMesh: create beam canvases once the sketch has started');
        const g = p.createGraphics(width, height, 'webgl');
        BeamGL.clear(g.drawingContext);
        return g;
    }

    static clearCanvas(target, r = 0, g = 0, b = 0, a = 1) {
        BeamGL.clear(target.drawingContext, r, g, b, a);
    }

    // Add many lines at once.
    // left: x coordinates (-1..1)
    // right: y coordinates (-1..1)
    // bright: brightness (0..1), or null for full brightness
    // stride: step between samples in left and right (not bright)
    addLines(left, right, bright, n, stride = 1) {
        // no work? go home watch tv or something
        if (n <= 0 || stride <= 0) return;

        this.addLine(this.last.x, this.last.y, left[0], right[0], bright ? bright[0] : 1);
        const lastIndex = Math.floor((n - 1) / stride) * stride;
        this.last = { x: left[lastIndex], y: right[lastIndex] };

        this.vertices.reserve(this.vertices.length + 36 * (Math.floor(n / stride) + 1));
        for (let i = stride; i < n; i += stride) {
            this.addLine(left[i - stride], right[i - stride], left[i], right[i], bright ? bright[i] : 1);
        }
    }

    // Add one line from (x0, y0) to (x1, y1) (-1..1), with brightness 0..1.
    addLine(x0, y0, x1, y1, bright = 1) {
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

        const v = this.vertices;
        if (v.length + 36 > v.data.length) v.reserve(v.length + 36);
        const d = v.data;
        let k = v.length;
        const ax = x0 - dx, ay = y0 - dy;
        const bx = x1 + dx, by = y1 + dy;
        // p0 - dir - norm, p0 - dir + norm, p1 + dir - norm
        d[k] = ax - nx; d[k + 1] = ay - ny; d[k + 2] = bright; d[k + 3] = -size; d[k + 4] = -size; d[k + 5] = z; k += 6;
        d[k] = ax + nx; d[k + 1] = ay + ny; d[k + 2] = bright; d[k + 3] = -size; d[k + 4] = size; d[k + 5] = z; k += 6;
        d[k] = bx - nx; d[k + 1] = by - ny; d[k + 2] = bright; d[k + 3] = z + size; d[k + 4] = -size; d[k + 5] = z; k += 6;
        // p0 - dir + norm, p1 + dir - norm, p1 + dir + norm
        d[k] = ax + nx; d[k + 1] = ay + ny; d[k + 2] = bright; d[k + 3] = -size; d[k + 4] = size; d[k + 5] = z; k += 6;
        d[k] = bx - nx; d[k + 1] = by - ny; d[k + 2] = bright; d[k + 3] = z + size; d[k + 4] = -size; d[k + 5] = z; k += 6;
        d[k] = bx + nx; d[k + 1] = by + ny; d[k + 2] = bright; d[k + 3] = z + size; d[k + 4] = size; d[k + 5] = z; k += 6;
        v.length = k;
    }

    getNumVertices() {
        return this.vertices.length / 6;
    }

    clear() {
        this.vertices.clear();
    }

    // Draw additively into target, a WEBGL p5.Graphics.
    draw(target, transform) {
        const count = this.vertices.length / 6;
        if (count === 0 || !target) return;
        const gl = target.drawingContext;
        const programs = BeamGL.get(gl);
        if (!programs) return;

        const w = target.width, h = target.height;
        if (!transform) {
            const s = Math.min(w, h) / 2;
            transform = { a: s, b: 0, c: 0, d: -s, e: w / 2, f: h / 2 };
        }
        if (this.gl !== gl) {
            this.gl = gl;
            this.buffer = gl.createBuffer();
        }

        BeamGL.prepare(gl);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // oF's OF_BLENDMODE_ADD

        const p = programs.beam;
        gl.useProgram(p.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.vertices.view(), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(p.aPosition);
        gl.vertexAttribPointer(p.aPosition, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(p.aUvl);
        gl.vertexAttribPointer(p.aUvl, 3, gl.FLOAT, false, 24, 12);

        // scope units -> pixels -> clip space
        const t = transform;
        gl.uniformMatrix3fv(p.uTransform, false, [
            2 * t.a / w, -2 * t.b / h, 0,
            2 * t.c / w, -2 * t.d / h, 0,
            2 * t.e / w - 1, 1 - 2 * t.f / h, 1
        ]);
        gl.uniform1f(p.uSize, this.uSize);
        gl.uniform1f(p.uIntensity, this.uIntensity);
        gl.uniform3f(p.uRgb, this.uRgb[0], this.uRgb[1], this.uRgb[2]);
        gl.drawArrays(gl.TRIANGLES, 0, count);

        gl.disableVertexAttribArray(p.aPosition);
        gl.disableVertexAttribArray(p.aUvl);
    }

}

//==============================================================
// Oscilloscope
//==============================================================

/*
The audio-to-vector half of the library: the rendering pipeline of Hansi
Raber's Oscilloscope app (https://github.com/kritzikratzi/Oscilloscope),
taken out of the app and packed into one class.

Feed it audio (an XYPlayer, an XYAudioInput, an XYscope's onAudioOut), then
update() and draw() it each frame:

    let scope;

    function setup() {
        createCanvas(512, 512);
        scope = new Oscilloscope();
        scope.setup(width, height);
        input.onAudioIn = (buffer) => scope.addBuffer(buffer);
    }

    function draw() {
        scope.update();
        scope.draw();
    }

The channels decide the layout, as they did for the app's audio files:
1 channel draws the signal against a sawtooth sweep, 2 are X and Y, 3 are
X, Y and Z (brightness), 4 are two stereo pairs drawn as a red/cyan
anaglyph.

getShapes() turns the most recent audio back into vector shapes with
XYDecoder.

Differences from ofxTwoscilloscope:
* The beam renders into a WEBGL p5.Graphics (getGraphics()) in place of an
  FBO, and draw() puts it in the sketch with image().
* zRange is {min, max} rather than a glm::vec2.
* Audio arrives on the main thread, so there's no mutex.
* The app's Globals settings are plain properties, as in ofxTwoscilloscope,
  and audio is upsampled to the visual rate (192kHz by default) with
  StreamResampler. Z is read through zRange: the default (0, 1) shows the
  app's 0..1 brightness as-is and blanks XYscope's -1 (beam off) level.
*/

// How bright the beam is at intensity 1, for audio upsampled to 192kHz.
// Beam light builds up with every sample drawn, so it's scaled by the
// visual sample rate to look the same at any rate.
const BEAM_GAIN = 0.15;
// never queue more than this many seconds of samples for update(), so a
// slow frame can't snowball into a bigger mesh and an even slower frame
const MAX_PENDING_SECONDS = 1 / 15;
// keep this many seconds of input for getShapes()
const HISTORY_SECONDS = 2;
// the window getShapes() searches for a loop
const DECODE_SECONDS = 0.5;

class Oscilloscope {

    constructor() {
        this.width = 512;
        this.height = 512;
        this.visualSampleRate = 192000;

        // Decode settings for getShapes(); set freq if you know it.
        this.decoderSettings = new XYDecoderSettings();

        this.scale = 1;              // 1 fills the shorter side of the canvas
        this.invertX = false;
        this.invertY = false;
        this.flipXY = false;
        this.zModulation = true;
        this.zRange = { min: 0, max: 1 }; // Z values for black and full brightness

        this.strokeWeight = 10;      // 1..20
        this.intensity = 0.4;        // 0..1
        this.afterglow = 0.5;        // 0..1, how much of each frame is left for the next
        this.hue = 50;               // 0..360, 360 is white
        this.interpolation = StreamResampler.SINC;

        this.mesh = new OsciMesh();
        this.mesh2 = new OsciMesh(); // the second pair in QUAD layout

        this.graphics = null;
        this.changed = false;
        this.needsClear = true;
        this.dropped = 0;
        this.sweep = 0;

        this.layout = Oscilloscope.STEREO;
        this.numChannels = 0;
        this.sourceSampleRate = 0;
        this.activeInterpolation = StreamResampler.SINC;
        this.resamplers = [];
        // visual rate samples waiting for update()
        this.pending = [];
        // source rate history for getShapes()
        this.history = new XYFloatArray(44100 * 3);
        this.historyFrames = 0;
        this.detectedPeriod = 0;
    }

    setup(width, height, visualSampleRate = 192000) {
        this.resize(width, height);
        this.setVisualSampleRate(visualSampleRate);
        return this;
    }

    resize(width, height) {
        this.width = Math.max(1, Math.round(width));
        this.height = Math.max(1, Math.round(height));
        this.needsClear = true;
    }

    setVisualSampleRate(rate) {
        this.visualSampleRate = Math.max(8000, rate);
        this.numChannels = 0; // reconfigure on the next samples
    }

    getVisualSampleRate() {
        return this.visualSampleRate;
    }

    configure(numChannels, sampleRate) {
        this.numChannels = numChannels;
        this.sourceSampleRate = sampleRate;
        this.activeInterpolation = this.interpolation;

        switch (numChannels) {
            case 1: this.layout = Oscilloscope.MONO; break;
            case 2: this.layout = Oscilloscope.STEREO; break;
            case 3: this.layout = Oscilloscope.STEREO_ZMODULATED; break;
            default: this.layout = numChannels >= 4 ? Oscilloscope.QUAD : Oscilloscope.STEREO; break;
        }

        const used = Math.min(numChannels, 4);
        this.resamplers = [];
        this.pending = [];
        for (let c = 0; c < used; c++) {
            const resampler = new StreamResampler();
            resampler.setup(sampleRate, this.visualSampleRate, this.interpolation);
            this.resamplers.push(resampler);
            this.pending.push(new XYFloatArray(8192));
        }
        this.history.clear();
        this.historyFrames = 0;
    }

    // ---------------------------------------------------------------- input

    addSamples(interleaved, numFrames, numChannels, sampleRate) {
        if (!interleaved || numFrames <= 0 || numChannels <= 0) return;
        if (!(sampleRate > 0)) sampleRate = 44100;

        if (numChannels !== this.numChannels || sampleRate !== this.sourceSampleRate || this.interpolation !== this.activeInterpolation) {
            this.configure(numChannels, sampleRate);
        }

        // the visual stream, upsampled
        const used = this.resamplers.length;
        for (let c = 0; c < used; c++) {
            this.resamplers[c].process(interleaved, c, numFrames, numChannels, this.pending[c]);
        }

        const maxPending = Math.floor(this.visualSampleRate * MAX_PENDING_SECONDS);
        if (this.pending.length > 0 && this.pending[0].length > maxPending) {
            const excess = this.pending[0].length - maxPending;
            for (const p of this.pending) p.eraseFront(Math.min(excess, p.length));
            this.dropped++;
        }

        // the source stream, for decoding shapes
        const history = this.history;
        history.reserve(history.length + numFrames * used);
        const data = history.data;
        let k = history.length;
        for (let i = 0; i < numFrames; i++) {
            const frame = i * numChannels;
            for (let c = 0; c < used; c++) data[k++] = interleaved[frame + c];
        }
        history.length = k;
        this.historyFrames += numFrames;
        const maxFrames = Math.floor(sampleRate * HISTORY_SECONDS);
        if (this.historyFrames > 2 * maxFrames) {
            // trim now and then rather than on every buffer
            const drop = this.historyFrames - maxFrames;
            history.eraseFront(drop * used);
            this.historyFrames = maxFrames;
        }
    }

    addBuffer(buffer) {
        this.addSamples(buffer.samples, buffer.numFrames, buffer.numChannels, buffer.sampleRate);
    }

    // so an Oscilloscope can be an XYAudioInput's listener: input.onAudioIn = (b) => scope.audioIn(b)
    audioIn(buffer) {
        this.addBuffer(buffer);
    }

    clear() {
        for (const resampler of this.resamplers) resampler.reset();
        for (const p of this.pending) p.clear();
        this.history.clear();
        this.historyFrames = 0;
        this.needsClear = true;
    }

    // ---------------------------------------------------------------- update/draw

    update() {
        const samples = this.pending.map((p) => p.toArray());
        for (const p of this.pending) p.clear();
        const layout = this.layout;

        this.mesh.clear();
        this.mesh2.clear();
        this.mesh.uSize = this.strokeWeight / 1000;
        this.mesh2.uSize = this.mesh.uSize;

        if (samples.length === 0 || samples[0].length === 0) return;
        this.changed = true;
        const n = samples[0].length;

        switch (layout) {
            case Oscilloscope.MONO: {
                // a sawtooth sweeps the beam across, as on a scope in Y-T mode
                const sweepX = new Float32Array(n);
                for (let i = 0; i < n; i++) {
                    sweepX[i] = -1 + 2 * this.sweep;
                    this.sweep += 1 / 2048;
                    if (this.sweep >= 1) this.sweep -= 1;
                }
                this.mesh.addLines(sweepX, samples[0], null, n);
                break;
            }
            case Oscilloscope.STEREO:
                this.mesh.addLines(samples[0], samples[1], null, n);
                break;
            case Oscilloscope.STEREO_ZMODULATED: {
                let bright = null;
                if (this.zModulation) {
                    bright = new Float32Array(n);
                    const range = this.zRange.max - this.zRange.min;
                    for (let i = 0; i < n; i++) {
                        bright[i] = range !== 0 ? clamp((samples[2][i] - this.zRange.min) / range, 0, 1) : 1;
                    }
                }
                this.mesh.addLines(samples[0], samples[1], bright, n);
                break;
            }
            case Oscilloscope.QUAD:
                this.mesh.addLines(samples[0], samples[1], null, n);
                this.mesh2.addLines(samples[2], samples[3], null, n);
                break;
        }
    }

    drawMesh() {
        const w = this.width, h = this.height;
        const s = Math.min(w, h) / 2 * this.scale;
        // scope +Y is up
        const sx = s * (this.invertX ? -1 : 1);
        const sy = -s * (this.invertY ? -1 : 1);
        const transform = this.flipXY ?
            { a: 0, b: sy, c: sx, d: 0, e: w / 2, f: h / 2 } :
            { a: sx, b: 0, c: 0, d: sy, e: w / 2, f: h / 2 };

        const gain = this.intensity * BEAM_GAIN * 192000 / this.visualSampleRate;
        this.mesh.uIntensity = gain;
        this.mesh2.uIntensity = gain;

        if (this.layout === Oscilloscope.QUAD) {
            this.mesh.uRgb = [1, 0, 0];
            this.mesh2.uRgb = [0, 1, 1];
        } else if (this.hue >= 360) {
            this.mesh.uRgb = [1, 1, 1];
        } else {
            this.mesh.uRgb = hsbToRgb(this.hue / 360, 1, 1);
        }

        this.mesh.draw(this.graphics, transform);
        this.mesh2.draw(this.graphics, transform);
    }

    // Bring the beam canvas up to date: fade it, then draw the new samples.
    render() {
        if (!this.graphics || this.graphics.width !== this.width || this.graphics.height !== this.height) {
            if (this.graphics) this.graphics.remove();
            this.graphics = OsciMesh.createCanvas(this.width, this.height);
            this.needsClear = true;
        }
        const gl = this.graphics.drawingContext;

        if (this.needsClear) {
            BeamGL.clear(gl);
            this.needsClear = false;
        }

        if (this.changed) {
            // the afterglow: fade what's there, rather than clearing it
            BeamGL.fade(gl, this.afterglow);
            this.drawMesh();
            this.changed = false;
        }
        return this.graphics;
    }

    // Draw the beam into the sketch (or target, a p5.Graphics), scaled to w x h.
    draw(x = 0, y = 0, w = this.width, h = this.height, target) {
        this.render();
        const g = getTarget(target);
        g.push();
        g.noTint();
        g.image(this.graphics, x, y, w, h);
        g.pop();
    }

    // the beam canvas, a WEBGL p5.Graphics (oF's getFbo())
    getGraphics() {
        return this.render();
    }

    // ---------------------------------------------------------------- vector shapes

    // The last couple of seconds of input at its own sample rate.
    getHistory() {
        return XYSoundBuffer.wrap(this.history.toArray(), Math.max(1, this.resamplers.length), this.sourceSampleRate > 0 ? this.sourceSampleRate : 44100);
    }

    // Decode the most recent audio into XYPolylines on a width x height canvas.
    // Uses the source sample rate; set decoderSettings.freq if you know it.
    getShapes(width, height) {
        const s = this.decoderSettings.copy();
        s.width = width;
        s.height = height;
        s.zMin = this.zRange.min;
        s.zMax = this.zRange.max;
        s.useZ = s.useZ && this.zModulation;

        // copy out only the most recent stretch
        const nCh = Math.max(1, this.resamplers.length);
        s.sampleRate = this.sourceSampleRate > 0 ? this.sourceSampleRate : 44100;
        const total = Math.floor(this.history.length / nCh);
        const n = Math.min(total, Math.floor(s.sampleRate * DECODE_SECONDS));
        const start = total - n;
        const x = new Float32Array(n), y = new Float32Array(n);
        const z = nCh === 3 ? new Float32Array(n) : null;
        const history = this.history.data;
        for (let i = 0; i < n; i++) {
            const frame = (start + i) * nCh;
            if (nCh === 1) {
                y[i] = history[frame];
            } else {
                x[i] = history[frame];
                y[i] = history[frame + 1];
                if (z) z[i] = history[frame + 2];
            }
        }
        if (n < 2) return [];

        if (nCh === 1) {
            this.detectedPeriod = 0;
            return XYDecoder.decode(XYSoundBuffer.wrap(y, 1, s.sampleRate), s);
        }

        if (s.freq > 0) {
            this.detectedPeriod = s.sampleRate / s.freq;
        } else {
            // keep the last period while the signal still loops at it (and not at half of it)
            const stillLoops = this.detectedPeriod > 0 &&
                XYDecoder.periodError(x, y, n, this.detectedPeriod) < 0.02 &&
                XYDecoder.periodError(x, y, n, this.detectedPeriod / 2) > 0.1;
            if (!stillLoops) {
                this.detectedPeriod = XYDecoder.detectPeriod(x, y, n, s.sampleRate / Math.max(1, s.maxFreq),
                    s.sampleRate / Math.max(1, s.minFreq));
            }
            if (this.detectedPeriod > 0) s.freq = s.sampleRate / this.detectedPeriod;
        }

        return XYDecoder.decode(x, y, z, n, s);
    }

    // The loop period found by the last getShapes(), in samples (0 = none).
    getDetectedPeriod() { return this.detectedPeriod; }
    getLayout() { return this.layout; }
    getSourceSampleRate() { return this.sourceSampleRate; }
    // how many sample batches were dropped to keep up (the app's "Dropped")
    getDropped() { return this.dropped; }

}

Oscilloscope.MONO = 0;              // signal on Y, swept along X by a sawtooth
Oscilloscope.STEREO = 1;            // X-Y
Oscilloscope.STEREO_ZMODULATED = 2; // X-Y plus brightness
Oscilloscope.QUAD = 3;              // two X-Y pairs, red and cyan

//==============================================================
// XYDecoder
//==============================================================

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
class XYDecoderSettings {

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
                pts.push({ x: ptsX[i], y: ptsY[i] });
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

const XYDecoder = {

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

//==============================================================
// XYPlayer
//==============================================================

/*
Plays an XY audio file to the sound card and feeds the same audio to an
Oscilloscope, which is the job OsciAvAudioPlayer did in the Oscilloscope app.

    let player, scope;

    function setup() {
        createCanvas(512, 512);
        scope = new Oscilloscope();
        scope.setup(width, height);
        player = new XYPlayer();
        player.setScope(scope);
        player.setLoop(true);
        player.openAudioOut();
        player.load('data/xyscope.wav').then(() => player.play());
    }

    function draw() {
        player.update(deltaTime / 1000);   // feeds the scope
        scope.update();
        scope.draw();
    }

Differences from ofxTwoscilloscope:
* The browser plays the file, through an AudioBufferSourceNode that
  resamples to the sound card's rate, and update() feeds the scope from the
  same samples on the audio clock, every frame. So call update() every frame,
  sound card or not. Without one (or until the page is clicked) it plays
  silently, the given seconds at a time.
* load() fetches a URL or reads a File, and resolves to true once the file
  is in. WAVs are read by WavFile, at their own sample rate. Anything else
  the browser can decode (MP3, FLAC, Ogg...) is decoded at the sound card's
  rate.
* onEnd is called on the main thread.
* As in the oF version, a mono file plays on both speakers and the channels
  past X and Y (Z) only go to the scope.
*/

// never feed the scope more than this many seconds at once, after a stall
const MAX_FEED_SECONDS = 1;

class XYPlayer {

    constructor() {
        this.sound = null;
        this.filename = '';
        this.position = 0; // in file frames
        this.playing = false;
        this.looping = false;
        this.volume = 1;
        this.scope = null;
        // called when playback reaches the end
        this.onEnd = null;

        this.audioOutOpen = false;
        this.audioBuffer = null;
        this.gain = null;
        this.source = null;
        this.clock = 0; // audio clock at the last update()
    }

    // Load a WAV (or anything the browser decodes) from a URL or a File.
    // Resolves to true once it's in, false if it couldn't be read.
    load(urlOrFile) {
        const isFile = typeof Blob !== 'undefined' && urlOrFile instanceof Blob;
        const name = isFile ? (urlOrFile.name || 'file') : String(urlOrFile).split(/[?#]/)[0].split('/').pop();
        const bytes = isFile ? urlOrFile.arrayBuffer() : fetch(urlOrFile).then((response) => {
            if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
            return response.arrayBuffer();
        });
        return bytes.then((data) => {
            const wav = WavFile.decode(data, true);
            if (wav) return wav;
            // not a WAV: try the browser's decoders
            const ctx = XYAudio.getContext();
            if (!ctx) return null;
            return ctx.decodeAudioData(data).then((audio) => {
                const buffer = new XYSoundBuffer(audio.length, audio.numberOfChannels, audio.sampleRate);
                for (let c = 0; c < audio.numberOfChannels; c++) {
                    const channel = audio.getChannelData(c);
                    for (let i = 0; i < audio.length; i++) buffer.samples[i * audio.numberOfChannels + c] = channel[i];
                }
                return buffer;
            }, () => null);
        }).then((buffer) => {
            if (!buffer) {
                console.error('XYPlayer: couldn\'t read ' + name);
                return false;
            }
            this.setBuffer(buffer, name);
            return true;
        }, (err) => {
            console.error('XYPlayer: couldn\'t load ' + name + ' (' + err.message + ')');
            return false;
        });
    }

    setBuffer(buffer, name = '') {
        this.stopSource();
        this.sound = buffer;
        if (!(this.sound.sampleRate > 0)) this.sound.sampleRate = 44100;
        this.filename = name;
        this.position = 0;
        this.audioBuffer = null;
        if (this.scope) this.scope.clear();
    }

    unload() {
        this.stopSource();
        this.sound = null;
        this.audioBuffer = null;
        this.filename = '';
        this.position = 0;
        this.playing = false;
    }

    setScope(scope) {
        this.scope = scope;
    }

    // Play through the default sound card (once the page has been clicked).
    // Resolves to false if there's no Web Audio.
    openAudioOut() {
        const ctx = XYAudio.getContext();
        if (!ctx) return Promise.resolve(false);
        if (!this.gain) {
            this.gain = ctx.createGain();
            this.gain.gain.value = this.volume;
            this.gain.connect(ctx.destination);
        }
        this.audioOutOpen = true;
        return Promise.resolve(true);
    }

    closeAudioOut() {
        this.stopSource();
        if (this.gain) {
            this.gain.disconnect();
            this.gain = null;
        }
        this.audioOutOpen = false;
    }

    // playing out of the sound card, rather than silently
    isAudioRunning() {
        return this.audioOutOpen && XYAudio.isRunning();
    }

    feedScope(from, to) {
        if (!this.scope || !this.sound) return;
        const n = this.sound.numFrames;
        const a = Math.max(0, Math.floor(from));
        const b = Math.min(n, Math.max(0, Math.floor(to)));
        if (b <= a) return;
        const nCh = this.sound.numChannels;
        this.scope.addSamples(this.sound.samples.subarray(a * nCh, b * nCh), b - a, nCh, this.sound.sampleRate);
    }

    // Feed the scope everything between two positions, wrapping around the
    // end of a looping file. Ends playback at the end of one that doesn't loop.
    advanceTo(target) {
        const n = this.sound.numFrames;
        const maxFrames = MAX_FEED_SECONDS * this.sound.sampleRate;
        if (target - this.position > maxFrames) {
            // after a stall: skip ahead rather than feed the scope a backlog
            const skipped = target - maxFrames;
            this.position = this.looping ? skipped % n : Math.min(skipped, n);
            if (this.looping) target = this.position + maxFrames;
        }
        let ended = false;
        while (target >= n) {
            this.feedScope(this.position, n);
            if (!this.looping) {
                this.playing = false;
                ended = true;
                this.position = n;
                break;
            }
            target -= n;
            this.position = 0;
        }
        if (!ended) {
            this.feedScope(this.position, target);
            this.position = target;
        }
        return ended;
    }

    // Call every frame. Plays on the audio clock when the sound card is
    // running, and otherwise advances by this many seconds, silently.
    update(seconds) {
        if (!this.sound || this.sound.numFrames === 0) return;
        const rate = this.sound.sampleRate;
        let ended = false;

        if (this.playing && this.isAudioRunning()) {
            // follow the source on the audio clock; it wraps (or ends) where advanceTo() does
            const now = XYAudio.context.currentTime;
            if (!this.source) {
                this.startSource();
                this.clock = now;
            }
            const elapsed = (now - this.clock) * rate;
            this.clock = now;
            ended = this.advanceTo(this.position + elapsed);
            if (ended) this.stopSource();
        } else {
            if (this.source) this.stopSource();
            if (this.playing && seconds > 0) ended = this.advanceTo(this.position + seconds * rate);
        }

        if (ended && this.onEnd) this.onEnd();
    }

    startSource() {
        const ctx = XYAudio.context;
        if (!this.audioBuffer) {
            // X and Y only (or the one channel of a mono file); Z stays out of the speakers
            const nCh = Math.min(2, this.sound.numChannels);
            const frames = this.sound.numFrames;
            this.audioBuffer = ctx.createBuffer(nCh, Math.max(1, frames), this.sound.sampleRate);
            for (let c = 0; c < nCh; c++) {
                const channel = this.audioBuffer.getChannelData(c);
                const all = this.sound.numChannels;
                for (let i = 0; i < frames; i++) channel[i] = this.sound.samples[i * all + c];
            }
        }
        this.source = ctx.createBufferSource();
        this.source.buffer = this.audioBuffer;
        this.source.loop = this.looping;
        this.source.connect(this.gain);
        this.source.start(0, clamp(this.position, 0, this.sound.numFrames - 1) / this.sound.sampleRate);
    }

    stopSource() {
        if (!this.source) return;
        try {
            this.source.stop();
        } catch (e) {
            // already stopped
        }
        this.source.disconnect();
        this.source = null;
    }

    play() {
        if (!this.sound || this.sound.numFrames === 0) return;
        if (this.position >= this.sound.numFrames) this.position = 0;
        this.playing = true;
    }

    stop() {
        this.playing = false;
        this.stopSource();
    }

    setPaused(paused) {
        if (paused) this.stop();
        else this.play();
    }

    setLoop(loop) {
        this.looping = loop;
        this.stopSource(); // restarts in the next update(), looping or not
    }

    setVolume(volume) {
        this.volume = volume;
        if (this.gain) this.gain.gain.value = volume;
    }

    setPosition(pct) {
        this.position = clamp(pct, 0, 1) * (this.sound ? this.sound.numFrames : 0);
        this.stopSource();
    }

    setPositionMS(ms) {
        if (!this.sound) return;
        this.position = clamp(ms / 1000 * this.sound.sampleRate, 0, this.sound.numFrames);
        this.stopSource();
    }

    isLoaded() { return this.sound !== null && this.sound.numFrames > 0; }
    isPlaying() { return this.playing; }
    getLoop() { return this.looping; }
    getPosition() { return this.sound && this.sound.numFrames > 0 ? this.position / this.sound.numFrames : 0; }
    getPositionMS() { return this.sound ? Math.floor(this.position * 1000 / this.sound.sampleRate) : 0; }
    getDurationMS() { return this.sound ? Math.floor(this.sound.numFrames * 1000 / this.sound.sampleRate) : 0; }
    getNumChannels() { return this.sound ? this.sound.numChannels : 0; }
    getSampleRate() { return this.sound ? this.sound.sampleRate : 0; }
    getFilename() { return this.filename; }
    // the whole file
    getBuffer() { return this.sound; }

}

//==============================================================
// XYAudioInput
//==============================================================

/*
The line input (or microphone), in place of an ofSoundStream with input
channels. The browser asks for permission the first time.

    input = new XYAudioInput();
    input.onAudioIn = (buffer) => scope.addBuffer(buffer);
    input.open();    // from a click or key press

Echo cancellation, noise suppression and automatic gain are turned off,
since they would mangle an XY signal. Many inputs are mono, and browsers
often hand over a stereo input as mono unless asked otherwise; buffers come
with however many channels the input really has.
*/
class XYAudioInput {

    constructor() {
        // called with each block of input, numChannels interleaved
        this.onAudioIn = null;
        this.stream = null;
        this.source = null;
        this.node = null;
        this.opened = false;
    }

    // Resolves to true once the input is listening.
    open(numChannels = 2, blockFrames = 512) {
        this.close();
        const ctx = XYAudio.getContext();
        if (!ctx || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            console.warn('XYAudioInput: no audio input here (it needs https://, or http://localhost or 127.0.0.1)');
            return Promise.resolve(false);
        }
        XYAudio.resume();
        const request = this.request = {};
        return XYAudio.loadWorklet().then((ok) => {
            if (!ok) return null;
            return navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: { ideal: numChannels },
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });
        }).then((stream) => {
            if (!stream) return false;
            if (request !== this.request) {
                for (const track of stream.getTracks()) track.stop();
                return false;
            }
            this.stream = stream;
            this.source = ctx.createMediaStreamSource(stream);
            this.node = new AudioWorkletNode(ctx, 'xycapture-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                channelCountMode: 'max',
                channelInterpretation: 'discrete',
                processorOptions: { blockFrames, maxChannels: numChannels }
            });
            this.node.port.onmessage = (e) => {
                const m = e.data;
                if (m.type === 'audio' && this.onAudioIn) this.onAudioIn(XYSoundBuffer.wrap(m.samples, m.numChannels, m.sampleRate));
            };
            this.source.connect(this.node);
            // it only outputs silence, but it has to be connected to run
            this.node.connect(ctx.destination);
            this.opened = true;
            return true;
        }).catch((err) => {
            console.warn('XYAudioInput: couldn\'t open the audio input (' + err.message + ')');
            return false;
        });
    }

    close() {
        this.request = null;
        if (this.node) {
            this.node.port.postMessage({ type: 'stop' });
            this.node.port.onmessage = null;
            this.node.disconnect();
            this.node = null;
        }
        if (this.source) {
            this.source.disconnect();
            this.source = null;
        }
        if (this.stream) {
            for (const track of this.stream.getTracks()) track.stop();
            this.stream = null;
        }
        this.opened = false;
    }

    isOpen() {
        return this.opened;
    }

}

//==============================================================
// XYEffects
//==============================================================

/*
Audio effects for XY signals: the tools XYTransformer uses to turn one
vector shape into another by treating the shape as sound.

Each effect works on X (channel 0) and Y (channel 1) and passes Z through
untouched, so a time-based effect moves the beam relative to its blanking,
as it would if only X and Y went through a real effects unit.

What they do to a shape:
    XYLowPass       rounds corners and swallows small detail
    XYHighPass      AC coupling: shapes sag and smear, like a cheap sound card
    XYChannelDelay  delays X or Y, shearing the shape and opening lines into loops
    XYEcho          ghost copies from earlier in the loop, blended in
    XYBitCrush      snaps the beam to a coarse grid
    XYSampleHold    lowers the sample rate: steps, corners and stray dots
    XYDrive         tanh saturation pushes shapes out towards a rounded square
    XYWavefold      folds the signal back at the edges, a kaleidoscope
    XYRingMod       multiplies by a sine: shapes pulse in and out of the center
    XYNoise         jitter (seeded, so the same settings give the same shape)
    XYRotate        mixes X and Y with a rotation matrix, optionally spinning

Differences from ofxTwoscilloscope:
* Settings are plain properties (lowPass.cutoff = 800), listed in
  effect.parameters so an XYPanel can show them, in place of ofParameters.
* A subclass's processFrame(frame) changes frame.x and frame.y in place, in
  place of two float references.
* XYNoise uses a small seeded generator of its own (mulberry32) in place of
  std::mt19937: the same seed gives the same shape every time, though not
  the same one as in openFrameworks.
*/
class XYEffect {

    constructor(name) {
        this.parameters = new XYParameterGroup(name);
        this.enabled = true;
        this.parameters.add(this, 'enabled', 'enabled', 0, 1, 'bool');
        this.sampleRate = 44100;
        this.frame = { x: 0, y: 0 };
    }

    getName() {
        return this.parameters.getName();
    }

    // a setting: a property with a starting value, listed for panels
    addParameter(key, label, value, min, max, type = 'float') {
        this[key] = value;
        this.parameters.add(this, key, label, min, max, type);
    }

    // Process channels 0 and 1 of an interleaved XYSoundBuffer in place.
    // Does nothing while the effect is disabled.
    process(buffer) {
        if (!this.enabled) return;
        const nCh = buffer.numChannels;
        if (nCh === 0) return;

        this.sampleRate = buffer.sampleRate > 0 ? buffer.sampleRate : 44100;
        this.prepare(this.sampleRate);

        const samples = buffer.samples;
        const frame = this.frame;
        const n = buffer.numFrames;
        for (let i = 0; i < n; i++) {
            const k = i * nCh;
            frame.x = samples[k];
            frame.y = nCh > 1 ? samples[k + 1] : 0;
            this.processFrame(frame);
            samples[k] = frame.x;
            if (nCh > 1) samples[k + 1] = frame.y;
        }
    }

    // Clear filter memory, delay lines and oscillators.
    reset() {}

    // Called once per buffer before the samples, with the buffer's sample rate.
    prepare(sampleRate) {}

    // Change frame.x and frame.y.
    processFrame(frame) {}

}

//--------------------------------------------------------------
// Second order filter from Robert Bristow-Johnson's Audio EQ Cookbook.
class XYBiquad {

    constructor() {
        this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
        this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    }

    set(b0, b1, b2, a0, a1, a2) {
        this.b0 = b0 / a0;
        this.b1 = b1 / a0;
        this.b2 = b2 / a0;
        this.a1 = a1 / a0;
        this.a2 = a2 / a0;
    }

    lowPass(cutoff, q, sampleRate) {
        const w0 = TWO_PI * clamp(cutoff, 1, sampleRate * 0.49) / sampleRate;
        const alpha = Math.sin(w0) / (2 * Math.max(0.05, q));
        const c = Math.cos(w0);
        this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha);
    }

    highPass(cutoff, q, sampleRate) {
        const w0 = TWO_PI * clamp(cutoff, 1, sampleRate * 0.49) / sampleRate;
        const alpha = Math.sin(w0) / (2 * Math.max(0.05, q));
        const c = Math.cos(w0);
        this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
    }

    reset() {
        this.x1 = this.x2 = this.y1 = this.y2 = 0;
    }

    process(x) {
        const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
        this.x2 = this.x1;
        this.x1 = x;
        this.y2 = this.y1;
        this.y1 = y;
        return y;
    }

}

//--------------------------------------------------------------
// A delay line read with linear interpolation, for fractional delays.
class XYDelayLine {

    constructor() {
        this.buffer = new Float32Array(0);
        this.writeIndex = 0;
    }

    setup(maxSamples) {
        if (this.buffer.length !== maxSamples + 2) {
            this.buffer = new Float32Array(maxSamples + 2);
            this.writeIndex = 0;
        }
    }

    reset() {
        this.buffer.fill(0);
        this.writeIndex = 0;
    }

    write(x) {
        if (this.buffer.length === 0) return;
        this.buffer[this.writeIndex] = x;
        this.writeIndex = (this.writeIndex + 1) % this.buffer.length;
    }

    // delay in samples, at least 1
    read(delay) {
        const n = this.buffer.length;
        if (n < 2) return 0;
        delay = clamp(delay, 1, n - 1);
        // the newest sample sits just behind writeIndex
        let pos = this.writeIndex - delay;
        while (pos < 0) pos += n;
        const i0 = Math.floor(pos) % n;
        const i1 = (i0 + 1) % n;
        const frac = pos - Math.floor(pos);
        return this.buffer[i0] + frac * (this.buffer[i1] - this.buffer[i0]);
    }

}

//--------------------------------------------------------------
class XYLowPass extends XYEffect {

    constructor() {
        super('low pass');
        this.addParameter('cutoff', 'cutoff', 2000, 20, 20000);
        this.addParameter('resonance', 'resonance', 0.707, 0.3, 10);
        this.filterX = new XYBiquad();
        this.filterY = new XYBiquad();
    }

    reset() {
        this.filterX.reset();
        this.filterY.reset();
    }

    prepare(sr) {
        this.filterX.lowPass(this.cutoff, this.resonance, sr);
        this.filterY.lowPass(this.cutoff, this.resonance, sr);
    }

    processFrame(f) {
        f.x = this.filterX.process(f.x);
        f.y = this.filterY.process(f.y);
    }

}

//--------------------------------------------------------------
class XYHighPass extends XYEffect {

    constructor() {
        super('high pass');
        this.addParameter('cutoff', 'cutoff', 60, 1, 2000);
        this.addParameter('resonance', 'resonance', 0.707, 0.3, 10);
        this.filterX = new XYBiquad();
        this.filterY = new XYBiquad();
    }

    reset() {
        this.filterX.reset();
        this.filterY.reset();
    }

    prepare(sr) {
        this.filterX.highPass(this.cutoff, this.resonance, sr);
        this.filterY.highPass(this.cutoff, this.resonance, sr);
    }

    processFrame(f) {
        f.x = this.filterX.process(f.x);
        f.y = this.filterY.process(f.y);
    }

}

//--------------------------------------------------------------
class XYChannelDelay extends XYEffect {

    constructor() {
        super('channel delay');
        this.addParameter('delayX', 'delay x (ms)', 0, 0, XYChannelDelay.MAX_MS);
        this.addParameter('delayY', 'delay y (ms)', 2, 0, XYChannelDelay.MAX_MS);
        this.lineX = new XYDelayLine();
        this.lineY = new XYDelayLine();
        this.samplesX = 1;
        this.samplesY = 1;
    }

    reset() {
        this.lineX.reset();
        this.lineY.reset();
    }

    prepare(sr) {
        const maxSamples = Math.ceil(XYChannelDelay.MAX_MS / 1000 * sr) + 2;
        this.lineX.setup(maxSamples);
        this.lineY.setup(maxSamples);
        this.samplesX = this.delayX / 1000 * sr;
        this.samplesY = this.delayY / 1000 * sr;
    }

    processFrame(f) {
        this.lineX.write(f.x);
        this.lineY.write(f.y);
        // the newest sample is a delay of 1, so shift by one to make 0 ms a straight pass
        if (this.samplesX > 0) f.x = this.lineX.read(this.samplesX + 1);
        if (this.samplesY > 0) f.y = this.lineY.read(this.samplesY + 1);
    }

}

XYChannelDelay.MAX_MS = 20;

//--------------------------------------------------------------
class XYEcho extends XYEffect {

    constructor() {
        super('echo');
        this.addParameter('time', 'time (ms)', 5, 0.1, XYEcho.MAX_MS);
        this.addParameter('feedback', 'feedback', 0.5, 0, 0.95);
        this.addParameter('mix', 'mix', 0.5, 0, 1);
        this.lineX = new XYDelayLine();
        this.lineY = new XYDelayLine();
        this.samples = 1;
    }

    reset() {
        this.lineX.reset();
        this.lineY.reset();
    }

    prepare(sr) {
        const maxSamples = Math.ceil(XYEcho.MAX_MS / 1000 * sr) + 2;
        this.lineX.setup(maxSamples);
        this.lineY.setup(maxSamples);
        this.samples = Math.max(1, this.time / 1000 * sr);
    }

    processFrame(f) {
        const dx = this.lineX.read(this.samples);
        const dy = this.lineY.read(this.samples);
        this.lineX.write(f.x + this.feedback * dx);
        this.lineY.write(f.y + this.feedback * dy);
        f.x = (1 - this.mix) * f.x + this.mix * dx;
        f.y = (1 - this.mix) * f.y + this.mix * dy;
    }

}

XYEcho.MAX_MS = 1000;

//--------------------------------------------------------------
class XYBitCrush extends XYEffect {

    constructor() {
        super('bit crush');
        this.addParameter('bits', 'bits', 4, 1, 16);
        this.levels = 8;
    }

    prepare(sr) {
        this.levels = Math.pow(2, this.bits - 1);
    }

    processFrame(f) {
        // std::round: halves away from zero
        f.x = Math.sign(f.x) * Math.round(Math.abs(f.x) * this.levels) / this.levels;
        f.y = Math.sign(f.y) * Math.round(Math.abs(f.y) * this.levels) / this.levels;
    }

}

//--------------------------------------------------------------
class XYSampleHold extends XYEffect {

    constructor() {
        super('sample & hold');
        this.addParameter('rate', 'rate (Hz)', 2000, 50, 48000);
        this.phase = 1;
        this.step = 0.1;
        this.heldX = 0;
        this.heldY = 0;
    }

    reset() {
        this.phase = 1;
        this.heldX = this.heldY = 0;
    }

    prepare(sr) {
        this.step = this.rate / sr;
    }

    processFrame(f) {
        if (this.phase >= 1) {
            this.phase -= Math.floor(this.phase);
            this.heldX = f.x;
            this.heldY = f.y;
        }
        this.phase += this.step;
        f.x = this.heldX;
        f.y = this.heldY;
    }

}

//--------------------------------------------------------------
class XYDrive extends XYEffect {

    constructor() {
        super('drive');
        this.addParameter('gain', 'gain', 3, 1, 20);
        this.norm = 1;
    }

    prepare(sr) {
        this.norm = 1 / Math.tanh(this.gain);
    }

    processFrame(f) {
        f.x = Math.tanh(this.gain * f.x) * this.norm;
        f.y = Math.tanh(this.gain * f.y) * this.norm;
    }

}

//--------------------------------------------------------------
class XYWavefold extends XYEffect {

    constructor() {
        super('wavefold');
        this.addParameter('gain', 'gain', 2, 1, 8);
    }

    processFrame(f) {
        f.x = Math.sin(this.gain * f.x * HALF_PI);
        f.y = Math.sin(this.gain * f.y * HALF_PI);
    }

}

//--------------------------------------------------------------
class XYRingMod extends XYEffect {

    constructor() {
        super('ring mod');
        this.addParameter('freq', 'freq (Hz)', 150, 0.1, 2000);
        this.addParameter('depth', 'depth', 0.5, 0, 1);
        this.phase = 0;
        this.step = 0;
    }

    reset() {
        this.phase = 0;
    }

    prepare(sr) {
        this.step = this.freq / sr;
    }

    processFrame(f) {
        const m = 1 - this.depth + this.depth * Math.sin(TWO_PI * this.phase);
        this.phase += this.step;
        this.phase -= Math.floor(this.phase);
        f.x *= m;
        f.y *= m;
    }

}

//--------------------------------------------------------------
// mulberry32: a small, fast, seedable generator, 0..1
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

class XYNoise extends XYEffect {

    constructor() {
        super('noise');
        this.addParameter('amount', 'amount', 0.02, 0, 0.5);
        this.addParameter('seed', 'seed', 1, 0, 1000, 'int');
        this.reset();
    }

    reset() {
        this.random = mulberry32(this.seed);
    }

    processFrame(f) {
        f.x += (this.random() * 2 - 1) * this.amount;
        f.y += (this.random() * 2 - 1) * this.amount;
    }

}

//--------------------------------------------------------------
class XYRotate extends XYEffect {

    constructor() {
        super('rotate');
        this.addParameter('angle', 'angle', 30, -180, 180);           // degrees
        this.addParameter('spin', 'spin (deg/s)', 0, -3600, 3600);    // degrees per second
        this.time = 0;
        this.dt = 0;
    }

    reset() {
        this.time = 0;
    }

    prepare(sr) {
        this.dt = 1 / sr;
    }

    processFrame(f) {
        const theta = degToRad(this.angle + this.spin * this.time);
        this.time += this.dt;
        const c = Math.cos(theta), s = Math.sin(theta);
        const rx = f.x * c - f.y * s;
        const ry = f.x * s + f.y * c;
        f.x = rx;
        f.y = ry;
    }

}

//--------------------------------------------------------------
class XYEffectChain {

    constructor() {
        this.effects = [];
        this.parameters = new XYParameterGroup('effects');
    }

    // Add an effect, and get it back to set it up:
    // chain.add(new XYLowPass()).cutoff = 800;
    add(effect) {
        if (!effect) return effect;
        this.effects.push(effect);
        this.parameters.add(effect.parameters);
        return effect;
    }

    clear() {
        this.effects = [];
        this.parameters.clear();
    }

    // run every enabled effect, in order
    process(buffer) {
        for (const effect of this.effects) effect.process(buffer);
    }

    reset() {
        for (const effect of this.effects) effect.reset();
    }

    size() {
        return this.effects.length;
    }

    get(index) {
        return this.effects[index];
    }

}

//==============================================================
// XYTransformer
//==============================================================

/*
The new feature, and the reason the two halves of the library live together:
turn a vector shape into a new vector shape by passing it through sound.

    shape --XYscope--> XY audio --XYEffects--> altered audio --XYDecoder--> new shape

    let transformer;

    function setup() {
        transformer = new XYTransformer();
        transformer.setup(width, height);
        transformer.effects.add(new XYLowPass()).cutoff = 800;
        transformer.effects.add(new XYChannelDelay());
    }

    function draw() {
        let altered = transformer.transform(shapes);
    }

The shapes are encoded exactly as XYscope would send them to a scope (one
loop of freq() Hz), run through the effect chain for a few loops so filters
and echoes settle into a steady state, and the last loop is decoded back
into XYPolylines on the same canvas.

The altered audio is available too: getProcessedWaves() is one loop of it,
ready for XYscope.setWaveforms(), so you can hear (or put on a real scope)
exactly the shape you see.

Differences from ofxTwoscilloscope: transform() takes shapes (XYPolylines or
arrays of points), an XYscope or an XYSoundBuffer, and the
getProcessedCycle(x, y, z) that filled three vectors is getProcessedWaves(),
which returns {x, y, z}.
*/
class XYTransformer {

    constructor() {
        this.effects = new XYEffectChain();
        this.decoder = new XYDecoderSettings();
        // loops rendered before the one that's decoded
        this.settleCycles = 4;

        this.encoder = new XYscope();
        this.encoded = new XYSoundBuffer(0, 3);
        this.processed = new XYSoundBuffer(0, 3);
        this.result = [];

        this.width = 512;
        this.height = 512;
        this.sampleRate = 44100;
        this.freq = 50;
        this.cycleFrames = 882;
        this.setup(this.width, this.height, this.sampleRate, this.freq);
    }

    setup(width, height, sampleRate = 44100, freq = 50, waveSize = 512) {
        this.width = width;
        this.height = height;
        this.sampleRate = Math.max(1000, sampleRate | 0);
        this.freq = Math.max(0.1, freq);

        this.encoder.setCanvasSize(width, height);
        this.encoder.sampleRate(this.sampleRate);
        this.encoder.waveSize(waveSize);
        this.encoder.freq(this.freq);
        return this;
    }

    getCycleFrames(f, sr) {
        return Math.max(2, Math.round(sr / Math.max(0.1, f)));
    }

    // transform(shapes): shapes in canvas pixels -> altered shapes in canvas pixels
    // transform(xyscope): whatever an XYscope has built with buildWaves(), at its freq and canvas size
    // transform(buffer): an XYSoundBuffer that's already XYscope format, looping at getFreq()
    transform(input) {
        if (input instanceof XYscope) return this.transformScope(input);
        if (input instanceof XYSoundBuffer) return this.transformAudio(input);
        return this.transformShapes(input || []);
    }

    transformShapes(shapes) {
        this.encoder.setCanvasSize(this.width, this.height);
        this.encoder.freq(this.freq);
        this.encoder.clearWaves();
        this.encoder.polylines(shapes);
        this.encoder.buildWaves();
        return this.transformScope(this.encoder);
    }

    transformScope(scope) {
        const f = scope.freq().x;
        const sr = scope.sampleRate();
        const cycle = this.getCycleFrames(f, sr);
        scope.renderInto(this.encoded, cycle * (Math.max(0, this.settleCycles) + 1), scope.zAuto() ? 3 : 2);
        return this.processAndDecode(f, sr, scope.getWidth(), scope.getHeight());
    }

    transformAudio(encodedAudio) {
        this.encoded = encodedAudio.copy();
        const sr = this.encoded.sampleRate > 0 ? this.encoded.sampleRate : this.sampleRate;
        this.encoded.sampleRate = sr;
        return this.processAndDecode(this.freq, sr, this.width, this.height);
    }

    processAndDecode(f, sr, w, h) {
        this.processed = this.encoded.copy();
        this.effects.reset();
        this.effects.process(this.processed);

        this.cycleFrames = Math.min(this.getCycleFrames(f, sr), this.processed.numFrames);
        this.result = [];
        if (this.processed.numChannels < 2 || this.cycleFrames < 2) return this.result;

        const waves = this.getProcessedWaves();
        const s = this.decoder.copy();
        s.width = w;
        s.height = h;
        s.sampleRate = sr;
        s.freq = f;
        this.result = XYDecoder.decodeCycle(waves.x, waves.y, waves.z.length > 0 ? waves.z : null, waves.x.length, s);
        return this.result;
    }

    getResult() { return this.result; }
    getEncodedAudio() { return this.encoded; }
    getProcessedAudio() { return this.processed; }

    // The last loop of the processed audio, as -1..1 waves {x, y, z} for
    // XYscope.setWaveforms(). z is empty without a Z channel.
    getProcessedWaves() {
        const nCh = this.processed.numChannels;
        const n = this.processed.numFrames;
        const m = Math.min(this.cycleFrames, n);
        if (nCh < 2 || m === 0) return { x: new Float32Array(0), y: new Float32Array(0), z: new Float32Array(0) };

        const start = n - m;
        const samples = this.processed.samples;
        const x = new Float32Array(m), y = new Float32Array(m), z = new Float32Array(nCh >= 3 ? m : 0);
        for (let i = 0; i < m; i++) {
            const k = (start + i) * nCh;
            x[i] = samples[k];
            y[i] = samples[k + 1];
            if (nCh >= 3) z[i] = samples[k + 2];
        }
        return { x, y, z };
    }

    // the last loop of the processed audio, as an XYSoundBuffer
    getProcessedCycle() {
        const nCh = this.processed.numChannels;
        const n = this.processed.numFrames;
        const m = Math.min(this.cycleFrames, n);
        return XYSoundBuffer.wrap(this.processed.samples.slice((n - m) * nCh), Math.max(1, nCh), this.processed.sampleRate);
    }

    // the XYscope that encodes shapes (set its steps(), zRange()... here)
    getEncoder() { return this.encoder; }
    getWidth() { return this.width; }
    getHeight() { return this.height; }
    getFreq() { return this.freq; }
    getSampleRate() { return this.sampleRate; }

}

//==============================================================
// WavFile
//==============================================================

/*
A minimal, dependency-free RIFF/WAVE reader and writer.

XYscope's recorder writes WAV files, and WAV is how most oscilloscope music
gets passed around, so it's the one format both halves of the library need.
It reads 8/16/24/32-bit PCM and 32/64-bit float files with any number of
channels, including WAVE_FORMAT_EXTENSIBLE headers, at their own sample rate
(the browser's decodeAudioData() would resample them). It writes 16-bit PCM,
24-bit PCM or 32-bit float.

Differences from ofxTwoscilloscope: decode() and encode() work on
ArrayBuffers, load() fetches, and save() downloads.
*/
function lround(v) {
    return v < 0 ? -Math.round(-v) : Math.round(v);
}

const WavFile = {

    PCM_16: 16,
    PCM_24: 24,
    FLOAT_32: 32,

    // An ArrayBuffer holding a WAV file -> XYSoundBuffer, or null if it isn't one.
    decode(data, quiet = false) {
        const fail = (message) => {
            if (!quiet) console.error('WavFile: ' + message);
            return null;
        };
        const bytes = new Uint8Array(data);
        const size = bytes.length;
        const view = new DataView(data);
        const tag = (pos) => String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);

        if (size < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return fail('not a RIFF/WAVE file');

        let format = 0, channels = 0, sampleRate = 0, bits = 0;
        let dataPos = 0, dataLen = 0;
        let haveFmt = false, haveData = false;

        let pos = 12;
        while (pos + 8 <= size) {
            const id = tag(pos);
            const len = view.getUint32(pos + 4, true);
            const body = pos + 8;

            if (id === 'fmt ' && body + 16 <= size) {
                format = view.getUint16(body, true);
                channels = view.getUint16(body + 2, true);
                sampleRate = view.getUint32(body + 4, true);
                bits = view.getUint16(body + 14, true);
                // the real format hides in the first two bytes of the SubFormat GUID
                if (format === 0xFFFE && len >= 40 && body + 26 <= size) format = view.getUint16(body + 24, true);
                haveFmt = true;
            } else if (id === 'data') {
                dataPos = body;
                // some writers leave the length at 0 or 0xFFFFFFFF while streaming
                dataLen = (len === 0 || body + len > size) ? size - body : len;
                haveData = true;
            }

            if (haveFmt && haveData) break;
            pos = body + len + (len & 1); // chunks are word aligned
        }

        if (!haveFmt || !haveData || channels === 0 || sampleRate === 0) return fail('missing its fmt or data chunk');

        const isFloat = format === 3;
        if (!(format === 1 || isFloat) ||
            (format === 1 && bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) ||
            (isFloat && bits !== 32 && bits !== 64)) {
            return fail('unsupported format ' + format + ' / ' + bits + ' bits');
        }

        const bytesPerSample = bits / 8;
        const numFrames = Math.floor(dataLen / (bytesPerSample * channels));
        const numSamples = numFrames * channels;
        const buffer = new XYSoundBuffer(numFrames, channels, sampleRate);
        const out = buffer.samples;

        let p = dataPos;
        for (let i = 0; i < numSamples; i++, p += bytesPerSample) {
            let v;
            if (isFloat) {
                v = bits === 32 ? view.getFloat32(p, true) : view.getFloat64(p, true);
            } else if (bits === 8) {
                v = (bytes[p] - 128) / 128;
            } else if (bits === 16) {
                v = view.getInt16(p, true) / 32768;
            } else if (bits === 24) {
                let s = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
                if (s & 0x800000) s -= 0x1000000;
                v = s / 8388608;
            } else {
                v = view.getInt32(p, true) / 2147483648;
            }
            out[i] = v;
        }
        return buffer;
    },

    // XYSoundBuffer -> an ArrayBuffer holding a WAV file
    encode(buffer, format = WavFile.PCM_16) {
        const channels = Math.max(1, buffer.numChannels);
        const sampleRate = buffer.sampleRate > 0 ? Math.round(buffer.sampleRate) : 44100;
        const bits = format;
        const bytesPerSample = bits / 8;
        const samples = buffer.samples;
        const dataLen = samples.length * bytesPerSample;

        const data = new ArrayBuffer(44 + dataLen);
        const view = new DataView(data);
        const writeTag = (pos, s) => {
            for (let i = 0; i < 4; i++) view.setUint8(pos + i, s.charCodeAt(i));
        };
        writeTag(0, 'RIFF');
        view.setUint32(4, 36 + dataLen, true);
        writeTag(8, 'WAVE');
        writeTag(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, format === WavFile.FLOAT_32 ? 3 : 1, true);
        view.setUint16(22, channels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * channels * bytesPerSample, true);
        view.setUint16(32, channels * bytesPerSample, true);
        view.setUint16(34, bits, true);
        writeTag(36, 'data');
        view.setUint32(40, dataLen, true);

        let p = 44;
        for (let i = 0; i < samples.length; i++) {
            const s = samples[i];
            if (format === WavFile.FLOAT_32) {
                view.setFloat32(p, s, true);
                p += 4;
            } else {
                const c = clamp(s, -1, 1);
                if (format === WavFile.PCM_16) {
                    view.setInt16(p, lround(c * 32767), true);
                    p += 2;
                } else {
                    const v = lround(c * 8388607);
                    view.setUint8(p, v & 0xff);
                    view.setUint8(p + 1, (v >> 8) & 0xff);
                    view.setUint8(p + 2, (v >> 16) & 0xff);
                    p += 3;
                }
            }
        }
        return data;
    },

    // Fetch a WAV. Resolves to an XYSoundBuffer, or null.
    load(url) {
        return fetch(url).then((response) => {
            if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
            return response.arrayBuffer();
        }).then((data) => WavFile.decode(data), (err) => {
            console.error('WavFile: couldn\'t load ' + url + ' (' + err.message + ')');
            return null;
        });
    },

    // Download an XYSoundBuffer as a WAV.
    save(filename, buffer, format = WavFile.PCM_16) {
        saveBlob(new Blob([WavFile.encode(buffer, format)], { type: 'audio/wav' }), filename);
        return true;
    }

};

//==============================================================
// XYPanel
//==============================================================

/*
In place of ofxGui: a panel of controls for XYParameterGroups, made with
p5's DOM functions. Each number gets a slider, each bool a checkbox, and
each group a header that folds it away.

    panel = new XYPanel(transformer.effects.parameters, 10, 10);
    panel.add(renderer.parameters);
    panel.getGroup('low pass').minimize();

The panel reads the settings back after every draw(), so a setting changed
in code moves its control too. It sits over the canvas at (x, y) in canvas
pixels. p5 still sees mouse events over the panel, so a sketch can check
panel.contains(mouseX, mouseY) before acting on them.
*/
const PANEL_STYLE = `
.xy-panel { position: absolute; z-index: 10; width: 230px; max-height: calc(100vh - 20px); overflow-y: auto;
    background: rgba(0, 0, 0, 0.85); color: #ccc; font: 11px/1.35 monospace; border: 1px solid #333;
    user-select: none; -webkit-user-select: none; box-sizing: border-box; }
.xy-panel * { box-sizing: border-box; }
.xy-panel .xy-header { padding: 3px 6px; cursor: pointer; background: #1a1a1a; color: #fff; border-top: 1px solid #2c2c2c; }
.xy-panel .xy-header::before { content: '\\25BE  '; color: #888; }
.xy-panel .xy-minimized > .xy-header::before { content: '\\25B8  '; }
.xy-panel .xy-minimized > .xy-body { display: none; }
.xy-panel .xy-body .xy-header { background: #121212; color: #ddd; padding-left: 10px; }
.xy-panel .xy-row { padding: 2px 8px 2px 12px; }
.xy-panel .xy-label { display: flex; justify-content: space-between; }
.xy-panel .xy-value { color: #8f8; }
.xy-panel input[type=range] { display: block; width: 100%; height: 14px; margin: 1px 0 2px; accent-color: #9a9a9a; }
.xy-panel input[type=checkbox] { margin: 0 6px 0 0; vertical-align: -2px; accent-color: #9a9a9a; }
.xy-panel label { cursor: pointer; }
`;

let panelStyleAdded = false;
const livePanels = new Set();

function formatValue(v, type) {
    if (type === 'int') return String(Math.round(v));
    const a = Math.abs(v);
    return v.toFixed(a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : 3);
}

class XYPanel {

    constructor(group, x = 10, y = 10) {
        const p = getP5();
        if (!p) throw new Error('XYPanel: create panels once the sketch has started');
        this.p = p;
        this.controls = [];
        this.groups = new Map();
        this.visible = true;
        if (!panelStyleAdded) {
            const style = document.createElement('style');
            style.textContent = PANEL_STYLE;
            document.head.appendChild(style);
            panelStyleAdded = true;
        }
        this.root = p.createDiv();
        this.root.addClass('xy-panel');
        if (group) this.add(group);
        this.setPosition(x, y);
        livePanels.add(this);
    }

    // Add a group of settings, under a header that folds it away.
    add(group, parent = this.root) {
        const p = this.p;
        const box = p.createDiv();
        box.addClass('xy-group');
        box.parent(parent);
        const header = p.createDiv(group.getName());
        header.addClass('xy-header');
        header.parent(box);
        const body = p.createDiv();
        body.addClass('xy-body');
        body.parent(box);

        const handle = {
            minimize: () => box.addClass('xy-minimized'),
            maximize: () => box.removeClass('xy-minimized'),
            isMinimized: () => box.hasClass('xy-minimized')
        };
        header.mousePressed(() => (handle.isMinimized() ? handle.maximize() : handle.minimize()));
        if (!this.groups.has(group.getName())) this.groups.set(group.getName(), handle);

        for (const item of group.items) {
            if (item.type === 'group') this.add(item.group, body);
            else if (item.type === 'bool') this.addToggle(item, body);
            else this.addSlider(item, body);
        }
        return handle;
    }

    addToggle(item, parent) {
        const row = this.p.createDiv();
        row.addClass('xy-row');
        row.parent(parent);
        const box = this.p.createCheckbox(item.label, !!item.object[item.key]);
        box.parent(row);
        box.changed(() => {
            item.object[item.key] = box.checked();
            // give the keyboard back to the sketch
            document.activeElement.blur();
        });
        this.controls.push(() => {
            const v = !!item.object[item.key];
            if (box.checked() !== v) box.checked(v);
        });
    }

    addSlider(item, parent) {
        const p = this.p;
        const row = p.createDiv();
        row.addClass('xy-row');
        row.parent(parent);
        const label = p.createDiv();
        label.addClass('xy-label');
        label.parent(row);
        p.createSpan(item.label).parent(label);
        const value = p.createSpan('');
        value.addClass('xy-value');
        value.parent(label);

        let shown = item.object[item.key];
        // step 0 is continuous, like an ofxGui slider
        const slider = p.createSlider(item.min, item.max, shown, item.type === 'int' ? 1 : 0);
        slider.parent(row);
        value.html(formatValue(shown, item.type));
        slider.input(() => {
            let v = Number(slider.value());
            if (item.type === 'int') v = Math.round(v);
            item.object[item.key] = v;
            shown = v;
            value.html(formatValue(v, item.type));
        });
        slider.changed(() => slider.elt.blur());
        this.controls.push(() => {
            const v = item.object[item.key];
            if (v === shown || document.activeElement === slider.elt) return;
            shown = v;
            slider.value(v);
            value.html(formatValue(v, item.type));
        });
    }

    // a group's header, by name: getGroup(name).minimize() / .maximize()
    getGroup(name) {
        const handle = this.groups.get(name);
        if (handle) return handle;
        console.warn('XYPanel: no group called ' + name);
        return { minimize() {}, maximize() {}, isMinimized() { return false; } };
    }

    // move the panel to (x, y) on the canvas
    setPosition(x, y) {
        this.x = x;
        this.y = y;
        const r = this.p.drawingContext.canvas.getBoundingClientRect();
        this.root.position(r.left + window.scrollX + x, r.top + window.scrollY + y);
    }

    // whether (x, y), in canvas pixels, is over the panel
    contains(x, y) {
        if (!this.visible) return false;
        const canvas = this.p.drawingContext.canvas.getBoundingClientRect();
        const r = this.root.elt.getBoundingClientRect();
        const cx = x + canvas.left, cy = y + canvas.top;
        return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    }

    show() {
        this.visible = true;
        this.root.show();
    }

    hide() {
        this.visible = false;
        this.root.hide();
    }

    toggle() {
        if (this.visible) this.hide();
        else this.show();
    }

    isVisible() {
        return this.visible;
    }

    // match the controls to the settings
    sync() {
        for (const control of this.controls) control();
    }

    remove() {
        this.root.remove();
        livePanels.delete(this);
    }

    static syncAll() {
        for (const panel of livePanels) panel.sync();
    }

}

//==============================================================
// p5
//==============================================================

if (typeof p5 !== 'undefined') {
    // the sketch to draw into
    p5.prototype.registerMethod('init', function () {
        p5Instance = this;
    });

    // panels follow settings changed in code
    p5.prototype.registerMethod('post', function () {
        XYPanel.syncAll();
    });

    // In preload(): a HersheyFont, ready by setup(). Loading it also makes
    // the font available to XYscope.textFont() and HersheyFont.load().
    p5.prototype.loadHersheyFont = function (nameOrPath, callback) {
        const font = new HersheyFont();
        font.loadAsync(nameOrPath).then((ok) => {
            if (ok && typeof callback === 'function') callback(font);
            if (typeof this._decrementPreload === 'function') this._decrementPreload();
        });
        return font;
    };
    p5.prototype.registerPreloadMethod('loadHersheyFont', p5.prototype);
}

const Twoscilloscope = {
    VERSION,
    // the shared audio context: Twoscilloscope.audio.state(), .resume(), .context
    audio: XYAudio,
    saveBlob,
    timestamp,
    hsbToRgb
};

Object.assign(window, {
    Twoscilloscope,
    XYscope, XYWavetable, HersheyFont,
    Oscilloscope, OsciMesh, StreamResampler, XYDecoder, XYDecoderSettings, XYPlayer, XYAudioInput,
    XYEffect, XYBiquad, XYDelayLine, XYLowPass, XYHighPass, XYChannelDelay, XYEcho, XYBitCrush,
    XYSampleHold, XYDrive, XYWavefold, XYRingMod, XYNoise, XYRotate, XYEffectChain, XYTransformer,
    WavFile, XYSoundBuffer, XYFloatArray, XYPolyline, XYParameterGroup, XYPanel
});

})();

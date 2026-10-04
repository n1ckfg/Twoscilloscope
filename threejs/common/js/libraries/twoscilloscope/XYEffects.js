/*
+ + +   three.twoscilloscope   + + +
*/

import { XYParameterGroup } from './XYParameterGroup.js';
import { clamp, degToRad, HALF_PI, TWO_PI } from './XYUtils.js';

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
  effect.parameters so XYGui can put them in a lil-gui panel, in place of
  ofParameters.
* A subclass's processFrame(frame) changes frame.x and frame.y in place, in
  place of two float references.
* XYNoise uses a small seeded generator of its own (mulberry32) in place of
  std::mt19937: the same seed gives the same shape every time, though not
  the same one as in openFrameworks.
*/
export class XYEffect {

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
export class XYBiquad {

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
export class XYDelayLine {

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
export class XYLowPass extends XYEffect {

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
export class XYHighPass extends XYEffect {

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
export class XYChannelDelay extends XYEffect {

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
export class XYEcho extends XYEffect {

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
export class XYBitCrush extends XYEffect {

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
export class XYSampleHold extends XYEffect {

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
export class XYDrive extends XYEffect {

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
export class XYWavefold extends XYEffect {

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
export class XYRingMod extends XYEffect {

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

export class XYNoise extends XYEffect {

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
export class XYRotate extends XYEffect {

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
export class XYEffectChain {

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

/*
+ + +   three.twoscilloscope   + + +
*/

import { XYscope } from './XYscope.js';
import { XYEffectChain } from './XYEffects.js';
import { XYDecoder, XYDecoderSettings } from './XYDecoder.js';
import { XYSoundBuffer } from './XYSoundBuffer.js';

/*
The new feature, and the reason the two halves of the library live together:
turn a vector shape into a new vector shape by passing it through sound.

    shape --XYscope--> XY audio --XYEffects--> altered audio --XYDecoder--> new shape

    const transformer = new XYTransformer();
    transformer.setup(512, 512);
    transformer.effects.add(new XYLowPass()).cutoff = 800;
    transformer.effects.add(new XYChannelDelay());

    function animate() {
        const altered = transformer.transform(shapes);
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
export class XYTransformer {

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

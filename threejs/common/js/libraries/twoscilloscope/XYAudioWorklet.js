/*
+ + +   three.twoscilloscope   + + +

The audio thread: AudioWorklet processors, loaded by XYAudio.loadWorklet().

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

/*
+ + +   three.twoscilloscope   + + +
*/

import { PI } from './XYUtils.js';
import { XYFloatArray } from './XYSoundBuffer.js';

/*
Streaming sample rate conversion for one channel of audio.

The Oscilloscope app drew its lines from audio upsampled to a high
"visual" sample rate (192kHz or more) with FFmpeg's swresample, so the beam
follows the band-limited curve between samples instead of cutting straight
across. This does the same job without FFmpeg: SINC is a windowed sinc
(Lanczos, 4 lobes), like swresample's default filter, and LINEAR matches the
app's "interpolate = false" option.
*/
export class StreamResampler {

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

/*
+ + +   three.twoscilloscope   + + +
*/

import { TWO_PI } from './XYUtils.js';

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
export class XYWavetable {

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

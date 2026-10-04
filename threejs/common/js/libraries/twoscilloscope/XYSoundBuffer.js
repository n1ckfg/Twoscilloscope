/*
+ + +   three.twoscilloscope   + + +

XYSoundBuffer: interleaved audio, in place of ofSoundBuffer.
XYFloatArray: a Float32Array that grows, in place of std::vector<float>.
*/

export class XYFloatArray {

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

export class XYSoundBuffer {

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

/*
+ + +   three.twoscilloscope   + + +
*/

import { Matrix4, Vector3 } from 'three';
import { XYAudio } from './XYAudio.js';
import { XYWavetable } from './XYWavetable.js';
import { HersheyFont } from './HersheyFont.js';
import { XYPolyline } from './XYPolyline.js';
import { XYFloatArray, XYSoundBuffer } from './XYSoundBuffer.js';
import { WavFile } from './WavFile.js';
import { clamp, degToRad, mapValue, PI, TWO_PI, px, py, pz, timestamp } from './XYUtils.js';

// scratch objects for the transform stack
const step = new Matrix4();
const projected = new Vector3();

/*
A port of XYscope.java by Ted Davis (https://teddavis.org/xyscope), the
vector-to-audio half of the library.

Drawing commands don't draw to the screen. They collect shapes, and
buildWaves() turns those shapes into wavetables that loop at freq() Hz:
X on the left channel, Y on the right, and an optional Z (beam blanking)
channel. Play them through a DC-coupled sound card into an oscilloscope in
X-Y mode, a modded Vectrex or a laser, and the shapes appear on the display.

    const xy = new XYscope();
    xy.setup(512, 512);       // canvas, 44.1kHz, 512 sample waves
    xy.openAudioOut();        // default sound card, once the page is clicked

    const preview = new XYscopeHelper(xy, 'xy');   // what the scope will show
    scene.add(preview);

    function animate() {
        if (!xy.isAudioRunning()) xy.process(clock.getDelta());
        xy.clearWaves();
        xy.circle(256, 256, 300);
        xy.buildWaves();
        preview.update();
        renderer.render(scene, camera);
    }

Coordinates are XYscope's: pixels on a canvas with y pointing down.
"XYscope format" audio maps the canvas to -1..1, with +Y up:
x = 2 * px / width - 1, y = 1 - 2 * py / height.

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
* The draw functions (drawXY(), drawWaveform()...) are THREE objects that
  stay in a scene: XYscopeHelper, one for each view, with update().
* The transform stack is a THREE.Matrix4. recorderEnd() downloads the WAV.
* Getters and setters share a name: freq() reads, freq(50) sets.
* rectMode() and textAlign() take strings in place of oF's constants.
  textAlign() still starts at 'top', as in ofxTwoscilloscope.
* path(ofPath) is gone. polylines() takes XYPolylines or arrays of points.
*/
export class XYscope {

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
        this.matrix = new Matrix4();
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

    // width/height of 0 use the window's size.
    setup(width = 0, height = 0, sampleRate = 44100, bufferSize = 512) {
        this.setCanvasSize(width > 0 ? width : window.innerWidth, height > 0 ? height : window.innerHeight);
        this.sampleRateVal = sampleRate;
        this.bufferSizeVal = Math.max(16, bufferSize | 0);
        this.waveSize(this.bufferSizeVal);
        this.limitPointsVal = this.bufferSizeVal;
        console.log('XYscope 3.0.0 for three.js - https://teddavis.org/xyscope');
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
        // Processing resets the matrix at the start of every draw(), and XYscope
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

    // vertex(x, y), vertex(x, y, z), or a point: THREE.Vector2/3, {x, y, z}, [x, y, z]
    vertex(x, y, z = 0) {
        if (typeof x === 'object') this.vertexAdd(px(x), py(x), pz(x));
        else this.vertexAdd(x, y, z);
    }

    // Sent as a normal vertex, as in XYscope.
    curveVertex(x, y, z) {
        this.vertex(x, y, z);
    }

    project(x, y, z) {
        const v = projected.set(x, y, z).applyMatrix4(this.matrix);
        const t = [v.x, v.y, v.z];
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

    // endShape(true) joins the last point to the first.
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

    // 'corner' (the default), 'center', 'corners' or 'radius'
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
        this.matrixStack.push(this.matrix.clone());
    }

    popMatrix() {
        if (this.matrixStack.length === 0) {
            console.warn('XYscope: popMatrix() without a pushMatrix()');
            return;
        }
        this.matrix = this.matrixStack.pop();
    }

    // Processing's shorter names
    push() {
        this.pushMatrix();
    }

    pop() {
        this.popMatrix();
    }

    resetMatrix() {
        this.matrix.identity();
        this.matrixStack = [];
    }

    translate(x, y, z = 0) {
        this.matrix.multiply(step.makeTranslation(x, y, z));
    }

    // angles in radians, as in Processing
    rotate(angle) {
        this.rotateZ(angle);
    }

    rotateX(angle) {
        this.matrix.multiply(step.makeRotationX(angle));
    }

    rotateY(angle) {
        this.matrix.multiply(step.makeRotationY(angle));
    }

    rotateZ(angle) {
        this.matrix.multiply(step.makeRotationZ(angle));
    }

    // scale(s), scale(x, y) or scale(x, y, z)
    scale(x, y, z) {
        if (y === undefined) this.matrix.multiply(step.makeScale(x, x, x));
        else this.matrix.multiply(step.makeScale(x, y, z === undefined ? 1 : z));
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

    // 'left', 'center' or 'right', and 'top', 'center', 'bottom' or 'baseline'
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

    // ---------------------------------------------------------------- previews

    // XYscopeHelper draws what drawPath(), drawXY(), drawWaveform()... drew.
    // In debug view, it marks where the mouse is along the waves.
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

/*
+ + +   three.twoscilloscope   + + +

The audio-to-vector half of the library: the rendering pipeline of Hansi
Raber's Oscilloscope app (https://github.com/kritzikratzi/Oscilloscope),
taken out of the app and packed into one class.

Feed it audio (an XYPlayer, an XYAudioInput, an XYscope's onAudioOut), then
update() and render() it each frame, and show its screen:

    const scope = new Oscilloscope();
    scope.setup(512, 512);
    scope.screen.scale.set(2, 2, 1);   // a 1 x 1 plane, +y up, showing the beam
    scene.add(scope.screen);
    input.onAudioIn = (buffer) => scope.addBuffer(buffer);

    function animate() {
        scope.update();
        scope.render(renderer);
        renderer.render(scene, camera);
    }

The channels decide the layout, as they did for the app's audio files:
1 channel draws the signal against a sawtooth sweep, 2 are X and Y, 3 are
X, Y and Z (brightness), 4 are two stereo pairs drawn as a red/cyan
anaglyph.

getShapes() turns the most recent audio back into vector shapes with
XYDecoder.

Differences from ofxTwoscilloscope:
* The beam renders into a THREE.WebGLRenderTarget (getTexture()) in place
  of an FBO, at width x height times the renderer's pixel ratio. render()
  brings it up to date, and screen is a mesh that shows it: a 1 x 1 plane,
  centered, +y up, that goes anywhere in a scene (give it a negative y
  scale under a camera that points y down). It shows the beam as it is,
  without colour management.
* zRange is {min, max} rather than a glm::vec2.
* Audio arrives on the main thread, so there's no mutex.
* The app's Globals settings are plain properties, as in ofxTwoscilloscope,
  and audio is upsampled to the visual rate (192kHz by default) with
  StreamResampler. Z is read through zRange: the default (0, 1) shows the
  app's 0..1 brightness as-is and blanks XYscope's -1 (beam off) level.
*/

import {
    AddEquation, Color, CustomBlending, DoubleSide, DstColorFactor, Mesh,
    OneMinusSrcAlphaFactor, OrthographicCamera, PlaneGeometry, Scene,
    ShaderMaterial, Vector4, WebGLRenderTarget
} from 'three';
import { OsciMesh } from './OsciMesh.js';
import { StreamResampler } from './StreamResampler.js';
import { XYDecoder, XYDecoderSettings } from './XYDecoder.js';
import { XYFloatArray, XYSoundBuffer } from './XYSoundBuffer.js';
import { clamp, hsbToRgb } from './XYUtils.js';

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

// A black rectangle over the whole target, multiplied in: oF's
// OF_BLENDMODE_MULTIPLY (DST_COLOR, ONE_MINUS_SRC_ALPHA) keeps 1 - alpha of what's there.
const FADE_VERT = `
void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FADE_FRAG = `
uniform vec4 uColor;
void main() {
    gl_FragColor = uColor;
}
`;

// The render target as it is: no colour management, as oF drew its FBO.
const SCREEN_VERT = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SCREEN_FRAG = `
uniform sampler2D map;
varying vec2 vUv;
void main() {
    gl_FragColor = texture2D(map, vUv);
}
`;

const savedClearColor = new Color();

export class Oscilloscope {

    constructor() {
        this.width = 512;
        this.height = 512;
        this.visualSampleRate = 192000;

        // Decode settings for getShapes(); set freq if you know it.
        this.decoderSettings = new XYDecoderSettings();

        this.scale = 1;              // 1 fills the shorter side of the target
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
        this.mesh.matrixAutoUpdate = false;
        this.mesh2.matrixAutoUpdate = false;

        // the render target, drawn in its own pixels (y down) by its own camera
        this.target = null;
        this.camera = new OrthographicCamera(0, this.width, 0, this.height, -1, 1);
        this.beamScene = new Scene();
        this.beamScene.add(this.mesh, this.mesh2);
        this.fade = new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
            uniforms: { uColor: { value: new Vector4(0, 0, 0, 0.5) } },
            vertexShader: FADE_VERT,
            fragmentShader: FADE_FRAG,
            blending: CustomBlending,
            blendEquation: AddEquation,
            blendSrc: DstColorFactor,
            blendDst: OneMinusSrcAlphaFactor,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            side: DoubleSide
        }));
        this.fade.frustumCulled = false;
        this.fadeScene = new Scene();
        this.fadeScene.add(this.fade);

        // the beam on a 1 x 1 plane, to put in a scene
        this.screen = new Mesh(new PlaneGeometry(1, 1), new ShaderMaterial({
            uniforms: { map: { value: null } },
            vertexShader: SCREEN_VERT,
            fragmentShader: SCREEN_FRAG,
            side: DoubleSide
        }));
        this.screen.name = 'Oscilloscope screen';

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

    // ---------------------------------------------------------------- input

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

    // ---------------------------------------------------------------- update/render

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
        // scope +Y is up, the target's pixels go down
        const sx = s * (this.invertX ? -1 : 1);
        const sy = -s * (this.invertY ? -1 : 1);
        for (const mesh of [this.mesh, this.mesh2]) {
            if (this.flipXY) mesh.matrix.set(0, sx, 0, w / 2, sy, 0, 0, h / 2, 0, 0, 1, 0, 0, 0, 0, 1);
            else mesh.matrix.set(sx, 0, 0, w / 2, 0, sy, 0, h / 2, 0, 0, 1, 0, 0, 0, 0, 1);
            mesh.matrixWorldNeedsUpdate = true;
        }

        const gain = this.intensity * BEAM_GAIN * 192000 / this.visualSampleRate;
        this.mesh.uIntensity = gain;
        this.mesh2.uIntensity = gain;

        if (this.layout === Oscilloscope.QUAD) {
            this.mesh.uRgb.setRGB(1, 0, 0);
            this.mesh2.uRgb.setRGB(0, 1, 1);
        } else if (this.hue >= 360) {
            this.mesh.uRgb.setRGB(1, 1, 1);
        } else {
            this.mesh.uRgb.setRGB(...hsbToRgb(this.hue / 360, 1, 1));
        }
        this.mesh2.visible = this.layout === Oscilloscope.QUAD;
    }

    // Bring the render target up to date: fade it, then draw the new samples.
    // Leaves the renderer's target, clear colour and autoClear as they were.
    render(renderer) {
        const ratio = renderer.getPixelRatio();
        const tw = Math.max(1, Math.round(this.width * ratio));
        const th = Math.max(1, Math.round(this.height * ratio));
        if (!this.target || this.target.width !== tw || this.target.height !== th) {
            if (this.target) this.target.dispose();
            this.target = new WebGLRenderTarget(tw, th, { depthBuffer: false });
            this.screen.material.uniforms.map.value = this.target.texture;
            this.needsClear = true;
        }
        if (!this.needsClear && !this.changed) return this.target.texture;

        this.camera.right = this.width;
        this.camera.bottom = this.height;
        this.camera.updateProjectionMatrix();

        const previousTarget = renderer.getRenderTarget();
        const previousAutoClear = renderer.autoClear;
        renderer.getClearColor(savedClearColor);
        const previousClearAlpha = renderer.getClearAlpha();
        renderer.setRenderTarget(this.target);
        renderer.autoClear = false;

        if (this.needsClear) {
            renderer.setClearColor(0x000000, 1);
            renderer.clear(true, false, false);
            this.needsClear = false;
        }

        if (this.changed) {
            // the afterglow: fade what's there, rather than clearing it
            this.fade.material.uniforms.uColor.value.set(0, 0, 0, 1 - clamp(this.afterglow, 0, 1));
            renderer.render(this.fadeScene, this.camera);
            this.drawMesh();
            renderer.render(this.beamScene, this.camera);
            this.changed = false;
        }

        renderer.setRenderTarget(previousTarget);
        renderer.autoClear = previousAutoClear;
        renderer.setClearColor(savedClearColor, previousClearAlpha);
        return this.target.texture;
    }

    // the beam, a texture (oF's getFbo()); null until the first render()
    getTexture() {
        return this.target ? this.target.texture : null;
    }

    dispose() {
        if (this.target) this.target.dispose();
        this.mesh.dispose();
        this.mesh2.dispose();
        this.fade.geometry.dispose();
        this.fade.material.dispose();
        this.screen.geometry.dispose();
        this.screen.material.dispose();
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

/*
+ + +   three.twoscilloscope   + + +
*/

import { XYAudio } from './XYAudio.js';
import { XYSoundBuffer } from './XYSoundBuffer.js';
import { WavFile } from './WavFile.js';
import { clamp } from './XYUtils.js';

/*
Plays an XY audio file to the sound card and feeds the same audio to an
Oscilloscope, which is the job OsciAvAudioPlayer did in the Oscilloscope app.

    const scope = new Oscilloscope();
    scope.setup(512, 512);
    scene.add(scope.screen);

    const player = new XYPlayer();
    player.setScope(scope);
    player.setLoop(true);
    player.openAudioOut();
    player.load('data/xyscope.wav').then(() => player.play());

    function animate() {
        player.update(clock.getDelta());   // feeds the scope
        scope.update();
        scope.render(renderer);
        renderer.render(scene, camera);
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

export class XYPlayer {

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

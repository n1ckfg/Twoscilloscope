/*
+ + +   three.twoscilloscope   + + +

The audio context, shared by everything that makes or hears sound, in place
of ofSoundStream. There's one AudioContext for the page. Browsers keep it
suspended until the page gets a click, a tap or a key press, so this listens
for the first one and starts it then.

The audio thread's half lives in XYAudioWorklet.js.
*/

export const XYAudio = {

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
            console.warn('three.twoscilloscope: this browser has no Web Audio');
            return null;
        }
        try {
            this.context = new AudioContextClass({ sampleRate, latencyHint: 'interactive' });
        } catch (e) {
            try {
                this.context = new AudioContextClass({ latencyHint: 'interactive' });
            } catch (e2) {
                this.unavailable = true;
                console.warn('three.twoscilloscope: couldn\'t create an AudioContext', e2);
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

    // Loads the AudioWorklet processors in XYAudioWorklet.js (once). Resolves
    // to false if the browser can't run them: AudioWorklet needs a secure
    // context, which means https://, or http://localhost or 127.0.0.1.
    loadWorklet() {
        if (this.workletReady) return this.workletReady;
        const ctx = this.context;
        if (!ctx || !ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') {
            console.warn('three.twoscilloscope: no AudioWorklet here, so no audio. It needs https://, or http://localhost or 127.0.0.1');
            this.workletReady = Promise.resolve(false);
            return this.workletReady;
        }
        const url = new URL('./XYAudioWorklet.js', import.meta.url);
        this.workletReady = ctx.audioWorklet.addModule(url).then(() => true, (err) => {
            console.error('three.twoscilloscope: couldn\'t load the audio worklet', err);
            return false;
        });
        return this.workletReady;
    }

};

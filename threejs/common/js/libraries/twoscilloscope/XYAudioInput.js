/*
+ + +   three.twoscilloscope   + + +
*/

import { XYAudio } from './XYAudio.js';
import { XYSoundBuffer } from './XYSoundBuffer.js';

/*
The line input (or microphone), in place of an ofSoundStream with input
channels. The browser asks for permission the first time.

    input = new XYAudioInput();
    input.onAudioIn = (buffer) => scope.addBuffer(buffer);
    input.open();    // from a click or key press

Echo cancellation, noise suppression and automatic gain are turned off,
since they would mangle an XY signal. Many inputs are mono, and browsers
often hand over a stereo input as mono unless asked otherwise; buffers come
with however many channels the input really has.
*/
export class XYAudioInput {

    constructor() {
        // called with each block of input, numChannels interleaved
        this.onAudioIn = null;
        this.stream = null;
        this.source = null;
        this.node = null;
        this.opened = false;
    }

    // Resolves to true once the input is listening.
    open(numChannels = 2, blockFrames = 512) {
        this.close();
        const ctx = XYAudio.getContext();
        if (!ctx || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            console.warn('XYAudioInput: no audio input here (it needs https://, or http://localhost or 127.0.0.1)');
            return Promise.resolve(false);
        }
        XYAudio.resume();
        const request = this.request = {};
        return XYAudio.loadWorklet().then((ok) => {
            if (!ok) return null;
            return navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: { ideal: numChannels },
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });
        }).then((stream) => {
            if (!stream) return false;
            if (request !== this.request) {
                for (const track of stream.getTracks()) track.stop();
                return false;
            }
            this.stream = stream;
            this.source = ctx.createMediaStreamSource(stream);
            this.node = new AudioWorkletNode(ctx, 'xycapture-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
                channelCountMode: 'max',
                channelInterpretation: 'discrete',
                processorOptions: { blockFrames, maxChannels: numChannels }
            });
            this.node.port.onmessage = (e) => {
                const m = e.data;
                if (m.type === 'audio' && this.onAudioIn) this.onAudioIn(XYSoundBuffer.wrap(m.samples, m.numChannels, m.sampleRate));
            };
            this.source.connect(this.node);
            // it only outputs silence, but it has to be connected to run
            this.node.connect(ctx.destination);
            this.opened = true;
            return true;
        }).catch((err) => {
            console.warn('XYAudioInput: couldn\'t open the audio input (' + err.message + ')');
            return false;
        });
    }

    close() {
        this.request = null;
        if (this.node) {
            this.node.port.postMessage({ type: 'stop' });
            this.node.port.onmessage = null;
            this.node.disconnect();
            this.node = null;
        }
        if (this.source) {
            this.source.disconnect();
            this.source = null;
        }
        if (this.stream) {
            for (const track of this.stream.getTracks()) track.stop();
            this.stream = null;
        }
        this.opened = false;
    }

    isOpen() {
        return this.opened;
    }

}

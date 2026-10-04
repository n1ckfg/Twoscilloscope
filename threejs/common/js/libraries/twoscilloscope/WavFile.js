/*
+ + +   three.twoscilloscope   + + +
*/

import { XYSoundBuffer } from './XYSoundBuffer.js';
import { clamp, saveBlob } from './XYUtils.js';

/*
A minimal, dependency-free RIFF/WAVE reader and writer.

XYscope's recorder writes WAV files, and WAV is how most oscilloscope music
gets passed around, so it's the one format both halves of the library need.
It reads 8/16/24/32-bit PCM and 32/64-bit float files with any number of
channels, including WAVE_FORMAT_EXTENSIBLE headers, at their own sample rate
(the browser's decodeAudioData() would resample them). It writes 16-bit PCM,
24-bit PCM or 32-bit float.

Differences from ofxTwoscilloscope: decode() and encode() work on
ArrayBuffers, load() fetches, and save() downloads.
*/
function lround(v) {
    return v < 0 ? -Math.round(-v) : Math.round(v);
}

export const WavFile = {

    PCM_16: 16,
    PCM_24: 24,
    FLOAT_32: 32,

    // An ArrayBuffer holding a WAV file -> XYSoundBuffer, or null if it isn't one.
    decode(data, quiet = false) {
        const fail = (message) => {
            if (!quiet) console.error('WavFile: ' + message);
            return null;
        };
        const bytes = new Uint8Array(data);
        const size = bytes.length;
        const view = new DataView(data);
        const tag = (pos) => String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);

        if (size < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return fail('not a RIFF/WAVE file');

        let format = 0, channels = 0, sampleRate = 0, bits = 0;
        let dataPos = 0, dataLen = 0;
        let haveFmt = false, haveData = false;

        let pos = 12;
        while (pos + 8 <= size) {
            const id = tag(pos);
            const len = view.getUint32(pos + 4, true);
            const body = pos + 8;

            if (id === 'fmt ' && body + 16 <= size) {
                format = view.getUint16(body, true);
                channels = view.getUint16(body + 2, true);
                sampleRate = view.getUint32(body + 4, true);
                bits = view.getUint16(body + 14, true);
                // the real format hides in the first two bytes of the SubFormat GUID
                if (format === 0xFFFE && len >= 40 && body + 26 <= size) format = view.getUint16(body + 24, true);
                haveFmt = true;
            } else if (id === 'data') {
                dataPos = body;
                // some writers leave the length at 0 or 0xFFFFFFFF while streaming
                dataLen = (len === 0 || body + len > size) ? size - body : len;
                haveData = true;
            }

            if (haveFmt && haveData) break;
            pos = body + len + (len & 1); // chunks are word aligned
        }

        if (!haveFmt || !haveData || channels === 0 || sampleRate === 0) return fail('missing its fmt or data chunk');

        const isFloat = format === 3;
        if (!(format === 1 || isFloat) ||
            (format === 1 && bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) ||
            (isFloat && bits !== 32 && bits !== 64)) {
            return fail('unsupported format ' + format + ' / ' + bits + ' bits');
        }

        const bytesPerSample = bits / 8;
        const numFrames = Math.floor(dataLen / (bytesPerSample * channels));
        const numSamples = numFrames * channels;
        const buffer = new XYSoundBuffer(numFrames, channels, sampleRate);
        const out = buffer.samples;

        let p = dataPos;
        for (let i = 0; i < numSamples; i++, p += bytesPerSample) {
            let v;
            if (isFloat) {
                v = bits === 32 ? view.getFloat32(p, true) : view.getFloat64(p, true);
            } else if (bits === 8) {
                v = (bytes[p] - 128) / 128;
            } else if (bits === 16) {
                v = view.getInt16(p, true) / 32768;
            } else if (bits === 24) {
                let s = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
                if (s & 0x800000) s -= 0x1000000;
                v = s / 8388608;
            } else {
                v = view.getInt32(p, true) / 2147483648;
            }
            out[i] = v;
        }
        return buffer;
    },

    // XYSoundBuffer -> an ArrayBuffer holding a WAV file
    encode(buffer, format = WavFile.PCM_16) {
        const channels = Math.max(1, buffer.numChannels);
        const sampleRate = buffer.sampleRate > 0 ? Math.round(buffer.sampleRate) : 44100;
        const bits = format;
        const bytesPerSample = bits / 8;
        const samples = buffer.samples;
        const dataLen = samples.length * bytesPerSample;

        const data = new ArrayBuffer(44 + dataLen);
        const view = new DataView(data);
        const writeTag = (pos, s) => {
            for (let i = 0; i < 4; i++) view.setUint8(pos + i, s.charCodeAt(i));
        };
        writeTag(0, 'RIFF');
        view.setUint32(4, 36 + dataLen, true);
        writeTag(8, 'WAVE');
        writeTag(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, format === WavFile.FLOAT_32 ? 3 : 1, true);
        view.setUint16(22, channels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * channels * bytesPerSample, true);
        view.setUint16(32, channels * bytesPerSample, true);
        view.setUint16(34, bits, true);
        writeTag(36, 'data');
        view.setUint32(40, dataLen, true);

        let p = 44;
        for (let i = 0; i < samples.length; i++) {
            const s = samples[i];
            if (format === WavFile.FLOAT_32) {
                view.setFloat32(p, s, true);
                p += 4;
            } else {
                const c = clamp(s, -1, 1);
                if (format === WavFile.PCM_16) {
                    view.setInt16(p, lround(c * 32767), true);
                    p += 2;
                } else {
                    const v = lround(c * 8388607);
                    view.setUint8(p, v & 0xff);
                    view.setUint8(p + 1, (v >> 8) & 0xff);
                    view.setUint8(p + 2, (v >> 16) & 0xff);
                    p += 3;
                }
            }
        }
        return data;
    },

    // Fetch a WAV. Resolves to an XYSoundBuffer, or null.
    load(url) {
        return fetch(url).then((response) => {
            if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
            return response.arrayBuffer();
        }).then((data) => WavFile.decode(data), (err) => {
            console.error('WavFile: couldn\'t load ' + url + ' (' + err.message + ')');
            return null;
        });
    },

    // Download an XYSoundBuffer as a WAV.
    save(filename, buffer, format = WavFile.PCM_16) {
        saveBlob(new Blob([WavFile.encode(buffer, format)], { type: 'audio/wav' }), filename);
        return true;
    }

};

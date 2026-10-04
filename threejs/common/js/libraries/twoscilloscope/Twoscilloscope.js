/*
+ + +   three.twoscilloscope: vectors to audio, audio to vectors, and back   + + +
+ + +   Nick Fox-Gieg  https://fox-gieg.com                                  + + +

A three.js port of ofxTwoscilloscope, which joins two oscilloscope projects
at the audio. Import everything from here, as ofxTwoscilloscope.h included
everything:

    import { XYscope, Oscilloscope, XYTransformer, XYLowPass } from 'twoscilloscope';

    XYscope        vector shapes -> XY audio, ported from XYscope (Processing)
    Oscilloscope   XY audio -> beam rendering + vector shapes, ported from Oscilloscope (oF)
    XYTransformer  vector shape -> audio -> effects -> new vector shape

    const xy = new XYscope();
    xy.setup(512, 512);
    xy.openAudioOut();                      // plays after the first click or key press

    const scope = new Oscilloscope();
    scope.setup(512, 512);
    scene.add(scope.screen);
    xy.onAudioOut = (buffer) => scope.addBuffer(buffer);

    const transformer = new XYTransformer();
    transformer.setup(512, 512);
    transformer.effects.add(new XYLowPass());

    function animate() {
        xy.clearWaves();
        xy.circle(256, 256, 200);
        xy.buildWaves();

        scope.update();
        scope.render(renderer);
        renderer.render(scene, camera);
        const shapes = scope.getShapes(512, 512);
        const altered = transformer.transform(shapes);
    }

What it's built on: three.js and the browser, nothing else.
* three.js draws: the beam is an OsciMesh (a THREE.Mesh with the beam
  shader) rendered into a WebGLRenderTarget, and the previews and decoded
  shapes are lines (XYscopeHelper, XYShapes). lil-gui, which comes with
  three.js, is the effect panel (XYGui).
* The Web Audio API makes the sound. An AudioWorklet runs XYscope's
  oscillators on the audio thread, which is the job ofSoundStream did. An
  AudioBufferSourceNode plays files for XYPlayer, and getUserMedia is the
  line input.
* Plain JavaScript does the rest: the effects, the decoder and WAV files.
  XYTransformer has to run its effects synchronously, sample by sample,
  inside an encode -> effects -> decode round trip every frame, which a Web
  Audio graph can't do.

The modules follow ofxTwoscilloscope's source files, and each starts with
what changed. LGPL v3, as ofxTwoscilloscope: XYscope, XYWavetable and
HersheyFont are ports of XYscope by Ted Davis
(https://teddavis.org/xyscope). The parts from Hansi Raber's Oscilloscope
(https://github.com/kritzikratzi/Oscilloscope) are also MIT licensed.
*/

import { XYAudio } from './XYAudio.js';
import { hsbToRgb, saveBlob, timestamp } from './XYUtils.js';

// encoding: XYscope
export { XYscope } from './XYscope.js';
export { XYscopeHelper } from './XYscopeHelper.js';
export { XYWavetable } from './XYWavetable.js';
export { HersheyFont } from './HersheyFont.js';

// decoding: Oscilloscope
export { Oscilloscope } from './Oscilloscope.js';
export { OsciMesh } from './OsciMesh.js';
export { StreamResampler } from './StreamResampler.js';
export { XYDecoder, XYDecoderSettings } from './XYDecoder.js';
export { XYPlayer } from './XYPlayer.js';
export { XYAudioInput } from './XYAudioInput.js';

// transforming
export {
    XYEffect, XYBiquad, XYDelayLine, XYLowPass, XYHighPass, XYChannelDelay, XYEcho, XYBitCrush,
    XYSampleHold, XYDrive, XYWavefold, XYRingMod, XYNoise, XYRotate, XYEffectChain
} from './XYEffects.js';
export { XYTransformer } from './XYTransformer.js';

// files
export { WavFile } from './WavFile.js';

// shapes, sound and settings: ofPolyline, ofSoundBuffer and ofParameterGroup
export { XYPolyline } from './XYPolyline.js';
export { XYShapes, fillGeometry } from './XYShapes.js';
export { XYSoundBuffer, XYFloatArray } from './XYSoundBuffer.js';
export { XYParameterGroup } from './XYParameterGroup.js';
export { XYGui } from './XYGui.js';
export { XYAudio };

export const Twoscilloscope = {
    VERSION: '1.0.0',
    // the shared audio context: Twoscilloscope.audio.state(), .resume(), .context
    audio: XYAudio,
    saveBlob,
    timestamp,
    hsbToRgb
};

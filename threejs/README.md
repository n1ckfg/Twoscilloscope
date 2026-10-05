# three.twoscilloscope

Vector shapes to oscilloscope audio and back again in three.js: a port of
[ofxTwoscilloscope](../openframeworks/ofxTwoscilloscope), tested with three.js r160 in Chromium.

Two oscilloscope projects, joined at the audio:

* **[XYscope](https://teddavis.org/xyscope)** by Ted Davis turns vector drawings into audio
  for analog vector displays: `XYscope`.
* **[Oscilloscope](https://github.com/kritzikratzi/Oscilloscope)** by Hansi Raber renders XY
  audio the way an analog scope does: `Oscilloscope`, plus `XYDecoder` to recover the vector
  shapes from the audio.
* `XYTransformer` does the third thing: it turns a vector shape into a new vector shape by
  encoding it as audio, running the audio through effects, and decoding it again.

It's a set of ES modules, one per class as in the addon's `src/`, with
`Twoscilloscope.js` exporting everything:

```html
<script type="importmap">
    {
        "imports": {
            "three": "../common/js/libraries/threejs/three.module.js",
            "three/addons/": "../common/js/libraries/threejs/addons/",
            "twoscilloscope": "../common/js/libraries/twoscilloscope/Twoscilloscope.js"
        }
    }
</script>
<script type="module">
    import { XYscope, Oscilloscope, XYTransformer } from 'twoscilloscope';
</script>
```

## Running the examples

The examples fetch fonts and audio files, and the sound runs on an AudioWorklet, which only
works in a secure context: `https://`, or `http://localhost` / `http://127.0.0.1`. So serve this
folder rather than opening the files directly. `run.command` (macOS) and `run.bat` (Windows)
start [http-server](https://www.npmjs.com/package/http-server) here (`npm install -g
http-server`) and open the list of examples. Any static server pointed at this folder works.

Browsers only start audio after a click or a key press. Until then the examples run silently
and say so in their status line.

## Libraries

Everything lives in `common/js/libraries`:

| File | What it's for |
| --- | --- |
| `threejs/three.module.js` | three.js r160, the copy your other projects use |
| `threejs/addons/controls/OrbitControls.js` | the camera in example-latk, in place of ofEasyCam |
| `threejs/addons/libs/lil-gui.module.min.js` | lil-gui 0.17, the effect panel, in place of ofxGui |
| `twoscilloscope/` | the port |
| `latk.js` | [latk.js](https://github.com/n1ckfg/latk.js), to read `.latk` files in example-latk (it bundles JSZip) |

As in the p5.js port, the sound needs nothing past the Web Audio API: an **AudioWorklet** runs
XYscope's oscillators (the job ofSoundStream's audio thread did), an **AudioBufferSourceNode**
plays files, and **getUserMedia** is the line input. The effects are plain JavaScript, because
`XYTransformer` runs them synchronously inside an encode -> effects -> decode round trip every
frame, which no Web Audio graph (Tone.js's included) can do.

## 1. Vectors to audio: `XYscope`

```js
const xy = new XYscope();
xy.setup(512, 512);       // canvas, 44.1kHz, 512 sample waves
xy.openAudioOut();        // the default sound card, once the page has been clicked

const preview = new XYscopeHelper(xy, 'xy');   // what the scope will show
scene.add(preview);

function animate() {
    if (!xy.isAudioRunning()) xy.process(clock.getDelta()); // keep the preview moving
    xy.clearWaves();
    xy.circle(256, 256, 300);
    xy.textSize(48);
    xy.text('hello', 40, 40);
    xy.buildWaves();
    preview.update();
    renderer.render(scene, camera);
}
```

The drawing API is XYscope's, as in ofxTwoscilloscope: `point`, `line`, `rect`, `square`,
`ellipse`, `circle`, `lissajous`, `beginShape`/`vertex`/`endShape`, 3D `box`, `sphere`,
`ellipsoid` and `torus`, a transform stack (`pushMatrix`, `translate`, `rotate`, `rotateX`...,
a `THREE.Matrix4` underneath), and text in 32 single stroke Hershey fonts. `polylines()` takes
`XYPolyline`s or arrays of points. Getters and setters share a name: `freq()` reads and
`freq(50)` sets, likewise `amp()`, `steps()`, `waveSize()`, `limitPoints()`, `limitPath()`,
`zRange()` and `vectrex()`.

The draw functions become **`XYscopeHelper`**s, three.js objects that stay in a scene and
catch up with `update()`, like three's own helpers: `'path'`, `'points'`, `'xy'`,
`'waveform'`, `'wave'` or `'all'`. They're in canvas pixels, y down, so an
`OrthographicCamera(0, width, 0, height, -1, 1)` lines them up with the canvas.

Other ways to get the audio out:

```js
xy.onAudioOut = (buffer) => scope.addBuffer(buffer); // everything the sound card plays
xy.openAudioOut(3);                     // Z on a third channel, if the sound card has one
xy.openAudioOut(3, 2);                  // make X, Y and Z, send only X and Y to the speakers
const audio = xy.render(4, 3);          // 4 seconds, offline, as an XYSoundBuffer
xy.recorderBegin(); ... xy.recorderEnd();   // download XYscope_<date>.wav
WavFile.save('drawing.wav', audio);     // download any buffer
```

Fonts other than `futural` (built in) load from `common/data/hershey_fonts`: wait for
`HersheyFont.preload('scripts', 'timesr')` to have them from the first frame, or let
`xy.textFont('scripts')` load one on demand and switch once it arrives.

## 2. Audio to vectors: `Oscilloscope` and `XYDecoder`

```js
const scope = new Oscilloscope();
scope.setup(512, 512);
scene.add(scope.screen);                // a 1 x 1 plane showing the beam

const player = new XYPlayer();
player.setScope(scope);
player.openAudioOut();
player.load('data/xyscope.wav').then(() => player.play());

const shapes = new XYShapes();          // decoded shapes, as lines
scene.add(shapes);

function animate() {
    player.update(clock.getDelta());    // feeds the scope, on the audio clock once it plays
    scope.update();
    scope.render(renderer);             // the beam, into its render target
    shapes.setShapes(scope.getShapes(512, 512));
    renderer.render(scene, camera);
}
```

`Oscilloscope` takes audio from anything (`addBuffer()`, an `XYAudioInput`, an XYscope's
`onAudioOut`), upsamples it to 192kHz and draws it with the original app's gaussian beam shader
(`OsciMesh`, a `THREE.Mesh`) into a fading `WebGLRenderTarget`, for the glow and afterglow of a
CRT. `scope.screen` shows it anywhere in a scene; `scope.getTexture()` is the texture itself.
1, 2, 3 and 4 channel audio draw as Y-T, X-Y, X-Y with brightness, and a red/cyan pair. The
settings are plain properties: `strokeWeight`, `intensity`, `afterglow`, `hue`, `scale`,
`invertX`, `invertY`, `flipXY`, `zModulation`, `zRange`.

`getShapes()` hands the most recent audio to `XYDecoder`, which finds the loop, maps one loop
of samples back to the canvas, and breaks it into strokes where Z blanks the beam or the beam
jumps. Use `XYDecoder` directly on any buffer:

```js
const audio = await WavFile.load('drawing.wav');
const settings = new XYDecoderSettings();
settings.width = settings.height = 512;
const shapes = XYDecoder.decode(audio, settings);  // XYPolylines of THREE.Vector2s
XYDecoder.saveSvg('drawing.svg', shapes, 512, 512);
```

## 3. Vectors to audio to vectors: `XYTransformer`

```js
const transformer = new XYTransformer();
transformer.setup(512, 512);   // canvas, 44.1kHz, 50Hz loop
transformer.effects.add(new XYLowPass()).cutoff = 1200;
transformer.effects.add(new XYChannelDelay()).delayY = 0.5;

function animate() {
    altered = transformer.transform(shapes);
}
```

`getProcessedWaves()` is the last loop of altered audio as `{x, y, z}`, ready for
`XYscope.setWaveforms()`, so you can hear (or scope) exactly the shape you see.

| Effect | What it does to a shape |
| --- | --- |
| `XYLowPass` | rounds corners and swallows small detail |
| `XYHighPass` | AC coupling: shapes sag and smear, like a cheap sound card |
| `XYChannelDelay` | delays X or Y, shearing the shape and opening lines into loops |
| `XYEcho` | ghost copies from earlier in the loop |
| `XYBitCrush` | snaps the beam to a coarse grid |
| `XYSampleHold` | lowers the sample rate: steps, corners and stray dots |
| `XYDrive` | tanh saturation pushes shapes out towards a rounded square |
| `XYWavefold` | folds the signal back at the edges, a kaleidoscope |
| `XYRingMod` | multiplies by a sine: shapes pulse in and out of the center |
| `XYNoise` | jitter, seeded so the same settings give the same shape |
| `XYRotate` | mixes X and Y with a rotation matrix, optionally spinning |

Every setting is a property listed in `effect.parameters`, so
`new XYGui(new GUI(), transformer.effects.parameters)` gives you a lil-gui panel. Extend
`XYEffect` and override `processFrame(frame)` (change `frame.x` and `frame.y`) for your own.

## Examples

Each is an `index.html` and a `main.js` with the oF example's window size, layout and keys.

* **example-encode**: shapes, Hershey text, a 3D torus or a mouse drawing, played out of the
  sound card as XYscope audio, with the wavetables and output alongside. `r` records, `e`
  exports 10 seconds offline as a 3-channel WAV.
* **example-decode**: plays `data/xyscope.wav` (or any WAV you drop on the window, or the line
  input with `i`) through the beam renderer, and decodes it into vector shapes beside it. `s`
  saves them as SVG.
* **example-transform**: a shape, the same shape as audio through the effects (as a beam), and
  the shape decoded from that audio. Pick sources with `1`-`4` (or draw in the first panel),
  solo effects with `e`, tweak them in the panel, and press `a` to feed the result back in for
  another generation. `s` saves SVG, `w` saves WAV.
* **example-latk**: a 3D Latk animation through the same round trip, with its own
  `LatkScopeRenderer` so each stroke keeps its colour, drawn as beams, decoded strokes or the
  original lines in 3D (`l`). OrbitControls: drag to orbit, scroll to zoom, right-drag to pan,
  double-click to reset.

## Differences from ofxTwoscilloscope

The same as for the [p5.js port](../p5js/README.md): sound starts on a click or key press,
files are fetched and saved as downloads, there's one thread for the drawing, settings are plain
properties, and `XYNoise` uses its own seeded generator. And, for three.js:

* **Drawing is retained.** The draw functions are `XYscopeHelper`s, decoded shapes go in an
  `XYShapes`, `OsciMesh` is a `THREE.Mesh` placed by its transform, and `Oscilloscope` renders
  into a `WebGLRenderTarget` shown by `scope.screen`, in place of `draw(x, y, w, h)`.
* **The beam isn't colour managed**: the beam shader and `scope.screen` write their values as
  they are, as oF did. Lines and backgrounds use three's colour management, so their colours
  come out as written.
* **Text on screen is HTML** over the canvas, and the panel is lil-gui (`XYGui`).
* **The examples run at up to 60 frames a second**, as oF's `ofSetFrameRate(60)`: the beam's
  afterglow fades once a frame, so the frame rate sets how bright it looks.
* **example-latk** uses OrbitControls in place of ofEasyCam, framed on the whole drawing with Y
  up, and saves `.latk` files with latk.js's JSZip, since latk.js's own `write()` doesn't work
  yet.

## License

LGPL v3, as ofxTwoscilloscope, since `XYscope`, `XYWavetable` and `HersheyFont` are ports of
XYscope (LGPL v3). The code ported from Oscilloscope is also under its MIT license, and the
Hershey font data carries its own acknowledgements (`common/data/hershey_fonts/hershey.txt`).
three.js, OrbitControls and lil-gui are MIT licensed. See
[LICENSE.txt](../openframeworks/ofxTwoscilloscope/LICENSE.txt).

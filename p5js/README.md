# p5.twoscilloscope

Vector shapes to oscilloscope audio and back again in p5.js: a port of
[ofxTwoscilloscope](../openframeworks/ofxTwoscilloscope), tested with p5.js 1.9.4 in Chromium.

Two oscilloscope projects, joined at the audio:

* **[XYscope](https://teddavis.org/xyscope)** by Ted Davis turns vector drawings into audio
  for analog vector displays: `XYscope`.
* **[Oscilloscope](https://github.com/kritzikratzi/Oscilloscope)** by Hansi Raber renders XY
  audio the way an analog scope does: `Oscilloscope`, plus `XYDecoder` to recover the vector
  shapes from the audio.
* `XYTransformer` does the third thing: it turns a vector shape into a new vector shape by
  encoding it as audio, running the audio through effects, and decoding it again.

```html
<script src="../common/js/libraries/p5.min.js"></script>
<script src="../common/js/libraries/p5.twoscilloscope.js"></script>
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
| `p5.min.js` | p5.js 1.9.4 |
| `p5.twoscilloscope.js` | the port: one file, no dependencies beyond p5.js |
| `latk.js` | [latk.js](https://github.com/n1ckfg/latk.js), to read `.latk` files in example-latk (it bundles JSZip) |

`p5.min.js` doesn't include sound (p5.sound is a separate library), but the port doesn't need
p5.sound, Tone.js or genish.js either. The browser's own Web Audio API covers it:

* XYscope plays wavetables that change every frame, with a Z channel, at an exact loop
  frequency. That needs a per-sample oscillator, so it runs on an **AudioWorklet**: the job
  ofSoundStream's audio thread did. p5.sound and Tone.js oscillators are built from Fourier
  partials (PeriodicWave), which can't follow an arbitrary table that's swapped every frame.
* `XYTransformer` encodes a shape, runs the effects over a few loops and decodes the last one,
  every frame, synchronously. Effects inside a Web Audio graph (Tone.js's or anyone's) run in
  real time on the audio thread, and an OfflineAudioContext is asynchronous and far too heavy
  to start 60 times a second. So the effects are plain JavaScript on Float32Arrays, ported line
  for line, and seeded so a transform is repeatable. genish.js would compile the same few
  lines of DSP and add nothing the port needs.
* File playback uses an **AudioBufferSourceNode**, which resamples to the sound card for free.
  The line input uses **getUserMedia**.
* p5.js supplies the drawing, a WEBGL `p5.Graphics` for the beam shader, and the DOM functions
  the effect panel is built from (in place of ofxGui).

## 1. Vectors to audio: `XYscope`

```js
let xy;

function setup() {
    createCanvas(512, 512);
    xy = new XYscope();
    xy.setup();          // canvas = sketch size, 44.1kHz, 512 sample waves
    xy.openAudioOut();   // the default sound card, once the page has been clicked
}

function draw() {
    if (!xy.isAudioRunning()) xy.process(deltaTime / 1000); // keep the preview moving
    background(0);
    xy.clearWaves();
    xy.circle(width / 2, height / 2, 300);
    xy.textSize(48);
    xy.text('hello', 40, 40);
    xy.buildWaves();

    xy.drawXY();         // a preview of what the scope will show
}
```

The drawing API is XYscope's, as in ofxTwoscilloscope: `point`, `line`, `rect`, `square`,
`ellipse`, `circle`, `lissajous`, `beginShape`/`vertex`/`endShape`, 3D `box`, `sphere`,
`ellipsoid` and `torus`, a transform stack (`pushMatrix`/`push`, `translate`, `rotate`,
`rotateX`...), and text in 32 single stroke Hershey fonts. `polyline()` and `polylines()` take
`XYPolyline`s or arrays of points. Getters and setters share a name, the p5 way: `freq()` reads
and `freq(50)` sets, likewise `amp()`, `steps()`, `waveSize()`, `limitPoints()`, `limitPath()`,
`zRange()` and `vectrex()`.

Other ways to get the audio out:

```js
xy.onAudioOut = (buffer) => scope.addBuffer(buffer); // everything the sound card plays
xy.openAudioOut(3);                     // Z on a third channel, if the sound card has one
xy.openAudioOut(3, 2);                  // make X, Y and Z, send only X and Y to the speakers
let audio = xy.render(4, 3);            // 4 seconds, offline, as an XYSoundBuffer
xy.recorderBegin(); ... xy.recorderEnd();   // download XYscope_<date>.wav
WavFile.save('drawing.wav', audio);     // download any buffer
```

Fonts other than `futural` (built in) load from `common/data/hershey_fonts`. Load them in
`preload()` with `loadHersheyFont('scripts')` to have them from the first frame;
`xy.textFont('scripts')` also loads one on demand and switches once it arrives.

## 2. Audio to vectors: `Oscilloscope` and `XYDecoder`

```js
let scope, player, shapes = [];

function setup() {
    createCanvas(512, 512);
    scope = new Oscilloscope();
    scope.setup(512, 512);
    player = new XYPlayer();
    player.setScope(scope);
    player.openAudioOut();
    player.load('data/xyscope.wav').then(() => player.play());
}

function draw() {
    player.update(deltaTime / 1000);    // feeds the scope, on the audio clock once it plays
    scope.update();
    scope.draw();
    shapes = scope.getShapes(512, 512); // XYPolylines
}
```

`Oscilloscope` takes audio from anything (`addBuffer()`, an `XYAudioInput`, an XYscope's
`onAudioOut`), upsamples it to 192kHz and draws it with the original app's gaussian beam shader
into a fading WEBGL `p5.Graphics`, for the glow and afterglow of a CRT. 1, 2, 3 and 4 channel
audio draw as Y-T, X-Y, X-Y with brightness, and a red/cyan pair. The settings are plain
properties: `strokeWeight`, `intensity`, `afterglow`, `hue`, `scale`, `invertX`, `invertY`,
`flipXY`, `zModulation`, `zRange`.

`getShapes()` hands the most recent audio to `XYDecoder`, which finds the loop, maps one loop
of samples back to the canvas, and breaks it into strokes where Z blanks the beam or the beam
jumps. Use `XYDecoder` directly on any buffer:

```js
WavFile.load('drawing.wav').then((audio) => {
    const settings = new XYDecoderSettings();
    settings.width = settings.height = 512;
    const shapes = XYDecoder.decode(audio, settings);
    XYDecoder.saveSvg('drawing.svg', shapes, 512, 512);
});
```

## 3. Vectors to audio to vectors: `XYTransformer`

```js
let transformer;

function setup() {
    transformer = new XYTransformer();
    transformer.setup(512, 512);   // canvas, 44.1kHz, 50Hz loop
    transformer.effects.add(new XYLowPass()).cutoff = 1200;
    transformer.effects.add(new XYChannelDelay()).delayY = 0.5;
}

function draw() {
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
`new XYPanel(transformer.effects.parameters, 10, 10)` gives you a panel of sliders. Extend
`XYEffect` and override `processFrame(frame)` (change `frame.x` and `frame.y`) for your own.

## Examples

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
  original lines (`l`). Drag to orbit, scroll to zoom, double-click to reset.

## Differences from ofxTwoscilloscope

* **Sound starts on a click or key press**, as browsers require. `isAudioRunning()` says when;
  until then `XYscope.process()` and `XYPlayer.update()` keep everything moving silently.
* **Files are fetched and saved as downloads**: fonts, WAVs and Latk files come over http, and
  recordings, WAVs, SVGs and `.latk` files download. `XYPlayer.load()` also takes a `File` (from
  a drop) and falls back to the browser's decoders for MP3, FLAC and the like.
* **One thread for the sketch.** The AudioWorklet only synthesizes and sends back what it
  played, so there are no mutexes. The output device can't be chosen.
* **ofParameters are plain properties** (`lowPass.cutoff = 1500`), listed in
  `XYParameterGroup`s, and `XYPanel` (p5 DOM) replaces ofxGui.
* **ofPolyline, ofSoundBuffer and ofFbo** become `XYPolyline`, `XYSoundBuffer` and a WEBGL
  `p5.Graphics` (`scope.getGraphics()`), and p5's constants replace oF's (`CENTER`, `TOP`...).
  `XYscope.path(ofPath)` is gone.
* **XYNoise** uses a seeded mulberry32 generator rather than `std::mt19937`, so it's repeatable
  but not the same jitter as in openFrameworks.
* **example-latk** frames the whole drawing with its own orbit camera (Y up, as in ofxLatk)
  instead of ofEasyCam's default close-up, and its `o` key saves the drawing with latk.js's
  JSZip, since latk.js's own `write()` doesn't work yet.

## License

LGPL v3, as ofxTwoscilloscope, since `XYscope`, `XYWavetable` and `HersheyFont` are ports of
XYscope (LGPL v3). The code ported from Oscilloscope is also under its MIT license, and the
Hershey font data carries its own acknowledgements (`common/data/hershey_fonts/hershey.txt`).
See [LICENSE.txt](../openframeworks/ofxTwoscilloscope/LICENSE.txt).

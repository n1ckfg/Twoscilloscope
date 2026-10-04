# p5.twoscilloscope Architecture

## Overview

A p5.js port of ofxTwoscilloscope. The pipeline is the same:

```
                    XYscope                      XYEffectChain                XYDecoder
 shapes (canvas px) -------> XY(Z) audio loop ------------------> altered audio ---------> shapes (canvas px)
      ^                          |                                     |
      |                          v                                     v
  HersheyFont         AudioWorklet / WavFile                  Oscilloscope + OsciMesh
                                                         (beam image in a WEBGL p5.Graphics)
```

The library is one file, `common/js/libraries/p5.twoscilloscope.js`, loaded after p5.js. Its
sections follow the addon's source files, in the same order, and each starts with the comment
from the addon's header plus what changed. Everything is wrapped in one function, and the
public classes are put on `window` at the end.

```
p5js/
  index.html, run.command, run.bat   list of examples, and a local server to see them
  common/js/libraries/               p5.min.js, p5.twoscilloscope.js, latk.js
  common/data/hershey_fonts/         the 32 Hershey fonts (.jhf), fetched on demand
  example-encode/  example-decode/  example-transform/  example-latk/
```

## From openFrameworks to the browser

| ofxTwoscilloscope | p5.twoscilloscope |
| --- | --- |
| `ofSoundStream`, audio thread | the shared `AudioContext` (`Twoscilloscope.audio`) and two AudioWorklet processors |
| `ofSoundBuffer` | `XYSoundBuffer`: interleaved `Float32Array` samples, `numChannels`, `sampleRate` |
| `std::vector<float>` | `Float32Array`, or `XYFloatArray` where it grows |
| `ofPolyline` | `XYPolyline`: `{x, y}` points, `closed`, `simplify()` (oF's Douglas-Peucker), `draw()` |
| `glm::mat4` | `Mat4`: column-major `Float64Array`s, as glm's |
| `ofParameter`, `ofParameterGroup`, ofxGui | plain properties, `XYParameterGroup`, `XYPanel` (p5 DOM) |
| `ofFbo`, `ofShader`, `ofMesh` | a WEBGL `p5.Graphics` drawn with raw WebGL, GLSL ES 1.00 shaders, a `Float32Array` of vertices |
| `ofFile`, `ofBufferToFile` | `fetch()`, and downloads through `Twoscilloscope.saveBlob()` |

## Audio

### The shared context
`XYAudio` (exported as `Twoscilloscope.audio`) makes one `AudioContext` for the page, at the
sample rate the first user asks for if the browser allows it. Browsers keep it suspended until
the page gets a click, a tap or a key press, so it listens for the first one (in the capture
phase, so a sketch can't swallow it) and resumes then. `state()` reports `suspended`,
`running` or `unavailable`.

The AudioWorklet module is built from a function in the library (`workletMain`), turned into a
Blob URL, so the library needs no second file and no knowledge of its own path. It registers
two processors.

### `XYscope` on the audio thread
`xyscope-processor` is `XYscope::synth()` again: phase accumulators read the X, Y and Z tables
at `freq()` Hz, scaled by `amp()` and panned with Minim's equal-power law. The main thread sends
it the tables and the settings by message. `XYWavetable.onChange` marks the tables dirty and a
microtask sends all three at once, so the audio thread always swaps in an X, Y and Z from the
same `buildWaves()`. That replaces the `shared_ptr` swap under a mutex.

The processor sends back everything it plays in blocks of `bufferSize()` frames (transferred,
not copied). `XYscope.receive()` passes each block to the previews, the recorder and
`onAudioOut`, the hook for anything that wants the live audio, such as an `Oscilloscope`. It
can make more channels than it sends to the speakers (`openAudioOut(3, 2)`), so Z reaches the
scope without reaching the sound card.

`process()`, `audioOut()` and `render()` run the same synthesis on the main thread, for running
without sound (or before the first click) and for offline rendering.

### `XYPlayer` on the audio clock
A file plays through an `AudioBufferSourceNode`, which loops and resamples to the sound card
natively. It carries X and Y only, or one channel for a mono file. `update()` is called every
frame. When the sound card is running it advances the play position by the audio clock's time
since the last call, wrapping as the source does, and feeds the scope the file's own samples
in between, all channels including Z. Without sound it advances by the seconds it's given. A
long stall (a hidden tab) feeds the scope at most a second.

### `XYAudioInput`
`getUserMedia` (echo cancellation, noise suppression and auto gain off), into
`xycapture-processor`, which sends input blocks back like the XYscope processor does.

## Rendering the beam

`OsciMesh` builds the same quads as the original: six vertices for each pair of samples, with
the position and brightness in one attribute and the segment-space coordinates and length in
another. The beam shader integrates a gaussian spot along each segment with an erf
approximation (after m1el's woscope), unchanged apart from being GLSL ES 1.00.

It draws into a WEBGL `p5.Graphics` (`OsciMesh.createCanvas()`) with raw WebGL calls, setting
every bit of GL state it needs on each draw. p5 never draws into that canvas, so p5's cached GL
state can't go stale, and the result goes into any sketch, 2D or WEBGL, with `image()`. The
transform from scope units to pixels is an affine `{a, b, c, d, e, f}` (canvas `setTransform`
order) in place of the current oF matrix. p5 creates WEBGL canvases with
`preserveDrawingBuffer`, so the canvas keeps its contents between frames. That lets
`Oscilloscope` fade it each frame with oF's multiply blend (`DST_COLOR, ONE_MINUS_SRC_ALPHA`)
before adding the new beam (`SRC_ALPHA, ONE`), which gives the afterglow.

`Oscilloscope` itself is the addon's class without the mutex. Audio arrives on the main thread
through `addSamples()`, is upsampled to 192kHz by `StreamResampler` (Lanczos, 4 lobes, with
each output sample's sines shared across its taps) into a pending queue capped at 1/15 s, and
kept at its own rate for `getShapes()`.

## Decoding and transforming

`XYDecoder`, `XYEffect`s and `XYTransformer` are line-for-line ports on `Float32Array`s
(`subarray()` stands in for pointer offsets). Effects change `frame.x` and `frame.y` in
`processFrame(frame)`, in place of two float references. `XYNoise` seeds mulberry32. The
Douglas-Peucker in `XYPolyline.simplify()` keeps its own stack, so very long strokes can't
overflow JavaScript's.

## Text

`HersheyFont` parses `.jhf` files exactly as the addon does. `futural` is built in. The others
are fetched from `HersheyFont.dataPath` (`common/data/hershey_fonts/`, found from the library's
own URL) and cached as text and as parsed glyphs. `load()` stays synchronous: it switches if
the font is in and otherwise starts the fetch and returns false. `loadHersheyFont()` is a p5
preload method, and `HersheyFont.preload()` returns a promise.

## p5 integration

* `registerMethod('init')` remembers the sketch, so `draw()` functions, `Oscilloscope` and
  `XYPanel` have something to draw into. Each draw function also takes a `target` (a
  `p5.Graphics`, or a sketch in instance mode).
* `registerMethod('post')` lets every `XYPanel` read its settings back after `draw()`, so
  settings changed in code move their controls.
* `loadHersheyFont()` is registered with `registerPreloadMethod`.

## Examples

Each is an `index.html` and a `sketch.js` (global mode), drawn on a 2D canvas, with the oF
example's window size, layout and keys:

* **example-encode**: `XYscope` with Processing-style shapes, text, 3D and drawing.
* **example-decode**: `XYPlayer`, `Oscilloscope` and `XYAudioInput`.
* **example-transform**: `XYTransformer`, an `XYscope` looping its result, an `Oscilloscope`,
  and an `XYPanel` for the effects.
* **example-latk**: `LatkScopeRenderer.js` is the oF example's renderer: it projects each Latk
  stroke through the camera, clips it to the canvas, encodes all of them into one loop it lays
  out itself (so each sample belongs to a known stroke), runs the effects through
  `XYTransformer`, and draws the result as one `OsciMesh` per colour or decodes each stroke on
  its own. `OrbitCamera.js` stands in for ofEasyCam and keeps its own matrices, so the lines
  view, the beams and the audio all use the same projection. latk.js reads the file. Its
  reader looks for a global called `latk` while it parses, which is why the sketch's variable
  has that name.

## Threading

| Object | Audio thread | Main thread | Shared through |
| --- | --- | --- | --- |
| `XYscope` | `xyscope-processor` | drawing, `buildWaves()`, settings, previews, recorder | messages: tables and settings in, played blocks out |
| `XYPlayer` | `AudioBufferSourceNode` | position, scope feeding | the audio clock (`currentTime`) |
| `XYAudioInput` | `xycapture-processor` | `onAudioIn` | messages: input blocks out |
| `Oscilloscope`, `XYDecoder`, `XYTransformer`, effects | none | everything | nothing shared |

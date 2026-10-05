# three.twoscilloscope Architecture

## Overview

A three.js port of ofxTwoscilloscope, and a sibling of the p5.js port in `../p5js`. The pipeline
is the same:

```
                    XYscope                      XYEffectChain                XYDecoder
 shapes (canvas px) -------> XY(Z) audio loop ------------------> altered audio ---------> shapes (canvas px)
      ^                          |                                     |
      |                          v                                     v
  HersheyFont         AudioWorklet / WavFile                  Oscilloscope + OsciMesh
                                                         (beam image in a WebGLRenderTarget)
```

```
threejs/
  index.html, run.command, run.bat   list of examples, and a local server to see them
  common/css/main.css                the text over the canvas, and where the panel sits
  common/js/libraries/threejs/       three.js r160, OrbitControls, lil-gui
  common/js/libraries/twoscilloscope/  the port, as ES modules
  common/js/libraries/latk.js
  common/data/hershey_fonts/         the 32 Hershey fonts (.jhf), fetched on demand
  example-encode/  example-decode/  example-transform/  example-latk/
```

## Modules

One per class, named as in the addon's `src/`, each starting with what changed. `Twoscilloscope.js`
exports them all, as `ofxTwoscilloscope.h` included them all.

| Module | From | three.js-specific |
| --- | --- | --- |
| `XYscope.js` | XYscope | the transform stack is a `Matrix4`; no drawing |
| `XYscopeHelper.js` | XYscope's `draw*()` | `Group`s of `Line`s and `Points`, refreshed by `update()` |
| `XYWavetable.js`, `HersheyFont.js` (+ `HersheyFutural.js`) | XYWavetable, HersheyFont | |
| `Oscilloscope.js` | Oscilloscope | renders into a `WebGLRenderTarget`, shown by `screen` |
| `OsciMesh.js` | OsciMesh | a `Mesh` with the beam `ShaderMaterial` |
| `StreamResampler.js`, `XYDecoder.js`, `XYPlayer.js` | the same | decoded points are `Vector2`s |
| `XYEffects.js`, `XYTransformer.js`, `WavFile.js` | the same | |
| `XYAudio.js`, `XYAudioWorklet.js`, `XYAudioInput.js` | ofSoundStream | |
| `XYPolyline.js`, `XYShapes.js` | ofPolyline | `Vector2` points; `XYShapes` draws many as one `LineSegments` |
| `XYSoundBuffer.js`, `XYParameterGroup.js`, `XYGui.js`, `XYUtils.js` | ofSoundBuffer, ofParameterGroup, ofxGui, oF utilities | `XYGui` fills a lil-gui panel |

Everything but the drawing (`XYscopeHelper`, `XYShapes`, `OsciMesh`, `Oscilloscope`'s rendering
and `XYGui`) is the same code as the p5.js port's, as modules. See `../p5js/ARCHITECTURE.md` for
the audio thread, `XYPlayer`'s audio clock, the decoder and the effects.

## Rendering

### The beam
`OsciMesh` is a `THREE.Mesh`. Its geometry has the original's quads, six vertices for each pair of
samples: `position` holds x, y and the brightness, and `uvl` the segment-space coordinates and
length. The vertices live in growable `Float32Array`s handed to the geometry as they are, and
re-uploaded with update ranges as far as they're used. When the arrays grow, the geometry is
replaced and the old one disposed, which frees its GPU buffers. `uSize`, `uRgb` and `uIntensity`
are properties copied to the uniforms in `onBeforeRender`.

The material is a `ShaderMaterial` with the woscope beam shader, written GLSL ES 1.00 style,
which three converts for WebGL 2. It uses `AdditiveBlending`, which is `SRC_ALPHA, ONE` like oF's
`OF_BLENDMODE_ADD`, with no depth, on both sides, since cameras that flip y flip triangles.
three adds no colour management to a ShaderMaterial, so the beam comes out exactly as the shader
writes it.

### The afterglow
`Oscilloscope.render(renderer)` draws into its `WebGLRenderTarget` (8-bit RGBA, no depth, the
renderer's pixel ratio) with `autoClear` off. First comes a full-screen quad of
`(0, 0, 0, 1 - afterglow)` with `CustomBlending` (`DstColorFactor`, `OneMinusSrcAlphaFactor`),
which is oF's multiply blend and keeps `afterglow` of the old image. Then the meshes go in with an
orthographic camera in the target's pixels. It restores the renderer's target, clear colour and
`autoClear` afterwards. `screen` is a 1 x 1 `PlaneGeometry` with a shader that shows the texture
unchanged.

### Lines and shapes
`fillGeometry()` refills a `Line`, `LineSegments` or `Points` with a vertex count, reusing
buffers that are big enough and setting the draw range. `XYShapes` puts any number of
`XYPolyline`s into one `LineSegments` with vertex colours (plus a `Points` for their vertices),
which is much cheaper than a `Line` per shape per frame. `XYscopeHelper` uses both. Their
materials are marked transparent even when they're opaque. three draws opaque objects before
transparent ones, so this keeps lines in the order they were added, over opaque backgrounds,
as oF drew them.

## Examples

Each example draws its 2D layout with an `OrthographicCamera(0, width, 0, height, -1, 1)`: window
pixels with y down, so the oF coordinates carry over unchanged, and `renderer.sortObjects =
false`, so things draw in the order they're added. Meshes that face the camera through that
flipped projection use `DoubleSide`, and `scope.screen` gets a negative y scale. Text is HTML
over the canvas (`common/css/main.css`), and the animation loop runs at up to 60 frames a
second, as `ofSetFrameRate(60)` did.

* **example-encode**: `XYscope` with four `XYscopeHelper`s: the path and the output over the
  canvas, and the wavetables and the output waves scaled into the side panel.
* **example-decode**: `XYPlayer`, `Oscilloscope` (its screen on the left) and an `XYShapes` on the
  right; files dropped on the window play, `i` switches to `XYAudioInput`.
* **example-transform**: `XYTransformer`, an `XYscope` looping its result into an `Oscilloscope`,
  `XYShapes` for the source, ghost and result, and an `XYGui` for the effects. Panel 3 is a second
  scene drawn with a scissor, which clips it the way the oF example's `glScissor` did. Keys are
  heard in the capture phase, because lil-gui stops keys from leaving its panel.
* **example-latk**: `LatkScopeRenderer.js` is the oF example's renderer. It projects the strokes
  with the camera's `projectionMatrix` times `matrixWorldInverse` (oF's
  `getModelViewProjectionMatrix()`), so the beams, the decoded strokes and the original lines,
  which are drawn in 3D through the same `PerspectiveCamera` and OrbitControls, all agree. Its
  beams (an `OsciMesh` per colour) and strokes (an `XYShapes`) are objects in a pixel-space
  overlay scene. latk.js is a classic script, and its reader looks for a global called `latk`
  while it parses, so the module puts the drawing on `window.latk`.

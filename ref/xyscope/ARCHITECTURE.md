# XYscope Architecture

## Overview

**XYscope** is a Processing library that enables artists and programmers to render vector graphics on analog vector displays (such as oscilloscopes, modified Vectrex consoles, and RGB lasers) by translating shapes and paths into high-frequency stereo audio signals. 

At its core, the library acts as a bridge between the Processing drawing environment (`PApplet`) and the **Minim** audio synthesis library. Instead of rendering pixels on a screen, drawing commands generate waveforms. The X and Y coordinates of the drawing map to the Left and Right audio channels, driving the horizontal and vertical deflection of an analog beam.

## Core Dependencies

1. **Processing Core (`processing.core.*`)**: Provides the geometric math, standard drawing syntax, and application context.
2. **Minim Audio Library (`ddf.minim.*`)**: Handles the real-time audio synthesis, oscillator generation, and direct interfacing with the computer's Digital-to-Analog Converters (DACs).

## Key Components

### 1. `XYscope` (Main Class)
Located in `src/xyscope/XYscope.java`, this is the primary interface for the user.
* **Shape Buffering**: It provides a drop-in replacement for Processing's 2D/3D primitive functions (e.g., `xy.line()`, `xy.rect()`, `xy.ellipse()`). These calls do not draw to the screen; instead, they add vertices and paths to an internal `XYShapeList` called `shapes`.
* **Path to Wavetable Translation**: When the user calls `xy.buildWaves()`, the library takes the accumulated `shapes`, normalizes them, interpolates the points based on resolution settings (e.g., `steps()`), and packs them into raw `float[]` arrays representing the X, Y, and Z axes.
* **Audio Routing**: It configures Minim `AudioOutput` interfaces, `Oscil` generators, and `Pan` objects. It dynamically assigns the generated `float[]` arrays to custom wavetables that continuously loop at a specific frequency (usually around 50Hz, to avoid flicker on phosphors).
* **Hardware Modes**: Contains built-in translation logic for specific hardware aspect ratios and requirements (e.g., `vectrex()`, `laser()`).

### 2. `XYWavetable` (Audio Waveform Buffer)
Located in `src/xyscope/XYWavetable.java`, this class implements Minim's `Waveform` interface.
* **Safe Real-Time Execution**: It is a customized version of Minim's standard wavetable, specifically designed by the community to fix `ArrayIndexOutOfBoundsException` bugs that occur when a waveform array is completely replaced while the audio thread is actively reading it. 
* **Signal Generation**: It wraps the raw `float[]` coordinates so they can be smoothly read by Minim's `Oscil` units using a normalized `[0, 1]` lookup.

### 3. Font & Text Engine
* Uses built-in **Hershey Fonts**, which are single-stroke vector fonts. Instead of rendering bitmaps, XYscope translates characters into coordinates that form continuous stroked lines, making it possible to safely and legibly display text on an oscilloscope.

## Signal Flow

1. **Input Phase**: The user sketch executes `xy.clearWaves()` to empty the buffer, followed by drawing instructions (`xy.circle()`, `xy.vertex()`).
2. **Build Phase**: The user calls `xy.buildWaves()`. The paths are processed into continuous `shapeX`, `shapeY`, and `shapeZ` float arrays.
3. **Table Update**: These arrays are passed into `tableX`, `tableY`, and `tableZ` (`XYWavetable` instances).
4. **Oscillation**: Minim `Oscil` instances (`waveX`, `waveY`, `waveZ`) constantly read from the wavetables at a defined frame frequency (e.g., `xy.freq(50)`).
5. **Output**: The oscillator output is routed through panning nodes (X to Left channel, Y to Right channel) and sent to the selected `AudioOutput` (the computer's headphone jack or a dedicated DC-coupled audio interface).

## Output Modes & Extensions

* **Additive Synthesis**: Because the output is just an audio wave, XYscope supports "patching" multiple instances of `XYscope` together. Multiple waveforms can modulate each other, creating complex Lissajous-style interference patterns.
* **Z-Axis (Blanking)**: An optional third audio channel (`outZ`) can be generated. It controls the brightness of the analog beam, turning it off when the "pen" is moving between distinct shapes to prevent visible travel lines.
* **Laser Mode**: Instantiates supplementary Minim objects and oscillators (`minimR`, `minimBG`) to send parallel audio channels to a 5-channel laser DAC (X, Y, Red, Green, Blue). Laser mode also features path limits and "spot killers" for hardware safety.
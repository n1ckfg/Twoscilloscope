# Twoscilloscope Architecture

Twoscilloscope is a web-based application built with **p5.js** that processes live webcam video to simulate an oscilloscope-like vector display. The pipeline is designed for real-time performance by splitting the workload between the GPU for image processing and a CPU Web Worker for vectorization.

## System Overview

The application follows a multi-stage pipeline:

1. **Video Capture (CPU):** Captures frames from the user's webcam using p5.js (`createCapture`).
2. **Edge Detection (GPU):** The video feed is processed using custom WebGL shaders (`edge.vert`, `edge.frag`). It applies a Sobel filter to extract edges and threshold the image, producing a high-contrast outline.
3. **Downsampling (CPU):** The main thread reads the rendered edge pixels (`loadPixels`) and downsamples them into a lower resolution (e.g., 80x60) binary image. This step is crucial for reducing the computational load for the next step.
4. **Skeletonization (CPU Web Worker):** The binary image is passed to a background Web Worker (`skeleton.worker.js`). The worker uses a **Trace Skeleton** algorithm to convert the rasterized pixels into a set of continuous vector lines (polylines). By offloading this intensive calculation to a worker, the main UI thread remains responsive.
5. **Rendering (GPU):** The main thread receives the computed polylines from the worker and draws them back onto the canvas.

## Component Breakdown

### Main Thread (`sketch.js`, `index.html`)
- Initializes the p5.js WebGL canvas and webcam.
- Manages state (e.g., threshold level, viewing modes).
- Dispatches downsampled pixel data to the Web Worker.
- Renders the final vector polylines on top of the original edge-detected feed.
- Handles keyboard interactions (UP/DOWN for threshold, TAB for mode switching).

### WebGL Shaders (`edge.frag`, `edge.vert`)
- **`edge.vert`**: Standard vertex shader that flips the Y-axis for correct webcam orientation.
- **`edge.frag`**: Fragment shader that converts the image to grayscale based on luminance and applies horizontal (`Gx`) and vertical (`Gy`) Sobel kernels to detect edges. Applies a dynamic threshold passed from the main thread.

### Web Worker (`skeleton.worker.js`)
- Runs off the main thread to prevent UI blocking.
- Implements a recursive topological skeleton tracing algorithm (inspired by the reference `skeleton-tracing` implementations) to extract vectorized paths from the binary pixel data.
- Returns an array of polylines to the main thread.

## Reference Implementations (`ref/`)
The repository contains a `ref/` directory with several external projects that informed the architecture:
- **`skeleton-tracing`**: Contains the core algorithm used in `skeleton.worker.js` for converting pixel regions into vector skeletons.
- **`Oscilloscope`** / **`xyscope`**: Native and Processing-based libraries for rendering lines on vector displays/oscilloscopes, providing inspiration for the final output formatting.

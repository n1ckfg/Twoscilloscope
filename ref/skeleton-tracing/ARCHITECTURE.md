# Skeleton Tracing - Architecture

This directory serves as a monorepo containing a multi-language implementation of the **Skeleton Tracing** algorithm. The project is organized such that the root directory handles the central documentation and web-based demonstration, while each subdirectory contains a standalone port of the algorithm for a specific programming language or framework.

## Project Structure

### Root Components
* **`index.html`**: A standalone web-based interactive demo showcasing the skeleton tracing algorithm running in real-time in the browser. It fetches compiled WebAssembly and Vanilla JS implementations from a CDN and supports inputs from images, live webcam feeds, Unicode CJK characters, and freehand drawing.
* **`README.md`**: The central documentation detailing the divide-and-conquer skeleton tracing algorithm, providing links to language-specific implementations, and presenting performance benchmarks across the languages.
* **`indexer.py`**: A Python utility script used to recursively generate static HTML directory listings (`index.html`) for the subdirectories to provide easy navigation and inline rendering of nested `README.md` files.

### Language Implementations
The core algorithm is ported to multiple languages. Each subdirectory acts as a self-contained module containing the source code for the algorithm, examples, and language-specific instructions.

* **`c/`**: High-performance C99 implementation. Parallelized with `pthreads`, using `libpng` for reading and `X11` for display.
* **`cpp/`**: C++ implementation, thinly wrapped around the C version.
* **`cs/`**: C# implementation, featuring a demonstration script for the Unity Engine (`TraceSkeleton.cs`).
* **`go/`**: Go implementation, parallelized using goroutines.
* **`hx/`**: Haxe implementation, including an OpenFL project wrapper.
* **`java/`**: Java implementation, including a demo sketch for Processing (`ProcessingExample.pde`).
* **`jl/`**: Julia implementation utilizing array views.
* **`js/`**: Pure (Vanilla) JavaScript implementation packaged with Rollup, and a p5.js integration example.
* **`of/`**: OpenFrameworks C++ add-on (`ofxTraceSkeleton`), serving as a friendly wrapper on the C++ version.
* **`py/`**: Pure Python implementation (slow, reference version).
* **`rs/`**: Rust implementation.
* **`swift/`**: Swift implementation, featuring a demonstration using `NSImage` and AppKit.
* **`swig/`**: Python wrapper generated via SWIG from the C API. This version is fast and compatible with `numpy` and `opencv`.
* **`wasm/`**: WebAssembly implementation compiled from C++ using Emscripten, complete with a p5.js example and Rollup packaging.
* **`wat/`**: WebAssembly Text (WAT) format experimental implementation.

### Testing and Assets
* **`test_images/`**: Contains binary and raster images used for benchmarking and testing the algorithm across the different language ports (e.g., `opencv-thinning-src-img.png`, `horse_r.png`).

## Data Flow
Regardless of the language implementation, the internal data flow of the algorithm remains consistent:
1. **Input**: A binary image represented as a 1D or 2D array of 0s (background) and 1s (foreground).
2. **Skeletonization (Optional)**: A traditional raster thinning algorithm (e.g., Zhang-Suen) can be applied to reduce the strokes to 1-pixel wide lines.
3. **Divide-and-Conquer Tracing**:
   - The grid is recursively divided into sub-matrices along columns or rows that have the least amount of foreground pixels.
   - At the recursive base case (a very small matrix size), local outgoing pixels are analyzed and vectorized into segments.
   - The algorithm recursively merges the segments back up the call stack, connecting matching endpoints across the splitting boundaries.
4. **Output**: A set of polylines (arrays of `(x, y)` coordinate sequences) representing the topological skeleton.

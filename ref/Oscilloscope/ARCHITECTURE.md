# Oscilloscope Architecture

Oscilloscope is a sophisticated openFrameworks-based application for visualizing audio as X-Y (and Z) signals. It focuses on high-precision rendering and low-latency audio processing to create fluid, detailed oscilloscope visualizations.

## Core Components

- **`ofApp`**: The main application controller. It initializes the `miniaudio` backend for low-latency audio output, manages the UI system (via `ofxMightyUI`), and coordinates the flow of data between the audio player and the mesh rendering engine.
- **`OsciMesh`**: The core rendering engine. It consumes buffers of audio samples (using the left channel for X-axis, right channel for Y-axis, and an optional Z-Mod channel for brightness/intensity) and converts them into an `ofMesh`. It utilizes a custom shader (via `ShaderLoader.h`) to handle visual properties like line thickness and intensity dynamically.
- **`OsciAvAudioPlayer`**: A specialized audio player built on top of `ofxAvCodec` (FFmpeg). It handles decoding of various audio formats (Mono, Stereo, Quad) and provides upsampled, high-sample-rate (192kHz) buffers. This upsampling ensures smooth, high-detail visual lines regardless of the original output sample rate.
- **`Globals`**: A central singleton that stores application settings (such as stroke weight, intensity, afterglow, color mapping) and provides a single point of access for shared resources like the `OsciAvAudioPlayer`.

## Data Flow & Lifecycle

1. **Audio Decoding**: The `OsciAvAudioPlayer` runs a background thread to decode audio files into high-frequency sample buffers (`left192`, `right192`, `zMod192`).
2. **Buffer Processing**: During `ofApp::update`, the application reads audio data from these buffers and feeds the samples to `OsciMesh::addLines()`. This occurs at a high frequency to maintain visual fidelity.
3. **Geometry Generation**: The `OsciMesh` takes these raw audio samples and continuously updates its internal `ofMesh` with new vertices and color values derived from the audio data.
4. **Rendering (Persistence & Afterglow)**: In `ofApp::draw`, the application renders the `OsciMesh` into a Framebuffer Object (FBO). The classic oscilloscope "afterglow" or persistence effect is achieved by partially clearing the FBO with a translucent black rectangle before drawing the new frame, utilizing additive/alpha blending.
5. **UI Interaction & State Management**: The user interface (`ui/`), built using `ofxMightyUI`, allows users to tweak visualization parameters. These interactions modify fields in the `Globals` singleton. Both `ofApp` and `OsciMesh` read from `Globals` during their update/draw cycles to apply the current settings instantly.

## Key Modules & Addons

The application heavily relies on several custom and community openFrameworks addons to extend its capabilities:

- **Audio & Media**
  - **`ofxAvCodec`**: Essential for FFmpeg integration, allowing the app to read and decode a wide variety of audio and video formats.
  - **`ofxLibsamplerate`**: Used for high-quality audio resampling.

- **User Interface**
  - **`ofxMightyUI`**: A custom, modular UI library used for the application's overlays and configuration menus (e.g., `PlayerOverlay`).
  - **`ofxFontStash2` / `ofxFontAwesome`**: For typography and iconography within the UI.

- **Utilities & Integration**
  - **`ofxIniSettings`**: Handles saving and loading persistent application configurations and user settings.
  - **`ofxNative`**: Provides access to platform-specific features like native file dialogs.
  - **`ofxSpout` / `ofxSyphon`**: Integrated via the `TexShare` utility. This allows the oscilloscope's visual output (the FBO texture) to be shared in real-time with other VJ software and creative coding tools across platforms (Spout for Windows, Syphon for macOS).

## Architectural Patterns

- **Model-View-Controller (MVC)**: The application follows a loose MVC pattern. The `Globals` singleton and `OsciAvAudioPlayer` act as the Model (state and data), `ofApp` serves as the Controller (coordinating updates, events, and audio callbacks), and the `ui/` components along with `OsciMesh` act as the View.
- **High-Frequency Visual Polling**: By operating the internal visual representation at 192kHz, the architecture decouples the visual fidelity from the standard audio playback rate (typically 44.1kHz or 48kHz). This ensures that fast transients and high-frequency movements in the waveform are captured and displayed with high precision.
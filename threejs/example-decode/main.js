// Example 2: XYscope format audio -> vector shapes.
//
// An audio file (or the line input) plays through the Oscilloscope renderer,
// which draws it the way an analog scope would. The same audio is decoded
// back into vector shapes, drawn on the right and saved as SVG. The browser
// starts the sound on the first click or key press; until then the file
// plays silently.
//
// space play/pause, left/right seek, i line in, s save svg, p points,
// +/- beam, g glow, h hue, z z-mod, or drop a WAV on the window

import * as THREE from 'three';
import { Oscilloscope, Twoscilloscope, XYAudioInput, XYDecoder, XYPlayer, XYShapes } from 'twoscilloscope';

const WIDTH = 1024, HEIGHT = 600;

let liveInput = false;
let resumeAfterInput = false;
let shapes = [];
let showPoints = false;
let status = '';

// two square panels side by side, with a strip of text underneath
const panelSize = WIDTH / 2;

// three.js, drawing in window pixels with y down, like openFrameworks
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(WIDTH, HEIGHT);
renderer.sortObjects = false; // draw in the order things were added
app.prepend(renderer.domElement);
const camera = new THREE.OrthographicCamera(0, WIDTH, 0, HEIGHT, -1, 1);
const stage = new THREE.Scene();

// a filled rectangle
function rect(x, y, w, h, color) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    mesh.position.set(x + w / 2, y + h / 2, 0);
    mesh.scale.set(w, h, 1);
    return mesh;
}

// the beam renders into a panelSize target, from audio upsampled to 192kHz
const scope = new Oscilloscope();
scope.setup(panelSize, panelSize, 192000);
scope.decoderSettings.simplify = 0.75; // px; 0 keeps every sample

// left: the audio as an analog scope draws it. The screen is a 1 x 1 plane,
// +y up, so it's flipped to suit this y-down camera.
scope.screen.position.set(panelSize / 2, panelSize / 2, 0);
scope.screen.scale.set(panelSize, -panelSize, 1);
stage.add(scope.screen);

// right: the vector shapes decoded from it, over a grid
stage.add(rect(panelSize, 0, panelSize, panelSize, 0x0c0c0c));
const grid = [];
for (let i = 1; i < 8; i++) {
    grid.push(new THREE.Vector3(panelSize + i * panelSize / 8, 0, 0), new THREE.Vector3(panelSize + i * panelSize / 8, panelSize, 0));
    grid.push(new THREE.Vector3(panelSize, i * panelSize / 8, 0), new THREE.Vector3(2 * panelSize, i * panelSize / 8, 0));
}
stage.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(grid), new THREE.LineBasicMaterial({ color: 0x1c1c1c })));
const shapeView = new XYShapes();
shapeView.position.x = panelSize;
stage.add(shapeView);

// a different hue per shape, so you can see where the strokes break
const hues = [];
for (let i = 0; i < 255; i++) {
    hues.push(new THREE.Color().setRGB(...Twoscilloscope.hsbToRgb(((i * 37) % 255) / 255, 120 / 255, 1), THREE.SRGBColorSpace));
}

const player = new XYPlayer();
player.setScope(scope);
player.setLoop(true);
player.openAudioOut();
loadFile('data/xyscope.wav');

const input = new XYAudioInput();
input.onAudioIn = (buffer) => {
    if (liveInput) scope.addBuffer(buffer);
};

function loadFile(source) {
    const name = typeof source === 'string' ? source : source.name;
    status = 'loading ' + name;
    player.load(source).then((ok) => {
        if (ok) {
            player.play();
            status = 'playing ' + player.getFilename();
        } else {
            status = 'couldn\'t load ' + name + ' (drop a .wav on the window)';
        }
    });
}

// drop a WAV on the window to play it
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (liveInput) toggleLiveInput();
    loadFile(file);
});

// text over the canvas, like ofDrawBitmapString(): y is the baseline
function label(x, y, color = '#a0a0a0', text = '') {
    const div = document.createElement('div');
    div.className = 'label';
    div.style.left = x + 'px';
    div.style.top = (y - 12) + 'px';
    div.style.color = color;
    div.textContent = text;
    document.getElementById('hud').appendChild(div);
    return div;
}

const y = panelSize + 22;
label(12, y, '#fff', 'beam (Oscilloscope)');
label(panelSize + 12, y, '#fff', 'vector shapes (XYDecoder)');
const sourceLabel = label(12, y + 18);
const loopLabel = label(panelSize + 12, y + 18);
label(12, y + 40, '#a0a0a0', 'space play/pause  </> seek  i line in  s save svg  p points  +/- beam  g glow  h hue  z z-mod');
const statusLabel = label(12, HEIGHT - 10, '#787878');
const fpsLabel = label(panelSize + 12, HEIGHT - 10, '#787878');

function audioNote() {
    if (liveInput || player.isAudioRunning()) return '';
    if (Twoscilloscope.audio.state() === 'suspended') return ' (silently: click or press a key for sound)';
    return ' (no sound card found, playing silently)';
}

const clock = new THREE.Clock();
let fps = 60;

function animate() {
    const seconds = Math.min(clock.getDelta(), 0.25);
    if (seconds > 0) fps += (1 / seconds - fps) * 0.05;

    // The player feeds the scope: on the audio clock once the sound has
    // started, and silently, on the frame clock, until then.
    if (!liveInput) player.update(seconds);

    scope.update();
    scope.render(renderer);

    // turn the latest loop of audio back into vector shapes
    shapes = scope.getShapes(panelSize, panelSize);
    shapeView.setShapes(shapes, (i) => hues[i % hues.length]);
    shapeView.showPoints = showPoints;

    let numPoints = 0;
    for (const shape of shapes) numPoints += shape.size();
    sourceLabel.textContent = liveInput ? 'line in' :
        player.getFilename() + '  ' + (player.getPositionMS() / 1000).toFixed(1) + ' / ' +
        (player.getDurationMS() / 1000).toFixed(1) + 's  ' + player.getNumChannels() + 'ch';
    const period = scope.getDetectedPeriod();
    const loop = period > 0 ? (scope.getSourceSampleRate() / period).toFixed(2) + ' Hz loop' : 'no loop found';
    loopLabel.textContent = loop + ', ' + shapes.length + ' shapes, ' + numPoints + ' points';
    statusLabel.textContent = status + audioNote();
    fpsLabel.textContent = fps.toFixed(0) + ' fps, ' + scope.getDropped() + ' dropped';

    renderer.render(stage, camera);
}

renderer.setAnimationLoop(animate);

function toggleLiveInput() {
    liveInput = !liveInput;
    scope.clear();
    if (liveInput) {
        // the file waits while the input goes through the scope
        resumeAfterInput = player.isPlaying();
        player.stop();
        status = 'opening the line input';
        input.open(2).then((ok) => {
            if (!liveInput) return;
            if (ok) {
                status = 'listening to the line input';
            } else {
                liveInput = false;
                if (resumeAfterInput) player.play();
                status = 'no audio input found';
            }
        });
    } else {
        input.close();
        if (resumeAfterInput) player.play();
        status = 'playing ' + player.getFilename();
    }
}

window.addEventListener('keydown', (e) => {
    const key = e.key;
    if (key === ' ') {
        player.setPaused(player.isPlaying());
        e.preventDefault(); // don't scroll the page
    } else if (key === 'ArrowLeft') {
        player.setPositionMS(Math.max(0, player.getPositionMS() - 2000));
    } else if (key === 'ArrowRight') {
        player.setPositionMS(player.getPositionMS() + 2000);
    } else if (key === 'i') {
        toggleLiveInput();
    } else if (key === 's') {
        const file = 'shapes_' + Twoscilloscope.timestamp('%Y%m%d_%H%M%S') + '.svg';
        XYDecoder.saveSvg(file, shapes, panelSize, panelSize);
        status = 'saved ' + file;
    } else if (key === 'p') {
        showPoints = !showPoints;
    } else if (key === '+' || key === '=') {
        scope.strokeWeight = Math.min(20, scope.strokeWeight + 1);
    } else if (key === '-') {
        scope.strokeWeight = Math.max(1, scope.strokeWeight - 1);
    } else if (key === 'g') {
        scope.afterglow = scope.afterglow > 0.85 ? 0 : scope.afterglow + 0.15;
    } else if (key === 'h') {
        scope.hue = scope.hue >= 360 ? 0 : scope.hue + 30;
    } else if (key === 'z') {
        scope.zModulation = !scope.zModulation;
    }
});

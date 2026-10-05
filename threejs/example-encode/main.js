// Example 1: vector shapes -> XYscope format audio.
//
// Shapes drawn into an XYscope come out of the sound card as X (left) and
// Y (right) audio. Plug that into an oscilloscope in X-Y mode, or record it
// and open it in example-decode. The browser starts the sound on the first
// click or key press.
//
// 1-4 scenes, f next font, r record, e export 10s offline, c clear drawing, d debug view

import * as THREE from 'three';
import { HersheyFont, Twoscilloscope, XYPolyline, XYscope, XYscopeHelper } from 'twoscilloscope';

const WIDTH = 1100, HEIGHT = 768;

const sceneNames = ['shapes', 'text', '3D', 'draw'];
const fontNames = ['futural', 'scripts', 'gothiceng', 'timesr', 'rowmand', 'cursive'];
let sceneIndex = 0;
let fontIndex = 0;
let drawing = []; // the mouse drawing, in canvas pixels
let status = '';

// the drawing canvas is the square on the left of the window
const canvasSize = HEIGHT;

// the Hershey fonts, from common/data/hershey_fonts
await HersheyFont.preload(fontNames);

// canvas size, sample rate, buffer size (which is also the wavetable size)
const xy = new XYscope();
xy.setup(canvasSize, canvasSize, 44100, 512);
xy.freq(50); // the whole drawing repeats 50 times a second

// X on the left channel, Y on the right. Pass 3 channels to send Z
// (beam blanking) on the third, if your sound card has one.
xy.openAudioOut();

// three.js, drawing in window pixels with y down, like openFrameworks
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(WIDTH, HEIGHT);
renderer.sortObjects = false; // draw in the order things were added
app.prepend(renderer.domElement);
const camera = new THREE.OrthographicCamera(0, WIDTH, 0, HEIGHT, -1, 1);
const stage = new THREE.Scene();

// the canvas: the vector shapes, faintly, under the signal as a scope shows it
const border = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector2(0.5, 0.5), new THREE.Vector2(canvasSize - 0.5, 0.5),
    new THREE.Vector2(canvasSize - 0.5, canvasSize - 0.5), new THREE.Vector2(0.5, canvasSize - 0.5)
]), new THREE.LineBasicMaterial({ color: 0x1e1e1e }));
const path = new XYscopeHelper(xy, 'path', { opacity: 60 / 255 });
const output = new XYscopeHelper(xy, 'xy');
stage.add(border, path, output);

// the side panel: the audio itself
const panelX = canvasSize + 16;
const panelW = WIDTH - panelX - 16;

// the wavetables: X (blue) on top, Y (red) below
const waveform = new XYscopeHelper(xy, 'waveform');
waveform.position.set(panelX, 104 + 8, 0);
waveform.scale.set(panelW / canvasSize, 200 / canvasSize, 1);

// what's going out of the sound card: left on top, right below
const wave = new XYscopeHelper(xy, 'wave', { color: 0x32ff32 });
wave.position.set(panelX, 334 + 8, 0);
wave.scale.set(panelW / canvasSize, 200 / canvasSize, 1);
stage.add(waveform, wave);

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

label(panelX, 24, '#fff', 'vectors -> audio');
const sceneLabel = label(panelX, 48);
const countLabel = label(panelX, 64);
const freqLabel = label(panelX, 80);
label(panelX, 104, '#fff', 'wavetables');
label(panelX, 334, '#fff', 'audio out (L / R)');
const keysLabel = label(panelX, 570);
const statusLabel = label(panelX, HEIGHT - 30, '#787878');

function drawScene(scope, t) {
    const s = canvasSize;

    switch (sceneIndex) {
        case 0: {
            // Processing-style primitives
            scope.ellipse(s * 0.28, s * 0.28, s * (0.26 + 0.06 * Math.sin(t * 2)));

            scope.rectMode('center');
            scope.pushMatrix();
            scope.translate(s * 0.72, s * 0.28);
            scope.rotate(t * 0.5);
            scope.rect(0, 0, s * 0.26, s * 0.26);
            scope.popMatrix();

            scope.lissajous(s * 0.28, s * 0.72, s * 0.14, 3, 2, t * 40, 120);

            scope.pushMatrix();
            scope.translate(s * 0.72, s * 0.72);
            scope.rotate(-t);
            scope.beginShape();
            for (let i = 0; i < 5; i++) {
                // a star, every second point of a pentagon
                const a = -Math.PI / 2 + i * Math.PI * 2 * 2 / 5;
                scope.vertex(Math.cos(a) * s * 0.15, Math.sin(a) * s * 0.15);
            }
            scope.endShape(true);
            scope.popMatrix();
            break;
        }

        case 1: {
            // Hershey single stroke fonts
            const fontName = fontNames[fontIndex];
            if (scope.getFont().getName() !== fontName) scope.textFont(fontName);

            scope.textAlign('center', 'center');
            scope.textSize(s * 0.13);
            scope.text('XYscope', s / 2, s * 0.32);
            scope.textSize(s * 0.09);
            scope.text(new Date().toTimeString().slice(0, 8), s / 2, s * 0.56);
            scope.textSize(s * 0.04);
            scope.text(fontName, s / 2, s * 0.78);
            break;
        }

        case 2: {
            // 3D, through the default perspective
            scope.translate(s / 2, s / 2);
            scope.rotateY(t * 0.7);
            scope.rotateX(t * 0.4);
            scope.torus(s * 0.2, s * 0.08, 16, 10);
            break;
        }

        case 3: {
            scope.polylines(drawing);
            if (drawing.length === 0) {
                if (scope.getFont().getName() !== 'futural') scope.textFont('futural');
                scope.textAlign('center', 'center');
                scope.textSize(s * 0.05);
                scope.text('draw with the mouse', s / 2, s / 2);
            }
            break;
        }
    }
}

function audioStatus() {
    if (xy.isAudioRunning()) return 'audio out: default device';
    if (xy.isAudioOutOpen() && Twoscilloscope.audio.state() === 'suspended') return 'click or press a key\nto start the audio out';
    return 'no sound card: running silently';
}

const clock = new THREE.Clock();
const mouse = { x: 0, y: 0, down: false };

function animate() {
    // never more than a quarter second at a time, so coming back to a hidden
    // tab doesn't run up a backlog
    const seconds = Math.min(clock.getDelta(), 0.25);

    // No sound yet (the browser waits for a click or a key press), or none at
    // all: keep the oscillators running on the clock, so the previews and the
    // recorder still work.
    if (!xy.isAudioRunning()) xy.process(seconds);

    // build this frame's waves, the way an XYscope sketch does in draw()
    xy.clearWaves();
    drawScene(xy, performance.now() / 1000);
    xy.buildWaves();

    path.update();
    output.update(mouse.x);
    waveform.update(mouse.x);
    wave.update();

    sceneLabel.textContent = 'scene: ' + sceneNames[sceneIndex];
    countLabel.textContent = xy.getShapes().length + ' shapes, ' + xy.wavePoints().length + ' points';
    freqLabel.textContent = xy.freq().x.toFixed(0) + ' Hz loop, ' + xy.waveSize() + ' samples';
    keysLabel.textContent = [
        '1-4   scenes',
        'f     next font',
        'r     record ' + (xy.isRecording() ? '(RECORDING)' : ''),
        'e     export 10s offline',
        'c     clear drawing',
        'd     debug view'
    ].join('\n');
    statusLabel.textContent = status || audioStatus();
    statusLabel.style.color = xy.isRecording() ? '#ff3c3c' : '#787878';

    renderer.render(stage, camera);
}

// at most 60 frames a second, as ofSetFrameRate(60) in the oF example
let lastTime = performance.now(), behind = 0;
renderer.setAnimationLoop(() => {
    const now = performance.now();
    behind = Math.min(behind + now - lastTime, 1000 / 60);
    lastTime = now;
    if (behind < 1000 / 60 - 2) return;
    behind -= 1000 / 60;
    animate();
});

function exportAnimation(seconds) {
    // A second XYscope with no sound card renders the animation offline,
    // frame by frame, without disturbing the live output.
    const exporter = new XYscope();
    exporter.setup(canvasSize, canvasSize, xy.sampleRate(), xy.bufferSize());
    exporter.freq(xy.freq().x);
    exporter.recorderBegin('export');

    const frames = Math.floor(seconds * 60);
    for (let f = 0; f < frames; f++) {
        exporter.clearWaves();
        drawScene(exporter, f / 60);
        exporter.buildWaves();
        exporter.process(1 / 60, 3); // X, Y and Z
    }

    const file = exporter.recorderEnd();
    status = 'exported\n' + file;
}

window.addEventListener('keydown', (e) => {
    const key = e.key;
    if (key.length === 1 && '1234'.includes(key)) {
        sceneIndex = Number(key) - 1;
    } else if (key === 'f') {
        fontIndex = (fontIndex + 1) % fontNames.length;
        sceneIndex = 1;
    } else if (key === 'r') {
        if (xy.isRecording()) {
            const file = xy.recorderEnd();
            status = file === '' ? 'nothing recorded' : 'saved\n' + file;
        } else {
            xy.recorderBegin('XYscope');
            status = 'recording...';
        }
    } else if (key === 'e') {
        exportAnimation(10);
    } else if (key === 'c') {
        drawing = [];
    } else if (key === 'd') {
        xy.debugView(!xy.debugView());
    }
});

// the mouse, in canvas pixels
function pointer(e) {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.x = e.clientX - r.left;
    mouse.y = e.clientY - r.top;
    return mouse.x >= 0 && mouse.x < canvasSize && mouse.y >= 0 && mouse.y < canvasSize;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
    if (!pointer(e) || sceneIndex !== 3) return;
    mouse.down = true;
    drawing.push(new XYPolyline().addVertex(mouse.x, mouse.y));
});

window.addEventListener('pointermove', (e) => {
    const inside = pointer(e);
    if (!mouse.down || sceneIndex !== 3 || drawing.length === 0 || !inside) return;
    const line = drawing[drawing.length - 1];
    // skip tiny steps, they only cost points
    if (line.points[line.points.length - 1].distanceTo(new THREE.Vector2(mouse.x, mouse.y)) > 4) line.addVertex(mouse.x, mouse.y);
});

window.addEventListener('pointerup', () => {
    mouse.down = false;
});

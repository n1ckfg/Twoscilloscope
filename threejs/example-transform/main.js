// Example 3: a vector shape -> XY audio -> audio effects -> a new vector shape.
//
// The shape on the left is encoded as XYscope audio, run through the effect
// chain in the panel, and decoded back into the shape on the right. The
// altered audio also loops out of the sound card (and through the beam in
// the middle), so what you hear is what you see. The browser starts the
// sound on the first click or key press.
//
// 1-4 source (4: draw in panel 1), e solo next effect, n no effects,
// a apply (feed the result back in), c clear drawing, s save svg, w save wav

import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import {
    HersheyFont, Oscilloscope, Twoscilloscope, WavFile, XYBitCrush, XYChannelDelay, XYDecoder, XYDrive, XYEcho,
    XYGui, XYHighPass, XYLowPass, XYNoise, XYPolyline, XYRingMod, XYRotate, XYSampleHold, XYscope, XYShapes,
    XYTransformer, XYWavefold, fillGeometry
} from 'twoscilloscope';

const WIDTH = 1280, HEIGHT = 760;

const sourceNames = ['shapes', 'text', 'spiral', 'drawing'];
let sourceIndex = 0;
let generation = 0;
let drawing = []; // the mouse drawing, in canvas pixels
let source = [];
let result = [];
let soloIndex = -1;
let status = '';

const canvasSize = 512; // the shapes live on a canvasSize square
const panelSize = 320;  // and are drawn at panelSize
const panel1 = { x: 250, y: 40 };
const panel2 = { x: panel1.x + panelSize + 25, y: 40 };
const panel3 = { x: panel2.x + panelSize + 25, y: 40 };

await HersheyFont.preload('timesr');

// shapes on a 512 x 512 canvas, encoded at 44.1kHz as a 50Hz loop
const transformer = new XYTransformer();
transformer.setup(canvasSize, canvasSize, 44100, 50);

// the effect chain, in order; every setting shows up in the panel
const effects = transformer.effects;
effects.add(new XYLowPass()).cutoff = 1500;
effects.add(new XYChannelDelay()).delayY = 0.6;
effects.add(new XYHighPass());
effects.add(new XYEcho());
effects.add(new XYRingMod());
effects.add(new XYRotate());
effects.add(new XYDrive());
effects.add(new XYWavefold());
effects.add(new XYBitCrush());
effects.add(new XYSampleHold());
effects.add(new XYNoise());
for (let i = 2; i < effects.size(); i++) {
    effects.get(i).enabled = false;
}

const app = document.getElementById('app');
const gui = new XYGui(new GUI({ container: app, title: 'effects', width: 230 }), effects.parameters);
for (const effect of effects.effects) {
    if (!effect.enabled) gui.getGroup(effect.getName()).close();
}

// the altered loop plays back through an XYscope, and into the beam
const player = new XYscope();
player.setup(canvasSize, canvasSize, 44100, 512);
player.freq(transformer.getFreq());
const scope = new Oscilloscope();
scope.setup(panelSize, panelSize);

// make X, Y and Z, show all three, send X and Y
player.onAudioOut = (buffer) => scope.addBuffer(buffer);
player.openAudioOut(3, 2);

// three.js, drawing in window pixels with y down, like openFrameworks
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(WIDTH, HEIGHT);
renderer.sortObjects = false; // draw in the order things were added
renderer.autoClear = false;
app.prepend(renderer.domElement);
const camera = new THREE.OrthographicCamera(0, WIDTH, 0, HEIGHT, -1, 1);
const stage = new THREE.Scene();
const clipped = new THREE.Scene(); // what's drawn in panel 3, which effects can push off it

// a filled rectangle
function rect(x, y, w, h, color) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    mesh.position.set(x + w / 2, y + h / 2, 0);
    mesh.scale.set(w, h, 1);
    return mesh;
}

// shapes on the canvas, drawn into a panel
function shapesIn(panel, options) {
    const shapes = new XYShapes(options);
    shapes.position.set(panel.x, panel.y, 0);
    shapes.scale.setScalar(panelSize / canvasSize);
    return shapes;
}

// 1. the source shape
stage.add(rect(panel1.x, panel1.y, panelSize, panelSize, 0x0e0e0e));
const sourceView = shapesIn(panel1);
stage.add(sourceView);

// 2. the altered audio, as a beam. The screen is a 1 x 1 plane, +y up, so
// it's flipped to suit this y-down camera.
scope.screen.position.set(panel2.x + panelSize / 2, panel2.y + panelSize / 2, 0);
scope.screen.scale.set(panelSize, -panelSize, 1);
stage.add(scope.screen);

// 3. the altered audio decoded, over a ghost of the source
stage.add(rect(panel3.x, panel3.y, panelSize, panelSize, 0x0e0e0e));
const ghostView = shapesIn(panel3);
const resultView = shapesIn(panel3);
resultView.showPoints = true;
clipped.add(ghostView, resultView);

// the audio: one loop before (grey) and after (green) the effects
const waveY = panel1.y + panelSize + 40;
const waveW = panel3.x + panelSize - panel1.x;
stage.add(rect(panel1.x, waveY, waveW, 200, 0x0e0e0e));
function waveLines(color) {
    const material = new THREE.LineBasicMaterial({ color, transparent: true });
    const lines = [new THREE.Line(new THREE.BufferGeometry(), material), new THREE.Line(new THREE.BufferGeometry(), material)];
    stage.add(...lines);
    return lines;
}
const encodedLines = waveLines(0x6e6e6e);
const processedLines = waveLines(0x3cff78);

// one loop of X (top) and Y (bottom)
function drawWave(lines, audio, x, y, w, h) {
    const nCh = audio.numChannels;
    const n = audio.numFrames;
    lines.forEach((line, c) => {
        line.visible = nCh >= 2 && n >= 2;
        if (!line.visible) return;
        fillGeometry(line, n, (pos) => {
            for (let i = 0; i < n; i++) {
                pos[i * 3] = x + w * i / (n - 1);
                pos[i * 3 + 1] = y + h * (0.25 + 0.5 * c) - h * 0.22 * audio.samples[i * nCh + c];
                pos[i * 3 + 2] = 0;
            }
        });
    });
}

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

const title1 = label(panel1.x, panel1.y - 10, '#dcdcdc');
label(panel2.x, panel2.y - 10, '#dcdcdc', '2. as XY audio, through the effects');
label(panel3.x, panel3.y - 10, '#dcdcdc', '3. decoded vector shape');
label(panel1.x, waveY - 10, '#dcdcdc', 'one loop of X (top) and Y (bottom): encoded (grey), after the effects (green)');
const infoY = waveY + 230;
const infoLabel = label(panel1.x, infoY);
label(panel1.x, infoY + 22, '#a0a0a0', '1-4 source (4: draw in panel 1)   e solo next effect   n no effects   a apply (feed the result back in)\n' +
    'c clear drawing   s save svg   w save wav');
const statusLabel = label(panel1.x, HEIGHT - 12, '#787878');

const hues = [];
for (let i = 0; i < 255; i++) {
    hues.push(new THREE.Color().setRGB(...Twoscilloscope.hsbToRgb(((i * 37) % 255) / 255, 120 / 255, 1), THREE.SRGBColorSpace));
}

function makeSource() {
    source = [];
    generation = 0;
    const s = canvasSize;

    switch (sourceIndex) {
        case 0: {
            const circle = new XYPolyline();
            for (let i = 0; i < 60; i++) {
                const a = Math.PI * 2 * i / 60;
                circle.addVertex(s * 0.3 + Math.cos(a) * s * 0.17, s * 0.3 + Math.sin(a) * s * 0.17);
            }
            circle.setClosed(true);
            source.push(circle);

            const square = new XYPolyline();
            square.addVertex(s * 0.56, s * 0.14);
            square.addVertex(s * 0.88, s * 0.14);
            square.addVertex(s * 0.88, s * 0.46);
            square.addVertex(s * 0.56, s * 0.46);
            square.setClosed(true);
            source.push(square);

            const star = new XYPolyline();
            for (let i = 0; i < 5; i++) {
                const a = -Math.PI / 2 + i * Math.PI * 2 * 2 / 5;
                star.addVertex(s * 0.5 + Math.cos(a) * s * 0.2, s * 0.72 + Math.sin(a) * s * 0.2);
            }
            star.setClosed(true);
            source.push(star);
            break;
        }
        case 1: {
            const font = new HersheyFont();
            font.load('timesr');
            source = font.getStrokes('three', s / 2, s * 0.42, s * 0.2, s * 0.3, 'center', 'center');
            font.load('futural');
            const small = font.getStrokes('vector > audio > vector', s / 2, s * 0.75, s * 0.05, s * 0.08, 'center', 'center');
            source = source.concat(small);
            break;
        }
        case 2: {
            const spiral = new XYPolyline();
            for (let i = 0; i <= 400; i++) {
                const t = i / 400;
                const a = t * Math.PI * 2 * 5;
                spiral.addVertex(s / 2 + Math.cos(a) * t * s * 0.42, s / 2 + Math.sin(a) * t * s * 0.42);
            }
            source.push(spiral);
            break;
        }
        case 3:
            source = drawing.slice();
            break;
    }
}

function soloEffect(index) {
    // turn on one effect at a time, to see what each one does
    soloIndex = index;
    for (let i = 0; i < effects.size(); i++) {
        const effect = effects.get(i);
        effect.enabled = i === index;
        if (effect.enabled) gui.getGroup(effect.getName()).open();
        else gui.getGroup(effect.getName()).close();
    }
}

function audioStatus() {
    if (player.isAudioRunning()) return 'the altered shape is playing on the default audio out';
    if (player.isAudioOutOpen() && Twoscilloscope.audio.state() === 'suspended') return 'click or press a key to hear the altered shape';
    return 'no sound card found, running silently';
}

makeSource();
const clock = new THREE.Clock();

function animate() {
    const seconds = Math.min(clock.getDelta(), 0.25);

    // the whole round trip, every frame: shape -> audio -> effects -> shape
    result = transformer.transform(source);

    // loop the altered audio, Z (blanking) included
    const waves = transformer.getProcessedWaves();
    player.setWaveforms(waves.x, waves.y, waves.z);

    // no sound yet: run the playback on the clock instead (onAudioOut feeds the scope)
    if (!player.isAudioRunning()) player.process(seconds, 3);
    scope.update();
    scope.render(renderer);

    sourceView.setShapes(source, 0xffffff);
    ghostView.setShapes(source, 0x373737);
    resultView.setShapes(result, (i) => hues[i % hues.length]);

    const processedCycle = transformer.getProcessedCycle();
    const encoded = transformer.getEncodedAudio();
    const m = Math.min(processedCycle.numFrames, encoded.numFrames);
    const encodedCycle = encoded.copy();
    encodedCycle.samples = encoded.samples.slice((encoded.numFrames - m) * encoded.numChannels);
    drawWave(encodedLines, encodedCycle, panel1.x, waveY, waveW, 200);
    drawWave(processedLines, processedCycle, panel1.x, waveY, waveW, 200);

    let sourcePoints = 0, resultPoints = 0;
    for (const p of source) sourcePoints += XYPolyline.from(p).size();
    for (const p of result) resultPoints += p.size();
    title1.textContent = '1. vector shape' + (generation > 0 ? ' (generation ' + generation + ')' : '');
    infoLabel.textContent = 'source: ' + sourceNames[sourceIndex] + ', ' + source.length + ' shapes, ' + sourcePoints +
        ' points   ->   result: ' + result.length + ' shapes, ' + resultPoints + ' points';
    statusLabel.textContent = status || audioStatus();

    renderer.clear();
    renderer.render(stage, camera);
    // panel 3, clipped to the panel
    renderer.setScissor(panel3.x, HEIGHT - panel3.y - panelSize, panelSize, panelSize);
    renderer.setScissorTest(true);
    renderer.render(clipped, camera);
    renderer.setScissorTest(false);
}

// at most 60 frames a second, as ofSetFrameRate(60): the beam's afterglow
// fades once a frame, so its brightness depends on the frame rate
let lastTime = performance.now(), behind = 0;
renderer.setAnimationLoop(() => {
    const now = performance.now();
    behind = Math.min(behind + now - lastTime, 1000 / 60);
    lastTime = now;
    if (behind < 1000 / 60 - 2) return;
    behind -= 1000 / 60;
    animate();
});

// Keys work wherever the focus is: lil-gui stops keys from leaving its panel,
// so listen before it does (capture), but leave its text fields their keys.
window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const key = e.key;
    if (key.length === 1 && '1234'.includes(key)) {
        sourceIndex = Number(key) - 1;
        makeSource();
    } else if (key === 'e') {
        soloEffect((soloIndex + 1) % effects.size());
        status = 'solo: ' + effects.get(soloIndex).getName();
    } else if (key === 'n') {
        soloEffect(-1);
        status = 'no effects: the round trip on its own';
    } else if (key === 'a') {
        // feed the altered shape back in, and alter it again
        source = result;
        generation++;
        status = 'generation ' + generation;
    } else if (key === 'c') {
        drawing = [];
        if (sourceIndex === 3) makeSource();
    } else if (key === 's') {
        const file = 'transformed_' + Twoscilloscope.timestamp('%Y%m%d_%H%M%S') + '.svg';
        XYDecoder.saveSvg(file, result, canvasSize, canvasSize);
        status = 'saved ' + file;
    } else if (key === 'w') {
        // four seconds of the altered loop, X Y Z
        const file = 'transformed_' + Twoscilloscope.timestamp('%Y%m%d_%H%M%S') + '.wav';
        WavFile.save(file, player.render(4, 3));
        status = 'saved ' + file;
    }
}, true);

// the mouse, on the canvas the shapes live on
function toCanvas(e) {
    const r = renderer.domElement.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const inside = x >= panel1.x && x <= panel1.x + panelSize && y >= panel1.y && y <= panel1.y + panelSize;
    return { x: (x - panel1.x) * (canvasSize / panelSize), y: (y - panel1.y) * (canvasSize / panelSize), inside };
}

let mouseDown = false;

renderer.domElement.addEventListener('pointerdown', (e) => {
    const p = toCanvas(e);
    if (!p.inside) return;
    mouseDown = true;
    if (sourceIndex !== 3) {
        sourceIndex = 3;
        drawing = [];
    }
    drawing.push(new XYPolyline().addVertex(p.x, p.y));
    makeSource();
});

window.addEventListener('pointermove', (e) => {
    if (!mouseDown || sourceIndex !== 3 || drawing.length === 0) return;
    const p = toCanvas(e);
    if (!p.inside) return;
    const line = drawing[drawing.length - 1];
    if (line.points[line.points.length - 1].distanceTo(new THREE.Vector2(p.x, p.y)) > 4) {
        line.addVertex(p.x, p.y);
        makeSource();
    }
});

window.addEventListener('pointerup', () => {
    mouseDown = false;
});

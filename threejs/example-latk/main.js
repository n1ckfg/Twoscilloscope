// Example 4: a 3D Latk animation -> XY audio -> audio effects -> strokes.
//
// Each frame of a Latk drawing (from the Lightning Artist Toolkit) is seen
// through the camera, encoded as one loop of XYscope audio, run through the
// effect chain in the panel, and drawn back from the altered audio, as the
// oscilloscope beam or decoded into strokes, each in its stroke's colour.
// The altered loop also plays out of the sound card (after the first click or
// key press), so what you hear is what you see. Drag to orbit, scroll to
// zoom, right-drag to pan, double-click to reset.
//
// Reads .latk files with latk.js (common/js/libraries/latk.js), loaded with
// a script tag in index.html.
//
// l view, e solo next effect, n no effects, m mute, g panel,
// s save svg, w save wav, o save latk

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import {
    Twoscilloscope, WavFile, XYBitCrush, XYChannelDelay, XYDecoder, XYDrive, XYEcho, XYGui, XYHighPass, XYLowPass,
    XYNoise, XYRingMod, XYRotate, XYSampleHold, XYscope, XYWavefold, fillGeometry
} from 'twoscilloscope';
import { LatkScopeRenderer } from './LatkScopeRenderer.js';

const WIDTH = 1024, HEIGHT = 768;

const BEAMS = 0, STROKES = 1, LINES = 2;
const viewNames = ['beams', 'decoded strokes', 'original lines'];
let view = BEAMS;
let soloIndex = -1;
let showGui = true;
let framed = false;
let status = '';

// latk.js looks for a global called latk while it reads the file, so it goes on window
const latk = window.latk = Latk.read('data/jellyfish.latk');

// Latk's playback clock, as ofxLatk keeps it: 12 frames a second
const latkFps = 12;
let timeInterval = 0;
let lastMillis = 0;

const scope = new LatkScopeRenderer(44100);

// The effect chain from example-transform, in order.
// Every setting shows up in the panel.
const effects = scope.transformer.effects;
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
gui.add(scope.parameters);
for (const effect of effects.effects) {
    if (!effect.enabled) gui.getGroup(effect.getName()).close();
}

// The altered loop plays out of the sound card, X left and Y right, so
// what you hear is what you see.
const player = new XYscope();
player.setup(WIDTH, HEIGHT, 44100, 512);
player.openAudioOut();

// three.js: the drawing in 3D, through a camera you can orbit (in place of
// ofEasyCam), and the beams and strokes in window pixels over it
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(WIDTH, HEIGHT);
app.prepend(renderer.domElement);

const camera = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 0.01, 100);
camera.position.set(0, 0, 2);
const controls = new OrbitControls(camera, renderer.domElement);
renderer.domElement.addEventListener('dblclick', () => controls.reset());

const world = new THREE.Scene();
const lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
world.add(lines);

const overlay = new THREE.Scene();
const pixels = new THREE.OrthographicCamera(0, WIDTH, 0, HEIGHT, -1, 1);
overlay.add(scope.beams, scope.strokes);

// text over the canvas, like ofDrawBitmapStringHighlight(): y is the baseline
function label(x, y) {
    const div = document.createElement('div');
    div.className = 'label highlight';
    div.style.left = x + 'px';
    div.style.top = (y - 14) + 'px';
    document.getElementById('hud').appendChild(div);
    return div;
}

const infoLabel = label(10, HEIGHT - 50);
const keysLabel = label(10, HEIGHT - 30);
keysLabel.textContent = 'l view   e solo next effect   n no effects   m mute   g panel   s save svg   w save wav   o save latk';
const statusLabel = label(10, HEIGHT - 10);

// ofxLatk's Latk::checkInterval(): true when it's time for the next frame
function checkInterval() {
    let returns = false;
    timeInterval += performance.now() - lastMillis;
    if (timeInterval > Math.floor(1000 / latkFps)) {
        returns = true;
        timeInterval = 0;
    }
    return returns;
}

// latk.js keeps each layer's current frame in counter
function nextFrame(layer) {
    layer.counter++;
    if (layer.counter > layer.frames.length - 1) layer.counter = 0;
}

// The camera starts out looking at the whole drawing, every frame of it,
// from the front, with Y up as Latk has it.
function frameDrawing() {
    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    for (const layer of latk.layers) {
        for (const frame of layer.frames) {
            for (const stroke of frame.strokes) {
                for (const p of stroke.points) box.expandByPoint(point.fromArray(p.co));
            }
        }
    }
    framed = true;
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const distance = sphere.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).add(new THREE.Vector3(0, Math.sin(0.15), Math.cos(0.15)).multiplyScalar(distance));
    camera.near = distance * 0.01;
    camera.far = distance + sphere.radius * 10;
    camera.updateProjectionMatrix();
    controls.update();
    controls.saveState();
}

// The current frame of each layer, as Latk draws it.
function updateLines() {
    const strokes = [];
    let count = 0;
    for (const layer of latk.layers) {
        const frame = layer.frames[layer.counter];
        if (!frame) continue;
        for (const stroke of frame.strokes) {
            if (stroke.points.length < 2) continue;
            strokes.push(stroke);
            count += 2 * (stroke.points.length - 1);
        }
    }
    const color = new THREE.Color();
    fillGeometry(lines, count, (pos, col) => {
        let k = 0;
        for (const stroke of strokes) {
            color.setRGB(stroke.color[0], stroke.color[1], stroke.color[2], THREE.SRGBColorSpace);
            for (let i = 1; i < stroke.points.length; i++) {
                for (const p of [stroke.points[i - 1], stroke.points[i]]) {
                    pos[k] = p.co[0]; pos[k + 1] = p.co[1]; pos[k + 2] = p.co[2];
                    col[k] = color.r; col[k + 1] = color.g; col[k + 2] = color.b;
                    k += 3;
                }
            }
        }
    }, true);
}

function audioStatus() {
    if (player.isAudioRunning()) return 'the altered strokes are playing on the default audio out';
    if (player.isAudioOutOpen() && Twoscilloscope.audio.state() === 'suspended') return 'click or press a key to hear the altered strokes';
    return 'no sound card found, running silently';
}

let fps = 60;
let lastFrame = performance.now();

function update() {
    if (!latk.ready) return;
    if (!framed) frameDrawing();

    // Latk's run() advances and draws. Only advance here; animate() does the drawing.
    if (checkInterval()) {
        for (const layer of latk.layers) nextFrame(layer);
    }
    lastMillis = performance.now();

    // The whole round trip, every frame: strokes -> audio -> effects -> strokes.
    scope.update(latk, camera, WIDTH, HEIGHT);

    // loop the altered audio, Z (blanking) included
    player.freq(scope.getFreq());
    player.setWaveforms(scope.x, scope.y, scope.z);
}

function animate() {
    const now = performance.now();
    fps += (1000 / Math.max(1, now - lastFrame) - fps) * 0.05;
    lastFrame = now;

    update();

    if (!latk.ready) {
        statusLabel.textContent = 'loading data/jellyfish.latk';
        renderer.render(overlay, pixels);
        return;
    }

    scope.beams.visible = view === BEAMS;
    scope.strokes.visible = view === STROKES;
    if (view === BEAMS) scope.buildBeams();
    if (view === STROKES) scope.buildStrokes();
    if (view === LINES) {
        updateLines();
        renderer.render(world, camera);
    } else {
        renderer.render(overlay, pixels);
    }

    const stats = scope.stats;
    let info = fps.toFixed(0) + ' fps | ' + viewNames[view] + ' | loop ' + scope.getFreq().toFixed(1) + ' Hz: ' +
        stats.samples + ' samples for ' + Math.round(stats.pathLength) + ' px of ' + stats.pieces + ' strokes';
    if (stats.dropped > 0) info += ' (' + stats.dropped + ' too short to fit)';
    info += ' | ' + stats.ms.toFixed(1) + ' ms';
    infoLabel.textContent = info;
    statusLabel.textContent = status || audioStatus();
}

// at most 60 frames a second, as the oF example
let lastTime = performance.now(), behind = 0;
renderer.setAnimationLoop(() => {
    const now = performance.now();
    behind = Math.min(behind + now - lastTime, 1000 / 60);
    lastTime = now;
    if (behind < 1000 / 60 - 2) return;
    behind -= 1000 / 60;
    animate();
});

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

// The whole drawing, every layer and frame, as a .latk download: a zip of the
// JSON, which latk.js reads (it brings JSZip along).
function saveLatk(filename) {
    const json = {
        creator: 'three.js',
        grease_pencil: [{
            layers: latk.layers.map((layer, i) => ({
                name: layer.name || 'layer ' + (i + 1),
                frames: layer.frames.map((frame) => ({
                    strokes: frame.strokes.map((s) => ({
                        color: [s.color[0], s.color[1], s.color[2]],
                        points: s.points.map((p) => ({ co: [p.co[0], p.co[1], p.co[2]], pressure: p.pressure, strength: p.strength }))
                    }))
                }))
            }))
        }]
    };
    const zip = new JSZip();
    zip.file(filename.replace(/\.latk$/, '') + '.json', JSON.stringify(json));
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }).then((blob) => Twoscilloscope.saveBlob(blob, filename));
}

window.addEventListener('keydown', (e) => {
    const key = e.key;
    if (key === 'l') {
        view = (view + 1) % 3;
    } else if (key === 'e') {
        soloEffect((soloIndex + 1) % effects.size());
        status = 'solo: ' + effects.get(soloIndex).getName();
    } else if (key === 'n') {
        soloEffect(-1);
        status = 'no effects: the round trip on its own';
    } else if (key === 'm') {
        if (player.isAudioOutOpen()) {
            player.closeAudioOut();
            status = 'muted';
        } else {
            player.openAudioOut().then((ok) => {
                status = ok ? 'playing on the default audio out' : 'no sound card found, running silently';
            });
        }
    } else if (key === 'g') {
        showGui = !showGui;
        gui.gui.show(showGui);
    } else if (key === 's') {
        const file = 'transformed_' + Twoscilloscope.timestamp('%Y%m%d_%H%M%S') + '.svg';
        XYDecoder.saveSvg(file, scope.getStrokes(), WIDTH, HEIGHT);
        status = 'saved ' + file;
    } else if (key === 'w') {
        // four seconds of the altered loop, X Y Z
        const file = 'transformed_' + Twoscilloscope.timestamp('%Y%m%d_%H%M%S') + '.wav';
        WavFile.save(file, player.render(4, 3));
        status = 'saved ' + file;
    } else if (key === 'o') {
        if (!latk.ready) return;
        status = 'saving test.latk';
        saveLatk('test.latk').then(() => {
            status = 'saved test.latk';
        });
    }
});

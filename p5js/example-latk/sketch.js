// Example 4: a 3D Latk animation -> XY audio -> audio effects -> strokes.
//
// Each frame of a Latk drawing (from the Lightning Artist Toolkit) is seen
// through the camera, encoded as one loop of XYscope audio, run through the
// effect chain in the panel, and drawn back from the altered audio, as the
// oscilloscope beam or decoded into strokes, each in its stroke's colour.
// The altered loop also plays out of the sound card (after the first click or
// key press), so what you hear is what you see. Drag to orbit, scroll to
// zoom, double-click to reset.
//
// Reads .latk files with latk.js (common/js/libraries/latk.js).
//
// l view, e solo next effect, n no effects, m mute, g panel,
// s save svg, w save wav, o save latk

// latk.js looks for a global called latk while it reads the file, so keep this name
let latk;
let cam;
let scope;  // LatkScopeRenderer
let player; // loops the altered audio out of the sound card
let gui;

const BEAMS = 0, STROKES = 1, LINES = 2;
const viewNames = ['beams', 'decoded strokes', 'original lines'];
let view = BEAMS;
let soloIndex = -1;
let showGui = true;
let framed = false;
let status = '';

// Latk's playback clock, as ofxLatk keeps it: 12 frames a second
const latkFps = 12;
let timeInterval = 0;
let lastMillis = 0;

function setup() {
    createCanvas(1024, 768);
    frameRate(60);
    textFont('monospace');
    textSize(13);

    latk = Latk.read('data/jellyfish.latk');
    cam = new OrbitCamera();

    scope = new LatkScopeRenderer(44100);

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

    gui = new XYPanel(effects.parameters, 10, 10);
    gui.add(scope.parameters);
    for (const effect of effects.effects) {
        if (!effect.enabled) gui.getGroup(effect.getName()).minimize();
    }

    // The altered loop plays out of the sound card, X left and Y right, so
    // what you hear is what you see.
    player = new XYscope();
    player.setup(0, 0, 44100, 512);
    player.openAudioOut();
}

// ofxLatk's Latk::checkInterval(): true when it's time for the next frame
function checkInterval() {
    let returns = false;
    timeInterval += millis() - lastMillis;
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

// the camera starts out looking at the whole drawing, every frame of it
function frameDrawing() {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const layer of latk.layers) {
        for (const frame of layer.frames) {
            for (const stroke of frame.strokes) {
                for (const p of stroke.points) {
                    for (let i = 0; i < 3; i++) {
                        min[i] = Math.min(min[i], p.co[i]);
                        max[i] = Math.max(max[i], p.co[i]);
                    }
                }
            }
        }
    }
    if (min[0] <= max[0]) cam.fit(min, max);
    framed = true;
}

function update() {
    if (!latk.ready) return;
    if (!framed) frameDrawing();

    // Latk's run() advances and draws. Only advance here; draw() does the drawing.
    if (checkInterval()) {
        for (const layer of latk.layers) nextFrame(layer);
    }
    lastMillis = millis();

    // The whole round trip, every frame: strokes -> audio -> effects -> strokes.
    scope.update(latk, cam, width, height);

    // loop the altered audio, Z (blanking) included
    player.freq(scope.getFreq());
    player.setWaveforms(scope.x, scope.y, scope.z);
}

function draw() {
    update();
    background(0);

    if (!latk.ready) {
        noStroke();
        fill(160);
        text('loading data/jellyfish.latk', 10, height - 10);
        return;
    }

    switch (view) {
        case BEAMS:
            scope.drawBeams();
            break;
        case STROKES:
            scope.drawStrokes();
            break;
        case LINES:
            drawLines();
            break;
    }

    const stats = scope.stats;
    let info = frameRate().toFixed(0) + ' fps | ' + viewNames[view] + ' | loop ' + scope.getFreq().toFixed(1) + ' Hz: ' +
        stats.samples + ' samples for ' + Math.round(stats.pathLength) + ' px of ' + stats.pieces + ' strokes';
    if (stats.dropped > 0) info += ' (' + stats.dropped + ' too short to fit)';
    info += ' | ' + stats.ms.toFixed(1) + ' ms';
    highlight(info, 10, height - 50);
    highlight('l view   e solo next effect   n no effects   m mute   g panel   s save svg   w save wav   o save latk', 10, height - 30);
    highlight(status || audioStatus(), 10, height - 10);
}

// The current frame of each layer through the camera, as Latk draws it.
function drawLines() {
    const mvp = cam.getModelViewProjectionMatrix(width, height);
    push();
    noFill();
    strokeWeight(2);
    for (const layer of latk.layers) {
        const frame = layer.frames[layer.counter];
        if (!frame) continue;
        for (const s of frame.strokes) {
            stroke(255 * s.color[0], 255 * s.color[1], 255 * s.color[2]);
            let open = false;
            for (const p of s.points) {
                const screen = OrbitCamera.project(mvp, p.co[0], p.co[1], p.co[2], width, height);
                if (!screen.valid) {
                    // behind the camera: break the line here
                    if (open) endShape();
                    open = false;
                    continue;
                }
                if (!open) beginShape();
                open = true;
                vertex(screen.x, screen.y);
            }
            if (open) endShape();
        }
    }
    pop();
}

// white text on a black box, like ofDrawBitmapStringHighlight()
function highlight(s, x, y) {
    noStroke();
    fill(0);
    rect(x - 4, y - textAscent() - 4, textWidth(s) + 8, textAscent() + textDescent() + 8);
    fill(255);
    text(s, x, y);
}

function audioStatus() {
    if (player.isAudioRunning()) return 'the altered strokes are playing on the default audio out';
    if (player.isAudioOutOpen() && Twoscilloscope.audio.state() === 'suspended') return 'click or press a key to hear the altered strokes';
    return 'no sound card found, running silently';
}

function soloEffect(index) {
    // turn on one effect at a time, to see what each one does
    soloIndex = index;
    const effects = scope.transformer.effects;
    for (let i = 0; i < effects.size(); i++) {
        const effect = effects.get(i);
        effect.enabled = i === index;
        if (effect.enabled) gui.getGroup(effect.getName()).maximize();
        else gui.getGroup(effect.getName()).minimize();
    }
}

// The whole drawing, every layer and frame, as a .latk download: a zip of the
// JSON, which latk.js reads (it brings JSZip along).
function saveLatk(filename) {
    const json = {
        creator: 'p5.js',
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

function keyPressed() {
    if (key === 'l') {
        view = (view + 1) % 3;
    } else if (key === 'e') {
        soloEffect((soloIndex + 1) % scope.transformer.effects.size());
        status = 'solo: ' + scope.transformer.effects.get(soloIndex).getName();
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
        if (showGui) gui.show();
        else gui.hide();
    } else if (key === 's') {
        const path = 'transformed_' + Twoscilloscope.timestamp('%Y%m%d_%H%M%S') + '.svg';
        XYDecoder.saveSvg(path, scope.getStrokes(), width, height);
        status = 'saved ' + path;
    } else if (key === 'w') {
        // four seconds of the altered loop, X Y Z
        const path = 'transformed_' + Twoscilloscope.timestamp('%Y%m%d_%H%M%S') + '.wav';
        WavFile.save(path, player.render(4, 3));
        status = 'saved ' + path;
    } else if (key === 'o') {
        if (!latk.ready) return;
        status = 'saving test.latk';
        saveLatk('test.latk').then(() => {
            status = 'saved test.latk';
        });
    }
}

// Dragging a slider shouldn't orbit the camera, so the camera ignores the
// mouse over the panel, and outside the canvas.
function overGui() {
    return showGui && gui.contains(mouseX, mouseY);
}

function onCanvas() {
    return mouseX >= 0 && mouseX < width && mouseY >= 0 && mouseY < height;
}

function mousePressed() {
    if (onCanvas() && !overGui()) cam.mousePressed(mouseX, mouseY);
}

function mouseDragged() {
    cam.mouseDragged(mouseX, mouseY);
}

function mouseReleased() {
    cam.mouseReleased();
}

function doubleClicked() {
    if (onCanvas() && !overGui()) cam.reset();
}

function mouseWheel(event) {
    if (!onCanvas() || overGui()) return;
    cam.zoom(event.delta);
    return false; // don't scroll the page
}

// Example 1: vector shapes -> XYscope format audio.
//
// Shapes drawn into an XYscope come out of the sound card as X (left) and
// Y (right) audio. Plug that into an oscilloscope in X-Y mode, or record it
// and open it in example-decode. The browser starts the sound on the first
// click or key press.
//
// 1-4 scenes, f next font, r record, e export 10s offline, c clear drawing, d debug view

let xy;

let scene = 0;
const sceneNames = ['shapes', 'text', '3D', 'draw'];
const fontNames = ['futural', 'scripts', 'gothiceng', 'timesr', 'rowmand', 'cursive'];
let fontIndex = 0;
let drawing = []; // the mouse drawing, in canvas pixels

let canvasSize;
let status = '';

function preload() {
    // the Hershey fonts, from common/data/hershey_fonts
    for (const name of fontNames) loadHersheyFont(name);
}

function setup() {
    createCanvas(1100, 768);
    frameRate(60);
    textFont('monospace');
    textSize(13);

    // the drawing canvas is the square on the left of the window
    canvasSize = height;

    // canvas size, sample rate, buffer size (which is also the wavetable size)
    xy = new XYscope();
    xy.setup(canvasSize, canvasSize, 44100, 512);
    xy.freq(50); // the whole drawing repeats 50 times a second

    // X on the left channel, Y on the right. Pass 3 channels to send Z
    // (beam blanking) on the third, if your sound card has one.
    xy.openAudioOut();
}

function drawScene(scope, t) {
    const s = canvasSize;

    switch (scene) {
        case 0: {
            // Processing-style primitives
            scope.ellipse(s * 0.28, s * 0.28, s * (0.26 + 0.06 * Math.sin(t * 2)));

            scope.rectMode(CENTER);
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
                const a = -HALF_PI + i * TWO_PI * 2 / 5;
                scope.vertex(Math.cos(a) * s * 0.15, Math.sin(a) * s * 0.15);
            }
            scope.endShape(CLOSE);
            scope.popMatrix();
            break;
        }

        case 1: {
            // Hershey single stroke fonts
            const fontName = fontNames[fontIndex];
            if (scope.getFont().getName() !== fontName) scope.textFont(fontName);

            scope.textAlign(CENTER, CENTER);
            scope.textSize(s * 0.13);
            scope.text('XYscope', s / 2, s * 0.32);
            scope.textSize(s * 0.09);
            scope.text(nf(hour(), 2) + ':' + nf(minute(), 2) + ':' + nf(second(), 2), s / 2, s * 0.56);
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
                scope.textAlign(CENTER, CENTER);
                scope.textSize(s * 0.05);
                scope.text('draw with the mouse', s / 2, s / 2);
            }
            break;
        }
    }
}

function draw() {
    // No sound yet (the browser waits for a click or a key press), or none at
    // all: keep the oscillators running on the clock, so the previews and the
    // recorder still work.
    if (!xy.isAudioRunning()) xy.process(frameSeconds());

    background(0);

    // build this frame's waves, the way an XYscope sketch does in draw()
    xy.clearWaves();
    drawScene(xy, millis() / 1000);
    xy.buildWaves();

    // the canvas: the vector shapes, faintly, under the signal as a scope shows it
    noFill();
    stroke(30);
    rect(0.5, 0.5, canvasSize - 1, canvasSize - 1);
    xy.drawPath([255, 255, 255, 60]);
    xy.drawXY();

    // the side panel: the audio itself
    const panelX = canvasSize + 16;
    const panelW = width - panelX - 16;
    let y = 24;
    noStroke();
    fill(255);
    text('vectors -> audio', panelX, y);
    fill(160);
    text('scene: ' + sceneNames[scene], panelX, y += 24);
    text(xy.getShapes().length + ' shapes, ' + xy.wavePoints().length + ' points', panelX, y += 16);
    text(xy.freq().x.toFixed(0) + ' Hz loop, ' + xy.waveSize() + ' samples', panelX, y += 16);

    // the wavetables: X (blue) on top, Y (red) below
    y += 24;
    fill(255);
    text('wavetables', panelX, y);
    drawScaled(panelX, y + 8, panelW / canvasSize, 200 / canvasSize, () => xy.drawWaveform());

    // what's going out of the sound card: left on top, right below
    y += 230;
    noStroke();
    fill(255);
    text('audio out (L / R)', panelX, y);
    drawScaled(panelX, y + 8, panelW / canvasSize, 200 / canvasSize, () => xy.drawWave([50, 255, 50]));

    y += 236;
    noStroke();
    fill(160);
    const keys = [
        '1-4   scenes',
        'f     next font',
        'r     record ' + (xy.isRecording() ? '(RECORDING)' : ''),
        'e     export 10s offline',
        'c     clear drawing',
        'd     debug view'
    ];
    text(keys.join('\n'), panelX, y);

    fill(xy.isRecording() ? color(255, 60, 60) : color(120));
    text(status || audioStatus(), panelX, height - 30);
}

// p5 scales strokes along with everything else, so thin them back to a pixel
function drawScaled(x, y, sx, sy, drawFunction) {
    push();
    translate(x, y);
    scale(sx, sy);
    strokeWeight(1 / Math.min(sx, sy));
    drawFunction();
    pop();
}

function audioStatus() {
    if (xy.isAudioRunning()) return 'audio out: default device';
    if (xy.isAudioOutOpen() && Twoscilloscope.audio.state() === 'suspended') return 'click or press a key\nto start the audio out';
    return 'no sound card: running silently';
}

// this frame's time, but never more than a quarter second, so coming back to
// a hidden tab doesn't run up a backlog
function frameSeconds() {
    return Math.min(deltaTime, 250) / 1000;
}

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

    const path = exporter.recorderEnd();
    status = 'exported\n' + path;
}

function keyPressed() {
    if (key.length === 1 && '1234'.includes(key)) {
        scene = Number(key) - 1;
    } else if (key === 'f') {
        fontIndex = (fontIndex + 1) % fontNames.length;
        scene = 1;
    } else if (key === 'r') {
        if (xy.isRecording()) {
            const path = xy.recorderEnd();
            status = path === '' ? 'nothing recorded' : 'saved\n' + path;
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
}

function onCanvas() {
    return mouseX >= 0 && mouseX < canvasSize && mouseY >= 0 && mouseY < canvasSize;
}

function mousePressed() {
    if (scene !== 3 || !onCanvas()) return;
    drawing.push(new XYPolyline().addVertex(mouseX, mouseY));
}

function mouseDragged() {
    if (scene !== 3 || drawing.length === 0 || !onCanvas()) return;
    const line = drawing[drawing.length - 1];
    const last = line.points[line.points.length - 1];
    // skip tiny steps, they only cost points
    if (dist(last.x, last.y, mouseX, mouseY) > 4) line.addVertex(mouseX, mouseY);
}

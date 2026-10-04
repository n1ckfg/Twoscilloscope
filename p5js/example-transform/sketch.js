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

let transformer; // shape -> audio -> effects -> shape
let player;      // loops the altered audio
let scope;       // shows it as a beam
let gui;

const sourceNames = ['shapes', 'text', 'spiral', 'drawing'];
let sourceIndex = 0;
let generation = 0;
let drawing = []; // the mouse drawing, in canvas pixels
let source = [];
let result = [];
let soloIndex = -1;

let canvasSize; // the shapes live on a canvasSize square
let panelSize;  // and are drawn at panelSize
let panel1, panel2, panel3;
let status = '';

function preload() {
    loadHersheyFont('timesr');
}

function setup() {
    createCanvas(1280, 760);
    frameRate(60);
    textFont('monospace');
    textSize(13);

    canvasSize = 512;
    panelSize = 320;
    panel1 = { x: 250, y: 40 };
    panel2 = { x: panel1.x + panelSize + 25, y: 40 };
    panel3 = { x: panel2.x + panelSize + 25, y: 40 };

    // shapes on a 512 x 512 canvas, encoded at 44.1kHz as a 50Hz loop
    transformer = new XYTransformer();
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

    gui = new XYPanel(effects.parameters, 10, 10);
    for (const effect of effects.effects) {
        if (!effect.enabled) gui.getGroup(effect.getName()).minimize();
    }

    // the altered loop plays back through an XYscope, and into the beam
    player = new XYscope();
    player.setup(canvasSize, canvasSize, 44100, 512);
    player.freq(transformer.getFreq());
    scope = new Oscilloscope();
    scope.setup(panelSize, panelSize);

    // make X, Y and Z, show all three, send X and Y
    player.onAudioOut = (buffer) => scope.addBuffer(buffer);
    player.openAudioOut(3, 2);

    makeSource();
}

function makeSource() {
    source = [];
    generation = 0;
    const s = canvasSize;

    switch (sourceIndex) {
        case 0: {
            const circle = new XYPolyline();
            for (let i = 0; i < 60; i++) {
                const a = TWO_PI * i / 60;
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
                const a = -HALF_PI + i * TWO_PI * 2 / 5;
                star.addVertex(s * 0.5 + Math.cos(a) * s * 0.2, s * 0.72 + Math.sin(a) * s * 0.2);
            }
            star.setClosed(true);
            source.push(star);
            break;
        }
        case 1: {
            const font = new HersheyFont();
            font.load('timesr');
            source = font.getStrokes('p5', s / 2, s * 0.42, s * 0.3, s * 0.4, CENTER, CENTER);
            font.load('futural');
            const small = font.getStrokes('vector > audio > vector', s / 2, s * 0.75, s * 0.05, s * 0.08, CENTER, CENTER);
            source = source.concat(small);
            break;
        }
        case 2: {
            const spiral = new XYPolyline();
            for (let i = 0; i <= 400; i++) {
                const t = i / 400;
                const a = t * TWO_PI * 5;
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
    const effects = transformer.effects;
    for (let i = 0; i < effects.size(); i++) {
        const effect = effects.get(i);
        effect.enabled = i === index;
        if (effect.enabled) gui.getGroup(effect.getName()).maximize();
        else gui.getGroup(effect.getName()).minimize();
    }
}

function update() {
    // the whole round trip, every frame: shape -> audio -> effects -> shape
    result = transformer.transform(source);

    // loop the altered audio, Z (blanking) included
    const waves = transformer.getProcessedWaves();
    player.setWaveforms(waves.x, waves.y, waves.z);

    // no sound yet: run the playback on the clock instead (onAudioOut feeds the scope)
    if (!player.isAudioRunning()) player.process(frameSeconds(), 3);
    scope.update();
}

function draw() {
    update();
    background(0);

    // 1. the source shape
    drawPanel(panel1.x, panel1.y, '1. vector shape' + (generation > 0 ? ' (generation ' + generation + ')' : ''));
    stroke(255);
    drawShapes(source, panel1.x, panel1.y, false, false);

    // 2. the altered audio, as a beam
    drawPanel(panel2.x, panel2.y, '2. as XY audio, through the effects');
    scope.draw(panel2.x, panel2.y, panelSize, panelSize);

    // 3. the altered audio decoded, over a ghost of the source
    drawPanel(panel3.x, panel3.y, '3. decoded vector shape');
    // effects can push the shape off the canvas, so clip to the panel
    push();
    drawingContext.save();
    drawingContext.beginPath();
    drawingContext.rect(panel3.x, panel3.y, panelSize, panelSize);
    drawingContext.clip();
    stroke(55);
    drawShapes(source, panel3.x, panel3.y, false, false);
    drawShapes(result, panel3.x, panel3.y, true, true);
    drawingContext.restore();
    pop();

    // the audio: one loop before (grey) and after (green) the effects
    const waveY = panel1.y + panelSize + 40;
    const waveW = panel3.x + panelSize - panel1.x;
    noStroke();
    fill(220);
    text('one loop of X (top) and Y (bottom): encoded (grey), after the effects (green)', panel1.x, waveY - 10);
    fill(14);
    rect(panel1.x, waveY, waveW, 200);
    const processedCycle = transformer.getProcessedCycle();
    const encoded = transformer.getEncodedAudio();
    const nCh = encoded.numChannels;
    const m = Math.min(processedCycle.numFrames, encoded.numFrames);
    const encodedCycle = XYSoundBuffer.wrap(encoded.samples.slice((encoded.numFrames - m) * nCh), nCh, encoded.sampleRate);
    drawWave(encodedCycle, panel1.x, waveY, waveW, 200, color(110));
    drawWave(processedCycle, panel1.x, waveY, waveW, 200, color(60, 255, 120));

    // info
    let sourcePoints = 0, resultPoints = 0;
    for (const p of source) sourcePoints += XYPolyline.from(p).size();
    for (const p of result) resultPoints += p.size();
    const infoY = waveY + 230;
    noStroke();
    fill(160);
    text('source: ' + sourceNames[sourceIndex] + ', ' + source.length + ' shapes, ' + sourcePoints + ' points   ->   result: ' +
        result.length + ' shapes, ' + resultPoints + ' points', panel1.x, infoY);
    text('1-4 source (4: draw in panel 1)   e solo next effect   n no effects   a apply (feed the result back in)\n' +
        'c clear drawing   s save svg   w save wav', panel1.x, infoY + 22);
    fill(120);
    text(status || audioStatus(), panel1.x, height - 12);
}

function audioStatus() {
    if (player.isAudioRunning()) return 'the altered shape is playing on the default audio out';
    if (player.isAudioOutOpen() && Twoscilloscope.audio.state() === 'suspended') return 'click or press a key to hear the altered shape';
    return 'no sound card found, running silently';
}

// this frame's time, but never more than a quarter second, so coming back to
// a hidden tab doesn't run up a backlog
function frameSeconds() {
    return Math.min(deltaTime, 250) / 1000;
}

function toCanvas(x, y) {
    return { x: (x - panel1.x) * (canvasSize / panelSize), y: (y - panel1.y) * (canvasSize / panelSize) };
}

function insidePanel1(x, y) {
    return x >= panel1.x && x <= panel1.x + panelSize && y >= panel1.y && y <= panel1.y + panelSize;
}

function drawPanel(x, y, title) {
    noStroke();
    fill(14);
    rect(x, y, panelSize, panelSize);
    fill(220);
    text(title, x, y - 10);
}

function drawShapes(shapes, x, y, colored, points) {
    push();
    translate(x, y);
    scale(panelSize / canvasSize);
    // p5 scales strokes too, so keep them a pixel wide
    strokeWeight(canvasSize / panelSize);
    noFill();
    colorMode(HSB, 255);
    for (let i = 0; i < shapes.length; i++) {
        const shape = XYPolyline.from(shapes[i]);
        if (colored) stroke((i * 37) % 255, 120, 255);
        shape.draw();
        if (points) {
            for (const v of shape.points) circle(v.x, v.y, 3);
        }
    }
    pop();
}

function drawWave(audio, x, y, w, h, c) {
    // one loop of X (top) and Y (bottom)
    const nCh = audio.numChannels;
    const n = audio.numFrames;
    if (nCh < 2 || n < 2) return;
    noFill();
    stroke(c);
    for (let ch = 0; ch < 2; ch++) {
        beginShape();
        for (let i = 0; i < n; i++) {
            vertex(x + w * i / (n - 1), y + h * (0.25 + 0.5 * ch) - h * 0.22 * audio.samples[i * nCh + ch]);
        }
        endShape();
    }
}

function keyPressed() {
    if (key.length === 1 && '1234'.includes(key)) {
        sourceIndex = Number(key) - 1;
        makeSource();
    } else if (key === 'e') {
        soloEffect((soloIndex + 1) % transformer.effects.size());
        status = 'solo: ' + transformer.effects.get(soloIndex).getName();
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
        const path = 'transformed_' + Twoscilloscope.timestamp('%Y%m%d_%H%M%S') + '.svg';
        XYDecoder.saveSvg(path, result, canvasSize, canvasSize);
        status = 'saved ' + path;
    } else if (key === 'w') {
        // four seconds of the altered loop, X Y Z
        const path = 'transformed_' + Twoscilloscope.timestamp('%Y%m%d_%H%M%S') + '.wav';
        WavFile.save(path, player.render(4, 3));
        status = 'saved ' + path;
    }
}

function mousePressed() {
    if (!insidePanel1(mouseX, mouseY)) return;
    if (sourceIndex !== 3) {
        sourceIndex = 3;
        drawing = [];
    }
    drawing.push(new XYPolyline().addVertex(toCanvas(mouseX, mouseY)));
    makeSource();
}

function mouseDragged() {
    if (sourceIndex !== 3 || drawing.length === 0) return;
    if (!insidePanel1(mouseX, mouseY)) return;
    const p = toCanvas(mouseX, mouseY);
    const line = drawing[drawing.length - 1];
    const last = line.points[line.points.length - 1];
    if (dist(last.x, last.y, p.x, p.y) > 4) {
        line.addVertex(p);
        makeSource();
    }
}

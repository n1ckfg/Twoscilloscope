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

let scope;  // renders the beam, and decodes the shapes
let player; // plays the file, to the sound card and to the scope
let input;  // the line input
let liveInput = false;
let resumeAfterInput = false;

let shapes = [];
let panelSize;
let showPoints = false;
let status = '';

function setup() {
    const canvas = createCanvas(1024, 600);
    frameRate(60);
    textFont('monospace');
    textSize(13);

    // two square panels side by side, with a strip of text underneath
    panelSize = width / 2;

    // the beam renders into a panelSize canvas, from audio upsampled to 192kHz
    scope = new Oscilloscope();
    scope.setup(panelSize, panelSize, 192000);
    scope.decoderSettings.simplify = 0.75; // px; 0 keeps every sample

    player = new XYPlayer();
    player.setScope(scope);
    player.setLoop(true);
    player.openAudioOut();
    loadFile('data/xyscope.wav');

    input = new XYAudioInput();
    input.onAudioIn = (buffer) => {
        if (liveInput) scope.addBuffer(buffer);
    };

    // drop a WAV on the window to play it
    canvas.drop((file) => {
        if (liveInput) toggleLiveInput();
        loadFile(file.file);
    });
}

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

function draw() {
    // The player feeds the scope: on the audio clock once the sound has
    // started, and silently, on the frame clock, until then.
    if (!liveInput) player.update(frameSeconds());

    scope.update();

    // turn the latest loop of audio back into vector shapes
    shapes = scope.getShapes(panelSize, panelSize);

    background(0);

    // left: the audio as an analog scope draws it
    scope.draw(0, 0, panelSize, panelSize);

    // right: the vector shapes decoded from it
    push();
    translate(panelSize, 0);
    noStroke();
    fill(12);
    rect(0, 0, panelSize, panelSize);
    stroke(28);
    for (let i = 1; i < 8; i++) {
        line(i * panelSize / 8, 0, i * panelSize / 8, panelSize);
        line(0, i * panelSize / 8, panelSize, i * panelSize / 8);
    }

    let numPoints = 0;
    noFill();
    colorMode(HSB, 255);
    for (let i = 0; i < shapes.length; i++) {
        // a different hue per shape, so you can see where the strokes break
        stroke((i * 37) % 255, 120, 255);
        shapes[i].draw();
        numPoints += shapes[i].size();
        if (showPoints) {
            for (const v of shapes[i].points) circle(v.x, v.y, 3);
        }
    }
    pop();

    // info
    const y = panelSize + 22;
    noStroke();
    fill(255);
    text('beam (Oscilloscope)', 12, y);
    text('vector shapes (XYDecoder)', panelSize + 12, y);

    fill(160);
    const source = liveInput ? 'line in' :
        player.getFilename() + '  ' + (player.getPositionMS() / 1000).toFixed(1) + ' / ' +
        (player.getDurationMS() / 1000).toFixed(1) + 's  ' + player.getNumChannels() + 'ch';
    text(source, 12, y + 18);
    const period = scope.getDetectedPeriod();
    const loop = period > 0 ? (scope.getSourceSampleRate() / period).toFixed(2) + ' Hz loop' : 'no loop found';
    text(loop + ', ' + shapes.length + ' shapes, ' + numPoints + ' points', panelSize + 12, y + 18);

    text('space play/pause  </> seek  i line in  s save svg  p points  +/- beam  g glow  h hue  z z-mod', 12, y + 40);
    fill(120);
    text(status + audioNote(), 12, height - 10);
    text(frameRate().toFixed(0) + ' fps, ' + scope.getDropped() + ' dropped', panelSize + 12, height - 10);
}

function audioNote() {
    if (liveInput || player.isAudioRunning()) return '';
    if (Twoscilloscope.audio.state() === 'suspended') return ' (silently: click or press a key for sound)';
    return ' (no sound card found, playing silently)';
}

// this frame's time, but never more than a quarter second, so coming back to
// a hidden tab doesn't run up a backlog
function frameSeconds() {
    return Math.min(deltaTime, 250) / 1000;
}

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

function keyPressed() {
    if (key === ' ') {
        player.setPaused(player.isPlaying());
        return false; // don't scroll the page
    } else if (keyCode === LEFT_ARROW) {
        player.setPositionMS(Math.max(0, player.getPositionMS() - 2000));
    } else if (keyCode === RIGHT_ARROW) {
        player.setPositionMS(player.getPositionMS() + 2000);
    } else if (key === 'i') {
        toggleLiveInput();
    } else if (key === 's') {
        const path = 'shapes_' + Twoscilloscope.timestamp('%Y%m%d_%H%M%S') + '.svg';
        XYDecoder.saveSvg(path, shapes, panelSize, panelSize);
        status = 'saved ' + path;
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
}

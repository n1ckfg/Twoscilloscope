let cam;
let edgeShader;
let edgeBuffer;
let threshold = 0.15;
let showPolylines = false;
let polylines = [];
let traceWasm = null;
let sampleW = 256;
let sampleH = 256;

function preload() {
  edgeShader = loadShader('edge.vert', 'edge.frag');
}

async function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  noStroke();
  textureMode(NORMAL);

  edgeBuffer = createGraphics(640, 480, WEBGL);
  edgeBuffer.pixelDensity(1);
  edgeBuffer.noStroke();

  cam = createCapture(VIDEO);
  cam.size(640, 480);
  cam.hide();

  // Load WASM skeleton tracer
  traceWasm = await TraceSkeleton.load();
}

function draw() {
  if (!cam.width || !cam.height || !traceWasm) return;

  edgeBuffer.shader(edgeShader);
  edgeShader.setUniform('tex0', cam);
  edgeShader.setUniform('texelSize', [1.0 / cam.width, 1.0 / cam.height]);
  edgeShader.setUniform('threshold', threshold);
  edgeBuffer.rect(-edgeBuffer.width / 2, -edgeBuffer.height / 2, edgeBuffer.width, edgeBuffer.height);

  if (showPolylines) {
    background(0);
    traceFrame();
    drawPolylines();
  } else {
    image(edgeBuffer, -width / 2, -height / 2, width, height);
  }
}

function traceFrame() {
  edgeBuffer.loadPixels();

  let bufW = edgeBuffer.width * edgeBuffer.pixelDensity();
  let bufH = edgeBuffer.height * edgeBuffer.pixelDensity();

  // Build binary char string for WASM
  let str = "";
  let scaleX = bufW / sampleW;
  let scaleY = bufH / sampleH;

  for (let y = 0; y < sampleH; y++) {
    for (let x = 0; x < sampleW; x++) {
      let srcX = Math.floor(x * scaleX);
      let srcY = Math.floor(y * scaleY);
      let srcIdx = (srcY * bufW + srcX) * 4;
      str += edgeBuffer.pixels[srcIdx] > 128 ? "\1" : "\0";
    }
  }

  // Trace skeleton using WASM
  let result = traceWasm.fromCharString(str, sampleW, sampleH);
  polylines = result.polylines;
}

function drawPolylines() {
  resetShader();

  let scaleX = width / sampleW;
  let scaleY = height / sampleH;

  stroke(0, 255, 0);
  strokeWeight(2);
  noFill();

  for (let poly of polylines) {
    if (poly.length < 2) continue;
    beginShape();
    for (let pt of poly) {
      let x = pt[0] * scaleX - width / 2;
      let y = pt[1] * scaleY - height / 2;
      vertex(x, y);
    }
    endShape();
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function keyPressed() {
  if (keyCode === UP_ARROW) {
    threshold = min(threshold + 0.02, 1.0);
    console.log('Threshold:', threshold.toFixed(2));
  } else if (keyCode === DOWN_ARROW) {
    threshold = max(threshold - 0.02, 0.01);
    console.log('Threshold:', threshold.toFixed(2));
  } else if (keyCode === TAB) {
    showPolylines = !showPolylines;
    polylines = [];
    console.log('Mode:', showPolylines ? 'Polylines' : 'Edge Detection');
    return false;
  }
}

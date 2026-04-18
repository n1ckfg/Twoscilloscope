let cam;
let edgeShader;
let edgeBuffer;
let threshold = 0.15;
let showPolylines = false;
let polylines = [];
let skeletonWorker;
let workerBusy = false;
let sampleW = 256; //80;
let sampleH = 256; //60;

function preload() {
  edgeShader = loadShader('edge.vert', 'edge.frag');
}

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  noStroke();
  textureMode(NORMAL);

  edgeBuffer = createGraphics(640, 480, WEBGL);
  edgeBuffer.pixelDensity(1);
  edgeBuffer.noStroke();

  cam = createCapture(VIDEO);
  cam.size(640, 480);
  cam.hide();

  skeletonWorker = new Worker('skeleton.worker.js');
  skeletonWorker.onmessage = function(e) {
    polylines = e.data.polylines;
    workerBusy = false;
  };
}

function draw() {
  if (!cam.width || !cam.height) return;

  edgeBuffer.shader(edgeShader);
  edgeShader.setUniform('tex0', cam);
  edgeShader.setUniform('texelSize', [1.0 / cam.width, 1.0 / cam.height]);
  edgeShader.setUniform('threshold', threshold);
  edgeBuffer.rect(-edgeBuffer.width / 2, -edgeBuffer.height / 2, edgeBuffer.width, edgeBuffer.height);

  image(edgeBuffer, -width / 2, -height / 2, width, height);

  if (showPolylines) {
    if (!workerBusy) {
      workerBusy = true;
      sendFrameToWorker();
    }
    drawPolylines();
  }
}

function sendFrameToWorker() {
  edgeBuffer.loadPixels();

  let bufW = edgeBuffer.width * edgeBuffer.pixelDensity();
  let bufH = edgeBuffer.height * edgeBuffer.pixelDensity();

  let binaryImg = new Array(sampleW * sampleH);
  let scaleX = bufW / sampleW;
  let scaleY = bufH / sampleH;

  for (let y = 0; y < sampleH; y++) {
    for (let x = 0; x < sampleW; x++) {
      let srcX = Math.floor(x * scaleX);
      let srcY = Math.floor(y * scaleY);
      let srcIdx = (srcY * bufW + srcX) * 4;
      binaryImg[y * sampleW + x] = edgeBuffer.pixels[srcIdx] > 128 ? 1 : 0;
    }
  }

  skeletonWorker.postMessage({
    binaryImg: binaryImg,
    width: sampleW,
    height: sampleH
  });
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
    workerBusy = false;
    console.log('Mode:', showPolylines ? 'Polylines' : 'Edge Detection');
    return false;
  }
}

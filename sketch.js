let cam;
let edgeShader;
let threshold = 0.15;

function preload() {
  edgeShader = loadShader('edge.vert', 'edge.frag');
}

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  noStroke();

  cam = createCapture(VIDEO);
  cam.size(640, 480);
  cam.hide();
}

function draw() {
  shader(edgeShader);

  // Pass webcam texture
  edgeShader.setUniform('tex0', cam);

  // Texel size for sampling neighbors (1 pixel in UV space)
  edgeShader.setUniform('texelSize', [1.0 / cam.width, 1.0 / cam.height]);

  // Edge detection threshold
  edgeShader.setUniform('threshold', threshold);

  // Draw fullscreen quad
  quad(-1, -1, 1, -1, 1, 1, -1, 1);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function keyPressed() {
  // Adjust threshold with up/down arrows
  if (keyCode === UP_ARROW) {
    threshold = min(threshold + 0.02, 1.0);
    console.log('Threshold:', threshold.toFixed(2));
  } else if (keyCode === DOWN_ARROW) {
    threshold = max(threshold - 0.02, 0.01);
    console.log('Threshold:', threshold.toFixed(2));
  }
}

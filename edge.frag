precision highp float;

varying vec2 vTexCoord;

uniform sampler2D tex0;
uniform vec2 texelSize;
uniform float threshold;

// Convert to grayscale using luminance weights
float luminance(vec3 color) {
  return dot(color, vec3(0.299, 0.587, 0.114));
}

void main() {
  // Sample 3x3 neighborhood for Sobel operator
  // More efficient: sample once and reuse
  float tl = luminance(texture2D(tex0, vTexCoord + vec2(-texelSize.x, -texelSize.y)).rgb);
  float tm = luminance(texture2D(tex0, vTexCoord + vec2(0.0, -texelSize.y)).rgb);
  float tr = luminance(texture2D(tex0, vTexCoord + vec2(texelSize.x, -texelSize.y)).rgb);

  float ml = luminance(texture2D(tex0, vTexCoord + vec2(-texelSize.x, 0.0)).rgb);
  float mr = luminance(texture2D(tex0, vTexCoord + vec2(texelSize.x, 0.0)).rgb);

  float bl = luminance(texture2D(tex0, vTexCoord + vec2(-texelSize.x, texelSize.y)).rgb);
  float bm = luminance(texture2D(tex0, vTexCoord + vec2(0.0, texelSize.y)).rgb);
  float br = luminance(texture2D(tex0, vTexCoord + vec2(texelSize.x, texelSize.y)).rgb);

  // Sobel kernels
  // Gx: horizontal edge detection
  // -1  0  1
  // -2  0  2
  // -1  0  1
  float gx = -tl + tr - 2.0*ml + 2.0*mr - bl + br;

  // Gy: vertical edge detection
  // -1 -2 -1
  //  0  0  0
  //  1  2  1
  float gy = -tl - 2.0*tm - tr + bl + 2.0*bm + br;

  // Magnitude of gradient
  float edge = sqrt(gx*gx + gy*gy);

  // Apply threshold for cleaner edges
  edge = edge > threshold ? 1.0 : edge / threshold;

  // Binary threshold: edge pixels are strictly black or white
  edge = step(threshold, edge);

  // Dilate edges (expand edge regions by 1 pixel)
  float dilate = 0.0;
  if (edge > 0.5) {
    dilate = 1.0;
  } else {
    float left = texture2D(tex0, vTexCoord + vec2(-texelSize.x, 0.0)).r;
    float right = texture2D(tex0, vTexCoord + vec2(texelSize.x, 0.0)).r;
    float up = texture2D(tex0, vTexCoord + vec2(0.0, -texelSize.y)).r;
    float down = texture2D(tex0, vTexCoord + vec2(0.0, texelSize.y)).r;
    dilate = 1.0 - ((left > 0.5 || right > 0.5 || up > 0.5 || down > 0.5) ? 1.0 : 0.0);
  }
  edge = dilate;

  gl_FragColor = vec4(vec3(edge), 1.0);
}

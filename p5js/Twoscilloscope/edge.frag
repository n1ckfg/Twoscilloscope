precision highp float;

varying vec2 vTexCoord;

uniform sampler2D tex0;
uniform vec2 texelSize;
uniform float threshold;

float luminance(vec3 color) {
  return dot(color, vec3(0.299, 0.587, 0.114));
}

void main() {
  // Sample 3x3 neighborhood
  float tl = luminance(texture2D(tex0, vTexCoord + vec2(-texelSize.x, -texelSize.y)).rgb);
  float tm = luminance(texture2D(tex0, vTexCoord + vec2(0.0, -texelSize.y)).rgb);
  float tr = luminance(texture2D(tex0, vTexCoord + vec2(texelSize.x, -texelSize.y)).rgb);

  float ml = luminance(texture2D(tex0, vTexCoord + vec2(-texelSize.x, 0.0)).rgb);
  float mr = luminance(texture2D(tex0, vTexCoord + vec2(texelSize.x, 0.0)).rgb);

  float bl = luminance(texture2D(tex0, vTexCoord + vec2(-texelSize.x, texelSize.y)).rgb);
  float bm = luminance(texture2D(tex0, vTexCoord + vec2(0.0, texelSize.y)).rgb);
  float br = luminance(texture2D(tex0, vTexCoord + vec2(texelSize.x, texelSize.y)).rgb);

  // Scharr kernels (better rotational symmetry than Sobel)
  // Gx:  -3   0   3
  //     -10   0  10
  //      -3   0   3
  float gx = -3.0*tl + 3.0*tr - 10.0*ml + 10.0*mr - 3.0*bl + 3.0*br;

  // Gy:  -3 -10  -3
  //       0   0   0
  //       3  10   3
  float gy = -3.0*tl - 10.0*tm - 3.0*tr + 3.0*bl + 10.0*bm + 3.0*br;

  float mag = sqrt(gx*gx + gy*gy);
  float edge = step(threshold, mag);

  gl_FragColor = vec4(vec3(edge), 1.0);
}

attribute vec2 aUnit;
uniform vec4 uPos;        // clip-space: originX, originY, width, height
varying vec2 vUV;
void main() {
  vUV = aUnit;            // 0..1, y=0 at the top of the box
  vec2 p = uPos.xy + aUnit * uPos.zw;
  gl_Position = vec4(p, 0.0, 1.0);
}

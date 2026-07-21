precision mediump float;
varying vec2 vUV;
uniform sampler2D uMap;   // R/G direction field for this surface
uniform sampler2D uCam;   // mirrored, blurred camera frame
uniform vec2 uBox;        // box size in px (for the rounded-corner mask)
uniform float uRadius;    // painted corner radius in px
uniform float uIntensity;
uniform float uDirSign;
uniform float uBlackPoint; // 0..1: crush anything below this to black, rescale up
uniform float uSaturation; // scales color away from grey (1 = unchanged)
void main() {
  vec2 dir = (texture2D(uMap, vUV).rg - 0.5) * 2.0;   // -1..1
  // Direction -> absolute position from the camera center. The magnitude is
  // normalized so 1 = the largest possible displacement (half the smaller feed
  // dimension), then reshaped by a response curve before it becomes a radius.
  // Here that curve is the square: near-center stays put, the rim reaches out.
  float mag = clamp(length(dir), 0.0, 1.0);
  vec2 unit = mag > 1e-5 ? dir / mag : vec2(0.0);
  float radius = mag * mag;                            // f(mag); currently square
  vec2 camUV = clamp(0.5 + uDirSign * unit * radius * 0.5, 0.0, 1.0);
  vec3 col = texture2D(uCam, camUV).rgb;
  // Level-stretch: crush below the black point to 0, rescale the rest to 0..1.
  col = max(col - uBlackPoint, 0.0) / max(1.0 - uBlackPoint, 1e-4);
  // Desaturate toward luminance so the reflection stays a soft neutral highlight.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum), col, uSaturation);
  col *= uIntensity;

  // Mask to the rounded-rect silhouette so the corners outside the radius (which
  // are neutral grey, and would otherwise wash the center color) stay empty.
  vec2 p = vUV * uBox;
  vec2 h = uBox * 0.5;
  vec2 q = abs(p - h) - (h - uRadius);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
  float aa = 1.0 - smoothstep(-1.0, 1.0, d);
  if (aa <= 0.0) discard;

  gl_FragColor = vec4(col, aa);
}

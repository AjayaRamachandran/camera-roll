precision mediump float;
varying vec2 vUV;
uniform sampler2D uLight;   // small camera light field (unflipped)
uniform vec2 uElem;         // element box size in css px
uniform float uRadius;      // element corner radius in css px
uniform float uSpread;      // max shadow displacement in css px
uniform float uBlackPoint;  // 0..1 crush for the light field
uniform float uStrength;    // accumulated-light -> alpha scale
uniform float uMaxAlpha;
uniform float uFlip;        // -1 = shadow opposite the light
// N is the light field resolution. GLSL loop bounds must be compile-time
// constants, so the __LIGHT_SIZE__ token is replaced with the real value when
// this source is loaded.
const int N = __LIGHT_SIZE__;

// Soft coverage of the rounded rect [0,uElem] at point p (css px).
float rrCoverage(vec2 p, vec2 elem, float rad) {
  vec2 h = elem * 0.5;
  vec2 q = abs(p - h) - (h - rad);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
  return 1.0 - smoothstep(-1.0, 1.0, d);
}

void main() {
  vec2 padded = uElem + 2.0 * uSpread;
  // Element-local coords, origin at the box's top-left, y pointing down.
  vec2 o = vec2(vUV.x, 1.0 - vUV.y) * padded - uSpread;
  float acc = 0.0;
  for (int j = 0; j < N; j++) {
    for (int i = 0; i < N; i++) {
      vec2 luv = (vec2(float(i), float(j)) + 0.5) / float(N);
      vec3 c = texture2D(uLight, luv).rgb;
      float lum = dot(c, vec3(0.299, 0.587, 0.114));
      // Soft brightness response: normalize the range above the black point to
      // 0..1, then square. Squaring keeps the derivative at 0 as the light crosses
      // the threshold, so contributions ease in instead of snapping on with the
      // hard kink that a straight clip leaves. Brighter light still reigns (in
      // fact more so, the curve being convex).
      float t = clamp((lum - uBlackPoint) / max(1.0 - uBlackPoint, 1e-4), 0.0, 1.0);
      float L = t * t;
      if (L <= 0.0) continue;
      vec2 dir = (luv - 0.5) * 2.0;              // -1..1 from center
      vec2 offset = uFlip * dir * uSpread;       // flip = shadow opposite light
      acc += L * rrCoverage(o - offset, uElem, uRadius);
    }
  }
  float a = clamp(acc * uStrength, 0.0, uMaxAlpha);
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}

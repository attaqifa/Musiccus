import type { Snapshot } from '../../audio/hub';
import { monoPalette } from '../../analysis/theory';
import { ChordWatch, ShaderWorld, vec3 } from '../world';

/*
 * Aurora: curtains of light over a still lake. Midrange makes the curtains
 * fold, bass makes them bright, hi-hats make the stars twinkle, kicks ripple
 * the lake, and a chord change sends a wave of light along the curtains.
 */

const fragment = /* glsl */ `
uniform float uAspect;
uniform float uTime;
uniform float uFlow;
uniform float uBass;
uniform float uMid;
uniform float uEnergy;
uniform float uHat;
uniform float uBeat;
uniform float uPulse;
uniform float uAnticip;
uniform float uImpact;
uniform float uKick;
uniform float uKickAge;
uniform float uChordAge;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

const float HORIZON = 0.24;

float fbm3(vec2 p) {
  return 0.5 * noise(p) + 0.25 * noise(p * 2.03) + 0.125 * noise(p * 4.1);
}

vec3 aurora(vec2 uv) {
  vec3 col = vec3(0.0);
  float x = (uv.x - 0.5) * uAspect;
  // A chord change sends a band of light along the curtains, left to right.
  float sweepX = -0.5 * uAspect - 0.3 + uChordAge * 1.4;
  float sweep = exp(-pow((x - sweepX) * 2.6, 2.0)) * exp(-uChordAge * 0.9);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    // A slow domain warp bends each curtain, and its rays bend with it, so
    // they hang like folded cloth instead of standing as straight columns.
    float warp = fbm3(vec2(x * 0.8 + fi * 5.1, uFlow * 0.03 + fi)) - 0.5;
    float xs = x * (1.1 + fi * 0.35) + warp * 0.55 + uFlow * (0.03 + fi * 0.012);
    float fold = (fbm(vec2(xs * 0.9, fi * 3.7 + uFlow * 0.04)) - 0.5) * (0.26 + uMid * 0.3);
    float base = 0.41 + fi * 0.075 + fold - uAnticip * 0.05;
    float d = uv.y - base;
    float lower = smoothstep(-0.015, 0.006, d);
    float tail = exp(-max(d, 0.0) * (5.2 - uBass * 2.2 - uImpact * 1.5));
    // Broader rays than before (less like a bar graph), still crisp.
    float rays = 0.38 + 0.62 * noise(vec2(xs * 36.0, fi * 11.0 + uFlow * 0.2));
    float inten = lower * tail * rays * (0.28 + uEnergy * 0.7 + uBeat * 0.15 + uPulse * 0.3 + uImpact * 0.9) * (1.0 + sweep * 1.2);
    vec3 c = mix(uColB, uColA, clamp(d * 3.2, 0.0, 1.0));
    c = mix(c, uColC, smoothstep(0.75, 1.0, rays) * 0.35 + sweep * 0.4);
    col += c * inten * (0.6 - fi * 0.14);
  }
  return col;
}

void main() {
  vec2 uv = vUv;
  vec3 col = mix(vec3(0.012, 0.011, 0.02), vec3(0.0), uv.y);

  if (uv.y > HORIZON) {
    col += aurora(uv);
    // Stars only high in the sky, small and steady; hi-hats make them twinkle a little.
    vec2 sp = floor(vec2(uv.x * uAspect, uv.y) * 520.0);
    float star = step(0.9972, hash(sp));
    float tw = 0.5 + 0.5 * sin(uTime * (1.5 + hash(sp + 3.0) * 3.0) + hash(sp) * 40.0);
    col += vec3(1.0, 0.95, 0.88) * star * (0.12 + tw * 0.2) * (1.0 + uHat * 0.7) * smoothstep(0.58, 0.86, uv.y);
    // Mountain silhouette along the horizon.
    float ridge = HORIZON + 0.035 + 0.06 * fbm(vec2((uv.x - 0.5) * uAspect * 2.4, 1.3));
    col = mix(col, vec3(0.006, 0.005, 0.008), smoothstep(ridge + 0.002, ridge - 0.002, uv.y));
  } else {
    // The lake mirrors the sky, broken up by slow ripples; a kick drops a
    // ring onto the water that spreads toward the shore.
    float depth = (HORIZON - uv.y) / HORIZON;
    float ripple = (noise(vec2(uv.x * uAspect * 30.0, uv.y * 140.0 - uTime * 0.6)) - 0.5) * 0.01 * (1.0 + depth * 2.0);
    float rd = length(vec2((uv.x - 0.5) * uAspect, (uv.y - HORIZON * 0.45) * 4.0));
    ripple += sin(rd * 70.0 - uKickAge * 24.0) * exp(-uKickAge * 2.2) * exp(-abs(rd - uKickAge * 0.34) * 8.0) * uKick * 0.012;
    vec2 m = vec2(uv.x + ripple, HORIZON * 2.0 - uv.y + ripple * 0.5);
    col += aurora(m) * (0.5 - depth * 0.3);
    col += uColB * exp(-abs(uv.y - HORIZON) * 90.0) * 0.08 * (0.5 + uEnergy);
  }
  gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
}
`;

export class AuroraWorld extends ShaderWorld {
  readonly bloom = { strength: 0.85, radius: 0.65, threshold: 0.1 };
  private chord = new ChordWatch();
  private lastKick = 0;

  constructor() {
    super(fragment, {
      uFlow: { value: 0 },
      uBass: { value: 0 },
      uMid: { value: 0 },
      uEnergy: { value: 0 },
      uHat: { value: 0 },
      uBeat: { value: 0 },
      uPulse: { value: 0 },
      uAnticip: { value: 0 },
      uImpact: { value: 0 },
      uKick: { value: 0 },
      uKickAge: { value: 10 },
      uChordAge: { value: 10 },
      uColA: { value: vec3(monoPalette(0).a) },
      uColB: { value: vec3(monoPalette(0).b) },
      uColC: { value: vec3(monoPalette(0).c) },
    });
  }

  update(s: Snapshot, dt: number, time: number) {
    const f = s.features;
    const m = s.music;
    const u = this.u;
    u.uTime.value = time;
    u.uFlow.value += dt * (1 + f.energy * 1.5 + m.anticipation * 2);
    u.uBass.value = Math.max(f.sub, f.bass);
    u.uMid.value = (f.lowMid + f.mid) * 0.5;
    u.uEnergy.value = f.energy;
    u.uHat.value = f.hat;
    u.uBeat.value = m.beatPulse;
    u.uPulse.value = f.pulse;
    u.uAnticip.value = m.anticipation;
    u.uImpact.value = m.impact;
    this.chord.update(m, dt);
    u.uChordAge.value = this.chord.age;
    if (f.kickCount !== this.lastKick) {
      this.lastKick = f.kickCount;
      u.uKickAge.value = 0;
      u.uKick.value = Math.max(0.5, f.kick);
    } else {
      u.uKickAge.value += dt;
    }
    u.uColA.value.set(...m.palette.a);
    u.uColB.value.set(...m.palette.b);
    u.uColC.value.set(...m.palette.c);
  }
}

import * as THREE from 'three';
import { SCOPE_N, type Snapshot } from '../../audio/hub';
import type { Quality } from '../../store/player';
import { ChordWatch, type World } from '../world';

/*
 * Medan Stereo: a goniometer drawn as light. Every sample pair (L, R) becomes
 * a point at (side, mid): a mono signal stands as a vertical line, a wide mix
 * spreads into a cloud, and out-of-phase content lies flat. Each new frame is
 * written at the front and the older ones recede, so the stereo image of the
 * last second and a half becomes a tunnel. Beats and chord changes mark their
 * frame, and those marks travel back into the tunnel.
 */

const FRAMES: Record<Quality, number> = { low: 40, medium: 64, high: 90, ultra: 120 };
const SAMPLES: Record<Quality, number> = { low: 256, medium: 512, high: 1024, ultra: 1024 };
const ROW_RATE = 60;
const DEPTH = 0.36;
const SCALE = 5.2;

const vertex = /* glsl */ `
uniform sampler2D uHist;
uniform sampler2D uMeta;
uniform float uHead;
uniform float uFrames;
uniform float uDepth;
uniform float uScale;
uniform float uTwist;
uniform float uKick;
uniform float uPixel;
uniform float uLive;
uniform float uImpact;
uniform float uEnergy;
uniform float uPulse;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
uniform vec3 uWarn;
attribute vec2 aIdx;
varying vec3 vColor;

void main() {
  float age = aIdx.y;
  float row = mod(uHead - age + uFrames, uFrames);
  float v = (row + 0.5) / uFrames;
  vec2 lr = texture2D(uHist, vec2(aIdx.x, v)).rg;
  // meta: correlation, level, beat mark, chord mark.
  vec4 meta = texture2D(uMeta, vec2(0.5, v));

  // Goniometer axes: left-only signal leans to the upper left, right-only to
  // the upper right, mono stands upright, opposite phase lies flat.
  float side = (lr.y - lr.x) * 0.70710678;
  float mid = (lr.x + lr.y) * 0.70710678;
  vec2 xy = vec2(side, mid) * uScale;

  // Kicks swell the newest frames; build-ups twist the tunnel.
  float front = exp(-age * 0.12);
  xy *= 1.0 + uKick * 0.22 * front + uImpact * 0.15;
  float a = age * uTwist;
  xy = mat2(cos(a), -sin(a), sin(a), cos(a)) * xy;
  vec3 p = vec3(xy, -age * uDepth);

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float mark = max(meta.b, meta.a * 1.6);
  gl_PointSize = clamp((0.05 + mark * 0.05) * uPixel / -mv.z, 1.0, 5.0);

  float t = age / uFrames;
  vec3 c = mix(uColC, uColB, smoothstep(0.0, 0.25, t));
  c = mix(c, uColA, smoothstep(0.25, 0.9, t));
  // Negative correlation (phase trouble) warms toward the warning colour.
  c = mix(c, uWarn, smoothstep(-0.05, -0.6, meta.r) * 0.75);
  c = mix(c, uColC, meta.a);
  // Silent frames fade out instead of piling every point onto the centre.
  float audible = smoothstep(0.002, 0.03, meta.g);
  float fade = exp(-t * 2.6);
  vColor = c * audible * fade * (0.042 + uEnergy * 0.025 + uPulse * 0.03 * front + mark * 0.14) * uLive;
}
`;

const fragment = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = dot(uv, uv);
  if (d > 1.0) discard;
  gl_FragColor = vec4(vColor * exp(-d * 3.0), 1.0);
}
`;

/** Faint goniometer scale at the front frame: circle, M/S cross, L/R diagonals. */
function makeScale(): THREE.LineSegments {
  const pts: number[] = [];
  const r = SCALE * 1.08;
  for (let i = 0; i < 96; i++) {
    const a0 = (i / 96) * Math.PI * 2;
    const a1 = ((i + 1) / 96) * Math.PI * 2;
    pts.push(Math.cos(a0) * r, Math.sin(a0) * r, 0, Math.cos(a1) * r, Math.sin(a1) * r, 0);
  }
  const axis = (ax: number, ay: number) => pts.push(-ax * r, -ay * r, 0, ax * r, ay * r, 0);
  axis(0, 1);
  axis(1, 0);
  axis(Math.SQRT1_2, Math.SQRT1_2);
  axis(-Math.SQRT1_2, Math.SQRT1_2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const m = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false });
  return new THREE.LineSegments(g, m);
}

/** Small letter sprites so the diagonals read as left and right. */
function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.font = '500 34px "IBM Plex Sans", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(0.8);
  return s;
}

export class StereoWorld implements World {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  readonly bloom = { strength: 0.7, radius: 0.5, threshold: 0.1 };

  private frames: number;
  private hist: Float32Array;
  private histTex: THREE.DataTexture;
  private meta: Float32Array;
  private metaTex: THREE.DataTexture;
  private points: THREE.Points;
  private material: THREE.ShaderMaterial;
  private scaleLines: THREE.LineSegments;
  private labels: THREE.Sprite[] = [];
  private head = 0;
  private acc = 0;
  private peak = 0.1;
  private kick = 0;
  private lastKick = 0;
  private lastBeat = 0;
  private pendingBeat = 0;
  private pendingChord = 0;
  private chord = new ChordWatch();
  private orbit = 0;
  private live = 1;

  constructor(quality: Quality) {
    this.scene.background = new THREE.Color(0x040506);
    this.frames = FRAMES[quality];
    this.hist = new Float32Array(SCOPE_N * 2 * this.frames);
    this.histTex = this.makeHistTex();
    this.meta = new Float32Array(4 * this.frames);
    this.metaTex = this.makeMetaTex();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uHist: { value: this.histTex },
        uMeta: { value: this.metaTex },
        uHead: { value: 0 },
        uFrames: { value: this.frames },
        uDepth: { value: DEPTH },
        uScale: { value: SCALE },
        uTwist: { value: 0.004 },
        uKick: { value: 0 },
        uPixel: { value: 600 },
        uLive: { value: 1 },
        uImpact: { value: 0 },
        uEnergy: { value: 0 },
        uPulse: { value: 0 },
        uColA: { value: new THREE.Vector3(0.78, 0.3, 0.2) },
        uColB: { value: new THREE.Vector3(0.98, 0.62, 0.22) },
        uColC: { value: new THREE.Vector3(1.0, 0.92, 0.8) },
        // The app's danger colour (#E0614A) in linear light.
        uWarn: { value: new THREE.Vector3(0.75, 0.12, 0.07) },
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(this.makeGeometry(quality), this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    this.scaleLines = makeScale();
    this.scene.add(this.scaleLines);
    const r = SCALE * 1.2;
    const d = r * Math.SQRT1_2;
    for (const [text, x, y] of [['L', -d, d], ['R', d, d]] as const) {
      const s = makeLabel(text);
      s.position.set(x, y, 0);
      this.labels.push(s);
      this.scene.add(s);
    }
  }

  private makeHistTex() {
    const t = new THREE.DataTexture(this.hist, SCOPE_N, this.frames, THREE.RGFormat, THREE.FloatType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  }

  private makeMetaTex() {
    const t = new THREE.DataTexture(this.meta, 1, this.frames, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  }

  private makeGeometry(q: Quality) {
    const samples = SAMPLES[q];
    const frames = FRAMES[q];
    const idx = new Float32Array(samples * frames * 2);
    const step = SCOPE_N / samples;
    let o = 0;
    for (let f = 0; f < frames; f++) {
      for (let i = 0; i < samples; i++) {
        idx[o++] = (i * step + 0.5) / SCOPE_N;
        idx[o++] = f;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('aIdx', new THREE.BufferAttribute(idx, 2));
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(samples * frames * 3), 3));
    return g;
  }

  setQuality(q: Quality) {
    this.frames = FRAMES[q];
    this.hist = new Float32Array(SCOPE_N * 2 * this.frames);
    this.meta = new Float32Array(4 * this.frames);
    this.histTex.dispose();
    this.metaTex.dispose();
    this.histTex = this.makeHistTex();
    this.metaTex = this.makeMetaTex();
    this.head = 0;
    const u = this.material.uniforms;
    u.uHist.value = this.histTex;
    u.uMeta.value = this.metaTex;
    u.uFrames.value = this.frames;
    const old = this.points.geometry;
    this.points.geometry = this.makeGeometry(q);
    old.dispose();
  }

  resize(w: number, h: number, pr: number) {
    this.camera.aspect = w / h;
    // Keep the whole scale in view on a portrait phone screen.
    this.camera.fov = w / h < 0.8 ? 72 : 50;
    this.camera.updateProjectionMatrix();
    this.material.uniforms.uPixel.value = (h * pr) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  /** Writes the current scope frame, normalised so quiet passages still fill the scale. */
  private pushRow(L: Float32Array, R: Float32Array) {
    let peak = 0;
    let sl = 0;
    let sr = 0;
    let slr = 0;
    for (let i = 0; i < SCOPE_N; i++) {
      const l = L[i];
      const r = R[i];
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      sl += l * l;
      sr += r * r;
      slr += l * r;
    }
    // Fast attack, slow release: the picture grows with a hit and shrinks gently.
    this.peak = peak > this.peak ? this.peak + (peak - this.peak) * 0.5 : this.peak * 0.985 + peak * 0.015;
    const gain = 0.72 / Math.max(this.peak, 0.02);
    this.head = (this.head + 1) % this.frames;
    const o = this.head * SCOPE_N * 2;
    for (let i = 0; i < SCOPE_N; i++) {
      this.hist[o + i * 2] = Math.max(-1.5, Math.min(1.5, L[i] * gain));
      this.hist[o + i * 2 + 1] = Math.max(-1.5, Math.min(1.5, R[i] * gain));
    }
    const m = this.head * 4;
    this.meta[m] = sl > 1e-9 && sr > 1e-9 ? slr / Math.sqrt(sl * sr) : 1;
    this.meta[m + 1] = Math.sqrt((sl + sr) / (2 * SCOPE_N));
    this.meta[m + 2] = this.pendingBeat;
    this.meta[m + 3] = this.pendingChord;
    this.pendingBeat = 0;
    this.pendingChord = 0;
    this.histTex.needsUpdate = true;
    this.metaTex.needsUpdate = true;
  }

  update(s: Snapshot, dt: number, time: number) {
    const f = s.features;
    const m = s.music;
    const u = this.material.uniforms;

    if (m.ready && m.beatCount !== this.lastBeat) this.pendingBeat = m.beatInBar === 0 ? 1 : 0.45;
    this.lastBeat = m.beatCount;
    if (this.chord.update(m, dt)) this.pendingChord = 1;
    if (f.kickCount !== this.lastKick) {
      this.lastKick = f.kickCount;
      this.kick = Math.max(this.kick, f.kick);
      if (!m.ready) this.pendingBeat = 0.6;
    }
    this.kick *= Math.exp(-dt * 7);

    // While paused the last picture stays, dimmed; playback brings it back.
    if (s.playing) {
      this.acc += dt;
      let pushed = 0;
      while (this.acc >= 1 / ROW_RATE && pushed < 3) {
        this.pushRow(s.scopeL, s.scopeR);
        this.acc -= 1 / ROW_RATE;
        pushed++;
      }
      if (pushed === 3) this.acc = 0;
    }
    this.live += ((s.playing ? 1 : 0.35) - this.live) * Math.min(1, dt * 3);

    u.uHead.value = this.head;
    u.uKick.value = this.kick;
    u.uLive.value = this.live;
    u.uImpact.value = m.impact;
    u.uEnergy.value = f.energy;
    u.uPulse.value = f.pulse;
    // Older frames turn slowly into a spiral; a build-up and a chord change wind it tighter.
    u.uTwist.value = 0.008 + m.anticipation * 0.03 + Math.exp(-this.chord.age * 2.5) * 0.02;
    u.uColA.value.set(...m.palette.a);
    u.uColB.value.set(...m.palette.b);
    u.uColC.value.set(...m.palette.c);

    // The camera looks in from one side, so the receding frames read as a
    // tunnel, and leans in with loudness.
    this.orbit += dt * (0.05 + f.energy * 0.05);
    // Mostly from the right, swinging gently; it never passes straight on,
    // where the tunnel would hide behind its own front frame.
    // A portrait phone screen is narrow: look in more head-on and from further back.
    const portrait = this.camera.aspect < 0.8;
    const yaw = portrait ? 0.2 + 0.08 * Math.sin(this.orbit) : 0.42 + 0.18 * Math.sin(this.orbit);
    const dist = (portrait ? 21 : 16) - f.energy * 1.5 + m.anticipation * 4 - m.impact * 2;
    this.camera.position.set(Math.sin(yaw) * dist, 2.8 + Math.sin(time * 0.06) * 1.2, Math.cos(yaw) * dist);
    this.camera.lookAt(0, 0.2, -8);
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
    this.histTex.dispose();
    this.metaTex.dispose();
    this.scaleLines.geometry.dispose();
    (this.scaleLines.material as THREE.Material).dispose();
    for (const l of this.labels) {
      l.material.map?.dispose();
      l.material.dispose();
    }
  }
}

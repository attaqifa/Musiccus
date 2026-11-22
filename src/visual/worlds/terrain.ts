import * as THREE from 'three';
import { BANDS_N, type Snapshot } from '../../audio/hub';
import type { Quality } from '../../store/player';
import { ChordWatch, type World } from '../world';

const ROWS = 200;
const ROW_RATE = 60;
const SEGS: Record<Quality, number> = { low: 127, medium: 255, high: 511, ultra: 767 };

const terrainVertex = /* glsl */ `
uniform sampler2D uHist;
uniform float uHead;
uniform float uRows;
uniform float uAmp;
varying float vH;
varying float vAge;
varying float vRow;
varying float vCol;

void main() {
  // The bass lives on the canyon walls, the treble in the valley floor.
  float side = abs(uv.x * 2.0 - 1.0);
  float band = 1.0 - side;
  float age = uv.y;
  float row = uHead - age * (uRows - 1.0);
  float v = texture2D(uHist, vec2(band * (255.0 / 256.0) + 0.5 / 256.0, (row + 0.5) / uRows)).r;
  float wall = side * side;
  vec3 p = position;
  p.y += v * uAmp * (0.45 + 0.9 * wall) + wall * 2.4;
  vH = v;
  vAge = age;
  vRow = row;
  vCol = uv.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const terrainFragment = /* glsl */ `
uniform vec3 uFog;
uniform float uHaze;
uniform float uKick;
uniform float uPulse;
uniform float uImpact;
uniform float uRows;
uniform sampler2D uBeats;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
varying float vH;
varying float vAge;
varying float vRow;
varying float vCol;

void main() {
  vec2 coord = vec2(vCol * 96.0, vRow / 3.0);
  vec2 grid = abs(fract(coord - 0.5) - 0.5) / fwidth(coord);
  float line = 1.0 - min(min(grid.x, grid.y), 1.0);
  vec3 heat = mix(uColA, uColB, smoothstep(0.15, 0.6, vH));
  heat = mix(heat, uColC, smoothstep(0.72, 1.0, vH));
  // Contour lines stay faintly lit even in silence so the land never vanishes.
  vec3 col = vec3(0.058, 0.061, 0.066) + heat * vH * 0.36;
  col += line * heat * (0.24 + vH * 0.8 + uKick * 0.28 + uPulse * 0.18 + uImpact * 0.45);
  // Beat rails: rows written on a beat glow and travel into the distance,
  // so the rhythm grid itself becomes part of the landscape.
  float beat = texture2D(uBeats, vec2(0.5, (floor(vRow + 0.5) + 0.5) / uRows)).r;
  float rowLine = 1.0 - min(abs(fract(vRow - 0.5) - 0.5) / max(fwidth(vRow), 1e-4), 1.0);
  col += mix(uColB, uColC, beat) * rowLine * beat * 1.3;
  // Distance haze takes the key colour, so the far land dissolves into light.
  vec3 fog = uFog + uColA * uHaze;
  col = mix(col, fog, smoothstep(0.3, 1.0, vAge));
  gl_FragColor = vec4(pow(col, vec3(2.2)), 1.0);
}
`;

const sunVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// An eclipse: a dark moon whose corona breathes with the loudness. The thin
// ring at the limb flares on kicks, and the corona's streamers turn to a new
// pattern at every chord change.
const sunFragment = /* glsl */ `
uniform float uGlow;
uniform float uTime;
uniform float uTurn;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
varying vec2 vUv;

float hash(float n) {
  return fract(sin(n) * 43758.5453);
}

float noise1(float x) {
  float i = floor(x);
  float f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash(i), hash(i + 1.0), f);
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  float a = atan(p.y, p.x) / 6.2831853 + 0.5;
  const float R = 0.26;
  float outside = step(R, d);
  // Streamers: two layers of angular noise, seamless around the circle.
  float k = a * 24.0;
  // At a = 1 the second term equals the first at a = 0, so there is no seam.
  float rays = mix(noise1(k + uTurn * 7.0), noise1(k - 24.0 + uTurn * 7.0), a) * 0.65
             + mix(noise1(k * 2.0 - uTurn * 11.0 + uTime * 0.04), noise1(k * 2.0 - 48.0 - uTurn * 11.0 + uTime * 0.04), a) * 0.35;
  float corona = exp(-max(d - R, 0.0) * (9.0 - uGlow * 4.0)) * outside * (0.25 + rays * 0.95);
  float limb = exp(-pow((d - R) / (0.006 + uGlow * 0.012), 2.0));
  float halo = exp(-d * 2.4);
  vec3 c = uColC * limb * (0.55 + uGlow * 0.9)
         + mix(uColB, uColC, 0.35) * corona * (0.28 + uGlow * 0.6)
         + uColA * halo * (0.06 + uGlow * 0.1);
  // The moon itself is black: it hides the halo behind it.
  c *= smoothstep(R - 0.006, R + 0.002, d);
  gl_FragColor = vec4(pow(c, vec3(2.2)), 1.0);
}
`;

const dustVertex = /* glsl */ `
uniform float uTime;
uniform float uHat;
uniform float uPixel;
attribute vec3 aSeed;
varying float vA;
void main() {
  vec3 p = position;
  p.x += sin(uTime * 0.05 + aSeed.x * 6.28) * 0.6;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.5 + 0.5 * sin(uTime * (0.6 + aSeed.y * 2.0) + aSeed.z * 30.0);
  vA = (0.15 + tw * 0.35) * (1.0 + uHat * 2.5 * step(0.8, aSeed.y));
  gl_PointSize = clamp((0.08 + aSeed.z * 0.12) * uPixel / -mv.z, 1.0, 6.0);
}
`;

const dustFragment = /* glsl */ `
varying float vA;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = dot(uv, uv);
  if (d > 1.0) discard;
  gl_FragColor = vec4(pow(vec3(0.94, 0.92, 0.88) * exp(-d * 3.0) * vA, vec3(2.2)), 1.0);
}
`;

export class TerrainWorld implements World {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.1, 300);
  readonly bloom = { strength: 0.64, radius: 0.55, threshold: 0.1 };

  private data = new Uint8Array(BANDS_N * ROWS);
  private tex: THREE.DataTexture;
  private head = 0;
  private acc = 0;
  private mesh: THREE.Mesh;
  private terrainMat: THREE.ShaderMaterial;
  private sunMat: THREE.ShaderMaterial;
  private dustMat: THREE.ShaderMaterial;
  private sun: THREE.Mesh;
  private dust: THREE.Points;
  private kick = 0;
  private lastKickCount = 0;
  private lastBeat = 0;
  private pendingBeat = 0;
  private beatData = new Uint8Array(ROWS);
  private beatTex = new THREE.DataTexture(this.beatData, 1, ROWS, THREE.RedFormat, THREE.UnsignedByteType);
  private fog = new THREE.Color(0x050607);
  private chord = new ChordWatch();
  private turn = 0;
  private turnTarget = 0;

  constructor(quality: Quality) {
    this.scene.background = this.fog;
    this.tex = new THREE.DataTexture(this.data, BANDS_N, ROWS, THREE.RedFormat, THREE.UnsignedByteType);
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.wrapT = THREE.RepeatWrapping;
    this.tex.needsUpdate = true;
    this.beatTex.wrapT = THREE.RepeatWrapping;
    this.beatTex.needsUpdate = true;

    this.terrainMat = new THREE.ShaderMaterial({
      uniforms: {
        uHist: { value: this.tex },
        uHead: { value: 0 },
        uRows: { value: ROWS },
        uAmp: { value: 7.5 },
        // sRGB components: the shader blends in sRGB and linearises at the end.
        uFog: { value: new THREE.Vector3(6 / 255, 5 / 255, 4 / 255) },
        uHaze: { value: 0.05 },
        uKick: { value: 0 },
        uPulse: { value: 0 },
        uImpact: { value: 0 },
        uBeats: { value: this.beatTex },
        uColA: { value: new THREE.Vector3(0.78, 0.3, 0.2) },
        uColB: { value: new THREE.Vector3(0.98, 0.62, 0.22) },
        uColC: { value: new THREE.Vector3(1.0, 0.92, 0.8) },
      },
      vertexShader: terrainVertex,
      fragmentShader: terrainFragment,
    });
    this.mesh = new THREE.Mesh(this.makeGeometry(quality), this.terrainMat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    this.sunMat = new THREE.ShaderMaterial({
      uniforms: {
        uGlow: { value: 0 },
        uTime: { value: 0 },
        uTurn: { value: 0 },
        uColA: { value: new THREE.Vector3(0.78, 0.3, 0.2) },
        uColB: { value: new THREE.Vector3(0.98, 0.62, 0.22) },
        uColC: { value: new THREE.Vector3(1.0, 0.92, 0.8) },
      },
      vertexShader: sunVertex,
      fragmentShader: sunFragment,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(46, 46), this.sunMat);
    this.sun.position.set(0, 6, -60);
    this.sun.renderOrder = -1;
    this.scene.add(this.sun);

    const n = 2400;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 160;
      pos[i * 3 + 1] = 4 + Math.random() * 50;
      pos[i * 3 + 2] = -80 + Math.random() * 90;
      seed[i * 3] = Math.random();
      seed[i * 3 + 1] = Math.random();
      seed[i * 3 + 2] = Math.random();
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uHat: { value: 0 }, uPixel: { value: 600 } },
      vertexShader: dustVertex,
      fragmentShader: dustFragment,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.dust = new THREE.Points(dg, this.dustMat);
    this.dust.renderOrder = -1;
    this.scene.add(this.dust);
  }

  private makeGeometry(q: Quality) {
    const g = new THREE.PlaneGeometry(46, 72, SEGS[q], ROWS - 1);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0, -6);
    return g;
  }

  setQuality(q: Quality) {
    const old = this.mesh.geometry;
    this.mesh.geometry = this.makeGeometry(q);
    old.dispose();
  }

  resize(w: number, h: number, pr: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dustMat.uniforms.uPixel.value = (h * pr) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  private pushRow(bands: Float32Array) {
    this.head = (this.head + 1) % ROWS;
    const o = this.head * BANDS_N;
    for (let j = 0; j < BANDS_N; j++) this.data[o + j] = Math.round(Math.pow(bands[j], 1.35) * 255);
    this.tex.needsUpdate = true;
    this.beatData[this.head] = this.pendingBeat;
    this.pendingBeat = 0;
    this.beatTex.needsUpdate = true;
  }

  update(s: Snapshot, dt: number, time: number) {
    const f = s.features;
    const m = s.music;
    if (m.ready && m.beatCount !== this.lastBeat) {
      this.pendingBeat = m.beatInBar === 0 ? 255 : 120;
    } else if (!m.ready && f.kickCount !== this.lastKickCount) {
      this.pendingBeat = 110;
    }
    this.lastBeat = m.beatCount;
    this.acc += dt;
    let pushed = 0;
    while (this.acc >= 1 / ROW_RATE && pushed < 4) {
      this.pushRow(s.bands);
      this.acc -= 1 / ROW_RATE;
      pushed++;
    }
    if (pushed === 4) this.acc = 0;

    if (f.kickCount !== this.lastKickCount) {
      this.lastKickCount = f.kickCount;
      this.kick = Math.max(this.kick, f.kick);
    }
    this.kick *= Math.exp(-dt * 6);

    const tu = this.terrainMat.uniforms;
    tu.uHead.value = this.head;
    tu.uKick.value = this.kick;
    tu.uPulse.value = f.pulse;
    tu.uAmp.value = 6.5 + f.energy * 2.5;
    tu.uImpact.value = m.impact;
    const su = this.sunMat.uniforms;
    for (const [name, c] of [['uColA', m.palette.a], ['uColB', m.palette.b], ['uColC', m.palette.c]] as const) {
      tu[name].value.set(...c);
      su[name].value.set(...c);
    }
    su.uGlow.value = f.bass * 0.45 + f.energy * 0.55 + this.kick * 0.35 + f.pulse * 0.25 + m.anticipation * 0.6 + m.impact * 0.8;
    su.uTime.value = time;
    // Each chord change turns the corona to a new pattern over about a second.
    if (this.chord.update(m, dt)) this.turnTarget += 1;
    this.turn += (this.turnTarget - this.turn) * (1 - Math.exp(-dt * 3));
    su.uTurn.value = this.turn;
    tu.uHaze.value = 0.04 + f.energy * 0.05 + Math.exp(-this.chord.age * 2) * 0.06 + m.impact * 0.06;
    this.sun.scale.setScalar(1 + f.sub * 0.05 + this.kick * 0.03);
    this.dustMat.uniforms.uTime.value = time;
    this.dustMat.uniforms.uHat.value = f.hat;

    const sway = Math.sin(time * 0.09) * 1.6;
    // During a build-up the camera climbs and pulls back; the drop lands it.
    this.camera.position.set(sway, 6.4 + this.kick * 0.35 + f.sub * 0.3 + m.anticipation * 5 - m.impact * 1.5, 31 + m.anticipation * 4);
    this.camera.lookAt(sway * 0.3, 2.2 - m.anticipation * 1.5, -24);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.terrainMat.dispose();
    this.sunMat.dispose();
    this.sun.geometry.dispose();
    this.dust.geometry.dispose();
    this.dustMat.dispose();
    this.tex.dispose();
    this.beatTex.dispose();
  }
}

import * as THREE from 'three';
import type { Music } from '../../analysis/types';
import type { Snapshot } from '../../audio/hub';
import type { Quality } from '../../store/player';
import { SIMPLEX_3D } from '../glsl';
import { ChordWatch, type World } from '../world';

const COUNTS: Record<Quality, number> = { low: 60000, medium: 140000, high: 260000, ultra: 520000 };

/**
 * The galaxy is always the spiral; each part of the song only varies it, so
 * the structure can be felt without the picture turning into something else:
 * a little gathered for the intro and outro, the open spiral for a verse,
 * faint rings within the spiral for a chorus, a gentle swell for a bridge.
 */
interface Form {
  compact: number;
  ring: number;
  wave: number;
}
const SPIRAL: Form = { compact: 0, ring: 0, wave: 0 };
const CLOUD: Form = { compact: 0.3, ring: 0, wave: 0 };
const RINGS: Form = { compact: 0, ring: 0.35, wave: 0 };
const WAVE: Form = { compact: 0, ring: 0, wave: 0.4 };

function formFor(m: Music): Form {
  const sec = m.ready ? m.section : null;
  if (!sec) return SPIRAL;
  switch (sec.name) {
    case 'Intro':
    case 'Outro':
      return CLOUD;
    case 'Verse':
      return SPIRAL;
    case 'Chorus':
    case 'Puncak':
      return RINGS;
    case 'Bridge':
      return WAVE;
    default:
      return [SPIRAL, RINGS, WAVE][(sec.label.charCodeAt(0) - 65) % 3] ?? SPIRAL;
  }
}

const vertex = /* glsl */ `
uniform float uTime;
uniform float uSub;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uEnergy;
uniform float uBright;
uniform float uKick;
uniform float uKickAge;
uniform float uHat;
uniform float uSize;
uniform float uPixel;
uniform float uSpin;
uniform float uAnticip;
uniform float uImpact;
uniform float uBeat;
uniform float uPulse;
uniform float uSpace;
uniform float uWidth;
uniform float uCompact;
uniform float uRing;
uniform float uWave;
uniform float uChordAge;
uniform float uFocus;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColC;
attribute vec4 aSeed;
varying vec3 vColor;
varying float vAlpha;

${SIMPLEX_3D}

void main() {
  // Spiral galaxy: three arms, dense warm core, cool sparse rim.
  float r = pow(aSeed.x, 0.55) * 14.0 + 0.4;
  // Section forms (see formFor): gather in, snap to rings, or roll as a wave.
  r *= 1.0 - 0.42 * uCompact;
  float ringR = floor(r / 1.75 + 0.5) * 1.75;
  r = mix(r, ringR + (aSeed.y - 0.5) * 0.3, uRing * 0.85);
  float arm = floor(aSeed.w * 3.0);
  float scatter = (aSeed.y - 0.5) * (0.85 + r * 0.07) * (1.0 + uRing * 2.4);
  float ang = arm * 2.0943951 + r * 0.42 * (1.0 - uRing * 0.6) + scatter - uSpin * (0.035 + 0.45 / (r + 2.0));
  float thick = (0.25 + 2.4 * exp(-r * 0.3)) * (1.0 + uCompact * 0.9) * (1.0 - uRing * 0.55);
  vec3 p = vec3(cos(ang) * r, (aSeed.z - 0.5) * thick, sin(ang) * r);
  p.y += sin(r * 0.7 - uTime * 0.9 + ang) * 1.5 * uWave;

  // Mids stir the gas: flow-field displacement grows with midrange energy.
  float nt = uTime * 0.11;
  vec3 q = p * 0.17;
  vec3 n = vec3(
    snoise(q + vec3(nt, 0.0, 0.0)),
    snoise(q + vec3(19.1, nt, 3.7)),
    snoise(q + vec3(-7.3, 4.1, nt))
  );
  p += n * (0.3 + uMid * 0.7 + uEnergy * 0.25);

  // Bass is mass: the whole disc breathes and thickens.
  // Transients (pulse) make it breathe on every hit, even in a dense master.
  p.xz *= 1.0 + uSub * 0.16 + uBass * 0.08 + uBeat * 0.03 + uPulse * 0.05;
  p.y *= 1.0 + uBass * 1.3;

  // Build-up before a louder section: the galaxy draws in and flattens,
  // then bursts outward on impact.
  p.xz *= 1.0 - 0.24 * uAnticip + 0.32 * uImpact;
  // Stereo width stretches the disc sideways; a narrow, mono mix pinches it.
  p.x *= 0.75 + uWidth * 0.5;
  p.y *= 1.0 - 0.55 * uAnticip + 0.8 * uImpact;

  // Kick: a shock ring racing outward from the core.
  float shockR = uKickAge * 20.0;
  float shock = exp(-pow((r - shockR) / 1.5, 2.0)) * exp(-uKickAge * 2.2) * uKick;
  p.y += shock * 1.5 * sign(aSeed.z - 0.5 + 0.0001);
  p.xz *= 1.0 + shock * 0.07;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // Depth of field: particles away from the focus distance grow soft and dim.
  float blur = clamp(abs(-mv.z - uFocus) / uFocus, 0.0, 1.0);

  // Hi-hats light up a sparse set of particles like sparks.
  float sparkSel = step(0.955, fract(aSeed.w * 13.37 + aSeed.x * 7.1));
  float spark = sparkSel * uHat;
  // Reverb blooms each particle into haze.
  float size = uSize * (0.55 + aSeed.z * 0.9) * (1.0 + spark * 3.0 + shock * 1.4) * (1.0 + uSpace * 1.2);
  size *= 1.0 + blur * 1.8;
  gl_PointSize = clamp(size * uPixel / -mv.z, 1.0, 28.0);

  float core = exp(-r * 0.24);
  vec3 cool = vec3(0.62, 0.70, 0.86);
  vec3 c = mix(uColA, uColB, smoothstep(0.02, 0.5, core + uBright * 0.25));
  c = mix(c, uColC, core * 0.85);
  // Bright, airy mixes tint the rim slightly cooler.
  c = mix(c, cool, (1.0 - core) * uBright * 0.35 * aSeed.y);
  c = mix(c, uColC, spark);
  // A chord change sends a band of light from the core to the rim.
  float chord = exp(-pow((r - uChordAge * 15.0) / 1.3, 2.0)) * exp(-uChordAge * 1.5);
  c = mix(c, uColC, chord * 0.7);
  vColor = c * (0.13 + uEnergy * 0.09 + uPulse * 0.07 + core * 0.2 + shock * 0.45 + spark * 1.1 + chord * 0.5) * (1.0 + uImpact * 0.9 + uAnticip * 0.25) / (1.0 + uSpace * 1.1);
  vColor /= pow(1.0 + blur * 1.8, 1.5);
  // Gathered in, the particles overlap far more: dim them so the cloud keeps its detail.
  vColor /= 1.0 + uCompact * 1.6;
  vAlpha = 0.5 + 0.5 * core;
}
`;

const fragment = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = dot(uv, uv);
  if (d > 1.0) discard;
  float a = exp(-d * 4.0) * vAlpha;
  gl_FragColor = vec4(vColor * a, a);
}
`;

export class NebulaWorld implements World {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  readonly bloom = { strength: 0.8, radius: 0.6, threshold: 0.12 };

  private points: THREE.Points;
  private material: THREE.ShaderMaterial;
  private uniforms = {
    uTime: { value: 0 },
    uSub: { value: 0 },
    uBass: { value: 0 },
    uMid: { value: 0 },
    uHigh: { value: 0 },
    uEnergy: { value: 0 },
    uBright: { value: 0 },
    uKick: { value: 0 },
    uKickAge: { value: 10 },
    uHat: { value: 0 },
    uSize: { value: 0.075 },
    uPixel: { value: 600 },
    uSpin: { value: 0 },
    uAnticip: { value: 0 },
    uImpact: { value: 0 },
    uBeat: { value: 0 },
    uPulse: { value: 0 },
    uSpace: { value: 0 },
    uWidth: { value: 0.5 },
    uCompact: { value: 0 },
    uRing: { value: 0 },
    uWave: { value: 0 },
    uChordAge: { value: 10 },
    uFocus: { value: 27 },
    uColA: { value: new THREE.Vector3(0.78, 0.3, 0.2) },
    uColB: { value: new THREE.Vector3(0.98, 0.62, 0.22) },
    uColC: { value: new THREE.Vector3(1.0, 0.92, 0.8) },
  };
  private lastKickCount = 0;
  private lastDownbeat = 0;
  private orbit = 0;
  private shake = 0;
  private form: Form = { ...SPIRAL };
  private chord = new ChordWatch();

  constructor(quality: Quality) {
    this.scene.background = new THREE.Color(0x040506);
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vertex,
      fragmentShader: fragment,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(this.makeGeometry(COUNTS[quality]), this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.camera.position.set(0, 9, 26);
  }

  private makeGeometry(count: number) {
    const g = new THREE.BufferGeometry();
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    // Vertical seed follows a rough gaussian so the disc has a soft edge.
    for (let i = 0; i < count; i++) {
      const u = (Math.random() + Math.random() + Math.random()) / 3;
      seeds[i * 4 + 2] = u;
    }
    g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    return g;
  }

  setQuality(q: Quality) {
    const old = this.points.geometry;
    this.points.geometry = this.makeGeometry(COUNTS[q]);
    old.dispose();
  }

  resize(w: number, h: number, pr: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Pixels per world unit at distance 1, so particle sizes are in world units.
    this.uniforms.uPixel.value = (h * pr) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  update(s: Snapshot, dt: number, time: number) {
    const f = s.features;
    const m = s.music;
    const u = this.uniforms;
    u.uTime.value = time;
    u.uSpin.value += dt * (1 + m.anticipation * 3 + m.impact * 2);
    u.uAnticip.value = m.anticipation;
    u.uImpact.value = m.impact;
    u.uBeat.value = m.beatPulse;
    u.uPulse.value = f.pulse;
    u.uSpace.value = s.fx.space;
    u.uWidth.value = s.fx.width;
    u.uColA.value.set(...m.palette.a);
    u.uColB.value.set(...m.palette.b);
    u.uColC.value.set(...m.palette.c);
    // Ease toward the current section's variation over about three seconds.
    const target = formFor(m);
    const k = 1 - Math.exp(-dt * 0.9);
    this.form.compact += (target.compact - this.form.compact) * k;
    this.form.ring += (target.ring - this.form.ring) * k;
    this.form.wave += (target.wave - this.form.wave) * k;
    u.uCompact.value = this.form.compact;
    u.uRing.value = this.form.ring;
    u.uWave.value = this.form.wave;
    this.chord.update(m, dt);
    u.uChordAge.value = this.chord.age;
    u.uSub.value = f.sub;
    u.uBass.value = f.bass;
    u.uMid.value = (f.lowMid + f.mid) * 0.5;
    u.uHigh.value = (f.presence + f.air) * 0.5;
    u.uEnergy.value = f.energy;
    u.uBright.value = f.brightness;
    u.uHat.value = f.hat;
    if (f.kickCount !== this.lastKickCount) {
      this.lastKickCount = f.kickCount;
      u.uKickAge.value = 0;
      u.uKick.value = Math.max(0.5, f.kick);
      this.shake = Math.max(this.shake, f.kick);
    } else if (m.ready && m.downbeatCount !== this.lastDownbeat) {
      // With a beat grid, every bar's downbeat also sends a ring outward.
      u.uKickAge.value = 0;
      u.uKick.value = 0.6;
    } else {
      u.uKickAge.value += dt;
    }
    this.lastDownbeat = m.downbeatCount;

    // Slow orbit; the camera leans in as the music gets louder.
    this.orbit += dt * (0.04 + f.energy * 0.05);
    this.shake *= Math.exp(-dt * 10);
    const dist = 27 - f.energy * 2.5 - f.sub * 1 + m.anticipation * 7 - m.impact * 4;
    const height = 8.5 + Math.sin(time * 0.07) * 2.5 + m.anticipation * 5;
    const jitter = this.shake * 0.25;
    this.camera.position.set(
      Math.sin(this.orbit) * dist + (Math.random() - 0.5) * jitter,
      height + (Math.random() - 0.5) * jitter,
      Math.cos(this.orbit) * dist,
    );
    this.camera.lookAt(0, 0, 0);
    u.uFocus.value = Math.hypot(dist, height);
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

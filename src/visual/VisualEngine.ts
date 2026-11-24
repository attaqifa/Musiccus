import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { Snapshot } from '../audio/hub';
import type { Quality, WorldId } from '../store/player';
import { lyricVeil } from './veil';
import type { BloomSettings, World } from './world';
import { AuroraWorld } from './worlds/aurora';
import { NebulaWorld } from './worlds/nebula';
import { TerrainWorld } from './worlds/terrain';

const PIXEL_RATIO: Record<Quality, number> = { low: 0.75, medium: 1, high: 1.5, ultra: 2 };
/** Seconds a world change takes; both worlds keep moving while they blend. */
const CROSSFADE = 0.8;

/** Mixes the outgoing world (tPrev) into the incoming one, before bloom. */
const BlendShader = {
  uniforms: { tDiffuse: { value: null }, tPrev: { value: null }, uMix: { value: 1 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tPrev;
    uniform float uMix;
    varying vec2 vUv;
    void main() {
      gl_FragColor = mix(texture2D(tPrev, vUv), texture2D(tDiffuse, vUv), uMix);
    }
  `,
};

/**
 * Quiets the light behind the lyrics, after bloom and before tone mapping: a
 * soft-edged box around the text where bright light is pulled down far more
 * than dark, so the glow behind the words calms while the night around them
 * stays as it is. No visible box, no edge.
 */
const VeilShader = {
  uniforms: {
    tDiffuse: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uBox: { value: new THREE.Vector4() },
    uFeather: { value: 80 },
    uAmount: { value: 0 },
  },
  vertexShader: BlendShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform vec4 uBox;
    uniform float uFeather;
    uniform float uAmount;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 q = abs(vUv * uRes - uBox.xy) - uBox.zw;
      float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
      float m = (1.0 - smoothstep(-uFeather * 0.3, uFeather, d)) * uAmount;
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb *= mix(1.0, 0.8 / (1.0 + l * 1.6), m);
      gl_FragColor = c;
    }
  `,
};

const smooth = (x: number) => x * x * (3 - 2 * x);

export class VisualEngine {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloomPass: UnrealBloomPass;
  private blendPass: ShaderPass;
  private veilPass: ShaderPass;
  /** The veil as drawn: eased toward the lyrics' box so line changes glide. */
  private veil = { x: 0, y: 0, hw: 0, hh: 0, amount: 0 };
  private prevTarget: THREE.WebGLRenderTarget;
  private worlds = new Map<WorldId, World>();
  private world: World;
  /** The world being faded out, and how far the fade has come (0..1). */
  private prev: World | null = null;
  private blend = 1;
  private quality: Quality;
  private time = 0;
  private width = 1;
  private height = 1;
  private ro: ResizeObserver;

  constructor(private canvas: HTMLCanvasElement, worldId: WorldId, quality: Quality) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.world = this.getWorld(worldId);
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.world.scene, this.world.camera);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 1, 0.6, 0.1);
    this.blendPass = new ShaderPass(BlendShader);
    this.blendPass.enabled = false;
    this.veilPass = new ShaderPass(VeilShader);
    this.veilPass.enabled = false;
    this.prevTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.blendPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.veilPass);
    this.composer.addPass(new OutputPass());
    this.applyBloom();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
  }

  private getWorld(id: WorldId): World {
    let w = this.worlds.get(id);
    if (!w) {
      w =
        id === 'terrain'
          ? new TerrainWorld(this.quality)
          : id === 'aurora'
            ? new AuroraWorld()
            : new NebulaWorld(this.quality);
      w.resize(this.width, this.height, this.pixelRatio());
      this.worlds.set(id, w);
    }
    return w;
  }

  private pixelRatio() {
    return Math.min(window.devicePixelRatio || 1, PIXEL_RATIO[this.quality]);
  }

  /** Bloom of the current world, eased from the outgoing world's during a crossfade. */
  private currentBloom(): BloomSettings {
    const b = this.world.bloom;
    if (!this.prev) return b;
    const p = this.prev.bloom;
    const t = smooth(this.blend);
    return {
      strength: p.strength + (b.strength - p.strength) * t,
      radius: p.radius + (b.radius - p.radius) * t,
      threshold: p.threshold + (b.threshold - p.threshold) * t,
    };
  }

  private applyBloom() {
    const b = this.currentBloom();
    this.bloomPass.strength = b.strength;
    this.bloomPass.radius = b.radius;
    this.bloomPass.threshold = b.threshold;
  }

  /** Switches worlds with a crossfade; both keep reacting to the music while they blend. */
  setWorld(id: WorldId) {
    const next = this.getWorld(id);
    if (next === this.world) return;
    this.prev = this.world;
    this.blend = 0;
    this.world = next;
    this.renderPass.scene = next.scene;
    this.renderPass.camera = next.camera;
    this.applyBloom();
  }

  setQuality(q: Quality) {
    if (q === this.quality) return;
    this.quality = q;
    for (const w of this.worlds.values()) w.setQuality(q);
    this.resize();
  }

  private resize() {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.width = w;
    this.height = h;
    const pr = this.pixelRatio();
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.prevTarget.setSize(Math.round(w * pr), Math.round(h * pr));
    for (const world of this.worlds.values()) world.resize(w, h, pr);
  }

  frame(s: Snapshot) {
    const dt = s.dt;
    this.time += dt;
    this.world.update(s, dt, this.time);
    if (this.prev) {
      this.blend = Math.min(1, this.blend + s.dt / CROSSFADE);
      if (this.blend >= 1) {
        this.prev = null;
        this.blendPass.enabled = false;
      } else {
        // The outgoing world renders on its own and is mixed in before bloom.
        this.prev.update(s, dt, this.time);
        this.renderer.setRenderTarget(this.prevTarget);
        this.renderer.render(this.prev.scene, this.prev.camera);
        this.renderer.setRenderTarget(null);
        this.blendPass.uniforms.tPrev.value = this.prevTarget.texture;
        this.blendPass.uniforms.uMix.value = smooth(this.blend);
        this.blendPass.enabled = true;
      }
    }
    // Sound effects reach the picture: reverb widens the glow like haze,
    // saturation makes it hotter.
    const b = this.currentBloom();
    this.bloomPass.strength = b.strength * (1 + s.fx.drive * 0.6 + s.fx.space * 0.35);
    this.bloomPass.radius = Math.min(1, b.radius + s.fx.space * 0.35);
    this.bloomPass.threshold = Math.max(0, b.threshold - s.fx.space * 0.06);
    this.updateVeil(dt);
    this.composer.render(dt);
  }

  /** Follows the lyrics' box, fading in when they appear and out when they go. */
  private updateVeil(dt: number) {
    const box = lyricVeil.box;
    const v = this.veil;
    if (box) {
      // Appearing from nothing: start where the words are instead of sliding in.
      const k = v.amount < 0.02 ? 1 : 1 - Math.exp(-dt * 8);
      v.x += (box.x - v.x) * k;
      v.y += (box.y - v.y) * k;
      v.hw += (box.hw - v.hw) * k;
      v.hh += (box.hh - v.hh) * k;
    }
    v.amount += ((box?.strength ?? 0) - v.amount) * (1 - Math.exp(-dt * 4));
    if (!box && v.amount < 0.004) v.amount = 0;
    this.veilPass.enabled = v.amount > 0;
    if (!this.veilPass.enabled) return;
    const u = this.veilPass.uniforms;
    u.uRes.value.set(this.width, this.height);
    u.uBox.value.set(v.x, this.height - v.y, v.hw, v.hh);
    u.uFeather.value = Math.min(120, Math.max(48, v.hh * 0.8));
    u.uAmount.value = v.amount;
  }

  dispose() {
    this.ro.disconnect();
    for (const w of this.worlds.values()) w.dispose();
    this.composer.dispose();
    this.prevTarget.dispose();
    this.blendPass.dispose();
    this.veilPass.dispose();
    this.renderer.dispose();
  }
}

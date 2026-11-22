import * as THREE from 'three';
import type { Music } from '../analysis/types';
import type { Snapshot } from '../audio/hub';
import type { Quality } from '../store/player';

export interface BloomSettings {
  strength: number;
  radius: number;
  threshold: number;
}

export interface World {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  readonly bloom: BloomSettings;
  update(s: Snapshot, dt: number, time: number): void;
  resize(width: number, height: number, pixelRatio: number): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** A world drawn entirely by one full-screen fragment shader. */
export abstract class ShaderWorld implements World {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  abstract readonly bloom: BloomSettings;
  protected material: THREE.ShaderMaterial;
  private quad: THREE.Mesh;

  constructor(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
    this.material = new THREE.ShaderMaterial({
      uniforms: { uAspect: { value: 1 }, uTime: { value: 0 }, ...uniforms },
      vertexShader: QUAD_VERTEX,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  protected get u() {
    return this.material.uniforms;
  }

  resize(width: number, height: number) {
    this.u.uAspect.value = width / Math.max(1, height);
  }

  setQuality() {
    /* resolution is handled by the renderer's pixel ratio */
  }

  abstract update(s: Snapshot, dt: number, time: number): void;

  dispose() {
    this.quad.geometry.dispose();
    this.material.dispose();
  }
}

export const vec3 = (c: readonly [number, number, number]) => new THREE.Vector3(c[0], c[1], c[2]);

/**
 * Tracks chord changes so every world can show one: `age` is the time since
 * the chord last changed (large while there is no analysis). The first chord
 * a world sees only sets the baseline, so opening a world mid-song does not
 * fire a change.
 */
export class ChordWatch {
  age = 10;
  private key = '';

  /** Returns true on the frame the chord changes. */
  update(m: Music, dt: number): boolean {
    const key = m.ready && m.chord ? `${m.chord.root}${m.chord.quality}` : '';
    if (key && key !== this.key) {
      const first = this.key === '';
      this.key = key;
      if (!first) {
        this.age = 0;
        return true;
      }
    }
    this.age += dt;
    return false;
  }
}

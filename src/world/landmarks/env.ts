// Shared build environment for the landmark builders: context, materials, collider bookkeeping
// and one canvas "sign atlas" (lettering, plaques, clock dials, mosaic) = one draw-call material.
import {
  BoxGeometry, CanvasTexture, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace, Vector3, type BufferGeometry, type Object3D,
} from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { G } from '../../core/physics';
import { CURB } from '../../core/layout';
import type { Bucket } from './kit';
import type { BuildContext } from '../../core/types';
import type { LandmarkMaterials } from './materials';
import type { PlantCells } from './plants';

export interface Landmark {
  root: Object3D;
  update?(dt: number, time: number): void;
  dispose?(): void;
}

export class Env {
  readonly colliders: RAPIER.Collider[] = [];
  constructor(readonly ctx: BuildContext, readonly mats: LandmarkMaterials, readonly signs: SignAtlas, readonly plants: PlantCells) {}

  /** Static box collider: centre + half extents (world), optional Y rotation. */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, rotY = 0, member: number = G.STATIC): void {
    this.colliders.push(this.ctx.physics.addBox(new Vector3(cx, cy, cz), new Vector3(hx, hy, hz), rotY, member));
  }

  /** Static box collider from min/max corners (axis aligned). */
  aabb(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, member: number = G.STATIC): void {
    this.box((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2, 0, member);
  }

  cylinder(x: number, y0: number, z: number, r: number, h: number, member: number = G.STATIC): void {
    this.colliders.push(this.ctx.physics.addCylinder(new Vector3(x, y0 + h / 2, z), r, h / 2, member));
  }

  /**
   * Paved ground over a footprint (the street module paves only outside the landmark slots):
   * a slab from y = 0 up to just under the curb height, in the street's plaza paving (same texture
   * and UV frame, so the joint at the slot edge is continuous), plus a walkable collider.
   */
  ground(b: Bucket, x0: number, x1: number, z0: number, z1: number, collide = true): void {
    // top 1 cm under the curb so it never z-fights paving that may overlap the slot edges
    b.add(this.mats.paving, new BoxGeometry(x1 - x0, CURB, z1 - z0).translate((x0 + x1) / 2, CURB / 2 - 0.01, (z0 + z1) / 2));
    if (collide) this.aabb(x0, -0.5, z0, x1, CURB, z1);
  }

  dispose(): void {
    for (const c of this.colliders) this.ctx.physics.removeCollider(c);
    this.colliders.length = 0;
  }
}

export interface Region { u0: number; v0: number; u1: number; v1: number }

/** Sets `c.font` to `weight size family`, shrunk (never grown) so `text` fits in `maxW` px. */
export function fitFont(c: CanvasRenderingContext2D, text: string, maxW: number, weight: number, size: number, family = 'Cairo'): void {
  c.font = `${weight} ${size}px ${family}`;
  const w = c.measureText(text).width;
  if (w > maxW) c.font = `${weight} ${size * (maxW / w)}px ${family}`;
}

/**
 * Canvas atlas. `draw(w, h, fn)` reserves a w×h px cell (skyline packing), lets `fn` paint colour
 * into it (and optionally the half-resolution PBR cell, same coordinates: G roughness, B metalness),
 * and returns its UVs.
 * Paint with transparent background for cut-out lettering (alphaTest). Call `finish()` once.
 */
export class SignAtlas {
  readonly size = 2048;
  readonly color: HTMLCanvasElement;
  readonly pbr: HTMLCanvasElement;
  readonly material: MeshStandardMaterial;
  /** Same atlas, self-lit: lit shop interiors seen through glazing. */
  readonly glow: MeshStandardMaterial;
  private cx: CanvasRenderingContext2D;
  private px: CanvasRenderingContext2D;
  /** Skyline: lowest free y over each x span (cells are placed as high up as they fit). */
  private sky: { x: number; y: number; w: number }[] = [{ x: 0, y: 0, w: 2048 }];
  private tex: CanvasTexture[] = [];

  constructor() {
    this.color = document.createElement('canvas');
    this.pbr = document.createElement('canvas');
    this.color.width = this.color.height = this.size;
    this.pbr.width = this.pbr.height = this.size / 2; // roughness/metal need far less resolution
    this.cx = this.color.getContext('2d')!;
    this.px = this.pbr.getContext('2d')!;
    this.px.fillStyle = 'rgb(0, 200, 0)'; // default: rough, non-metal
    this.px.fillRect(0, 0, this.size, this.size);
    this.material = new MeshStandardMaterial({ name: 'signs', transparent: false, alphaTest: 0.5, roughness: 1, metalness: 1 });
    this.glow = new MeshStandardMaterial({ name: 'signsGlow', roughness: 0.9, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0.75 });
  }

  draw(w: number, h: number, fn: (c: CanvasRenderingContext2D, p: CanvasRenderingContext2D, w: number, h: number) => void): Region {
    const pad = 4;
    const [x, y] = this.place(w + pad, h + pad);
    for (const [c, k] of [[this.cx, 1], [this.px, 0.5]] as const) {
      c.save(); c.scale(k, k); c.translate(x, y); c.beginPath(); c.rect(0, 0, w, h); c.clip();
    }
    fn(this.cx, this.px, w, h);
    this.cx.restore(); this.px.restore();
    // half-texel inset against bleeding
    const s = this.size;
    return { u0: (x + 0.5) / s, u1: (x + w - 0.5) / s, v0: 1 - (y + h - 0.5) / s, v1: 1 - (y + 0.5) / s };
  }

  /** Skyline bottom-left placement: the x (at a skyline step) where the cell sits highest. */
  private place(w: number, h: number): [number, number] {
    const S = this.size, sky = this.sky;
    let bx = -1, by = Infinity;
    for (let i = 0; i < sky.length; i++) {
      const x = sky[i].x;
      if (x + w > S) break;
      let y = 0;
      for (let j = i; j < sky.length && sky[j].x < x + w; j++) y = Math.max(y, sky[j].y);
      if (y + h <= S && y < by) { by = y; bx = x; }
    }
    if (bx < 0) throw new Error('landmarks: sign atlas full');
    const x1 = bx + w, next: { x: number; y: number; w: number }[] = [];
    for (const g of sky) {
      const g1 = g.x + g.w;
      if (g1 <= bx || g.x >= x1) { next.push(g); continue; }
      if (g.x < bx) next.push({ x: g.x, y: g.y, w: bx - g.x });
      if (g1 > x1) next.push({ x: x1, y: g.y, w: g1 - x1 });
    }
    next.push({ x: bx, y: by + h, w });
    next.sort((a, b) => a.x - b.x);
    this.sky = [];
    for (const g of next) {
      const l = this.sky[this.sky.length - 1];
      if (l && l.y === g.y && l.x + l.w === g.x) l.w += g.w;
      else this.sky.push({ ...g });
    }
    return [bx, by];
  }

  /** Plane w×h (meters) in XY facing +Z, base-centred, UV-mapped to `r`. */
  plane(r: Region, w: number, h: number): BufferGeometry {
    const g = new PlaneGeometry(w, h).translate(0, h / 2, 0);
    remapUV(g, r);
    return g;
  }

  /** Like `plane`, but the atlas cell is read rotated 90° (cell's left edge → plane's top), so a
   *  wide cell can dress a tall sign (e.g. a vertical blade painted as a horizontal strip). */
  planeRotated(r: Region, w: number, h: number): BufferGeometry {
    const g = new PlaneGeometry(w, h).translate(0, h / 2, 0);
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i), v = uv.getY(i);
      uv.setXY(i, r.u0 + (1 - v) * (r.u1 - r.u0), r.v0 + u * (r.v1 - r.v0));
    }
    return g;
  }

  finish(): void {
    const map = new CanvasTexture(this.color);
    map.colorSpace = SRGBColorSpace;
    map.anisotropy = 8;
    const pbr = new CanvasTexture(this.pbr);
    pbr.anisotropy = 8;
    this.material.map = map;
    this.material.roughnessMap = pbr;
    this.material.metalnessMap = pbr;
    this.material.needsUpdate = true;
    this.glow.map = map;
    this.glow.emissiveMap = map;
    this.glow.needsUpdate = true;
    this.tex = [map, pbr];
  }

  dispose(): void {
    this.tex.forEach((t) => t.dispose());
    this.material.dispose();
    this.glow.dispose();
  }
}

/** Maps a geometry's existing 0..1 UVs into an atlas region. */
export function remapUV(g: BufferGeometry, r: Region): void {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, r.u0 + uv.getX(i) * (r.u1 - r.u0), r.v0 + uv.getY(i) * (r.v1 - r.v0));
  }
  uv.needsUpdate = true;
}

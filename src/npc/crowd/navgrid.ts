// Walkability for pedestrians and pigeons, rasterised once from the physics world: every STATIC /
// LOW_PROP collider that reaches into the body-height band (trunks, kiosks, benches, bins, café
// tables and chairs, planters, bollards, facades, fences, statue lawns) is stamped into a 0.25 m
// grid, the roads are blocked except at the crossings, and a chamfer distance transform turns it
// into clearance (m to the nearest obstacle). Queries are O(1) lookups.
import type { Collider } from '@dimforge/rapier3d-compat';
import { G, type Physics } from '../../core/physics';
import { BINS, CROSS_STREETS, CURB, ROAD_X, Z } from '../../core/layout';
import { CROSSINGS } from '../traffic/crossings';

const CELL = 0.25;
const X0 = -316, X1 = 316, Z0 = -62, Z1 = 62;
const W = Math.round((X1 - X0) / CELL), H = Math.round((Z1 - Z0) / CELL);
const BAND_LO = CURB + 0.12, BAND_HI = 1.9; // body height band that blocks walking

export class NavGrid {
  /** Clearance in metres per cell (0 inside obstacles). */
  private readonly clear = new Float32Array(W * H);

  constructor(physics: Physics) {
    const block = new Uint8Array(W * H);
    const stampRect = (x0: number, x1: number, z0: number, z1: number) => {
      const i0 = Math.max(0, Math.floor((x0 - X0) / CELL)), i1 = Math.min(W - 1, Math.floor((x1 - X0) / CELL));
      const j0 = Math.max(0, Math.floor((z0 - Z0) / CELL)), j1 = Math.min(H - 1, Math.floor((z1 - Z0) / CELL));
      for (let j = j0; j <= j1; j++) block.fill(1, j * W + i0, j * W + i1 + 1);
    };
    const clearRect = (x0: number, x1: number, z0: number, z1: number) => {
      const i0 = Math.max(0, Math.ceil((x0 - X0) / CELL)), i1 = Math.min(W - 1, Math.floor((x1 - X0) / CELL) - 1);
      const j0 = Math.max(0, Math.ceil((z0 - Z0) / CELL)), j1 = Math.min(H - 1, Math.floor((z1 - Z0) / CELL) - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (block[j * W + i] === 2) block[j * W + i] = 0;
    };
    // roads (value 2 so the crossings can reopen them without reopening real obstacles)
    const road = (x0: number, x1: number, z0: number, z1: number) => {
      const i0 = Math.max(0, Math.floor((x0 - X0) / CELL)), i1 = Math.min(W - 1, Math.ceil((x1 - X0) / CELL) - 1);
      const j0 = Math.max(0, Math.floor((z0 - Z0) / CELL)), j1 = Math.min(H - 1, Math.ceil((z1 - Z0) / CELL) - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (!block[j * W + i]) block[j * W + i] = 2;
    };
    road(ROAD_X.min, ROAD_X.max, Z.northRoadOuter, Z.northRoadInner);
    road(ROAD_X.min, ROAD_X.max, Z.southRoadInner, Z.southRoadOuter);
    for (const c of CROSS_STREETS) {
      road(c.x - 4, c.x + 4, Z0, Z.northRoadOuter);
      road(c.x - 4, c.x + 4, Z.southRoadOuter, Z1);
    }
    for (const c of CROSSINGS) clearRect(c.x0, c.x1, c.z0, c.z1);

    physics.world.forEachCollider((c: Collider) => {
      if (c.isSensor() || c.parent()) return; // bodies (player, NPCs, taxis, litter) are not scenery
      const member = c.collisionGroups() >>> 16;
      if (!(member & (G.STATIC | G.LOW_PROP))) return;
      const t = c.translation(), q = c.rotation();
      const he = c.halfExtents();
      if (he) {
        // Y-rotated boxes (all the world builders make): yaw from the quaternion
        const yaw = 2 * Math.atan2(q.y, q.w);
        if (t.y + he.y < BAND_LO || t.y - he.y > BAND_HI) return;
        const cs = Math.cos(yaw), sn = Math.sin(yaw);
        const ex = Math.abs(cs) * he.x + Math.abs(sn) * he.z, ez = Math.abs(sn) * he.x + Math.abs(cs) * he.z;
        if (Math.abs(yaw) < 1e-4) { stampRect(t.x - he.x, t.x + he.x, t.z - he.z, t.z + he.z); return; }
        const i0 = Math.max(0, Math.floor((t.x - ex - X0) / CELL)), i1 = Math.min(W - 1, Math.floor((t.x + ex - X0) / CELL));
        const j0 = Math.max(0, Math.floor((t.z - ez - Z0) / CELL)), j1 = Math.min(H - 1, Math.floor((t.z + ez - Z0) / CELL));
        for (let j = j0; j <= j1; j++) {
          const dz = Z0 + (j + 0.5) * CELL - t.z;
          for (let i = i0; i <= i1; i++) {
            const dx = X0 + (i + 0.5) * CELL - t.x;
            // three's Y rotation: local = R(-yaw) · d
            const lx = cs * dx - sn * dz, lz = sn * dx + cs * dz;
            if (Math.abs(lx) <= he.x + CELL * 0.5 && Math.abs(lz) <= he.z + CELL * 0.5) block[j * W + i] = 1;
          }
        }
        return;
      }
      const r = c.radius();
      if (!(r > 0)) return;
      const hh = c.halfHeight() || r; // cylinder (upright) or ball
      if (t.y + hh < BAND_LO || t.y - hh > BAND_HI) return;
      const i0 = Math.max(0, Math.floor((t.x - r - X0) / CELL)), i1 = Math.min(W - 1, Math.floor((t.x + r - X0) / CELL));
      const j0 = Math.max(0, Math.floor((t.z - r - Z0) / CELL)), j1 = Math.min(H - 1, Math.floor((t.z + r - Z0) / CELL));
      const rr = (r + CELL * 0.5) ** 2;
      for (let j = j0; j <= j1; j++) {
        const dz = Z0 + (j + 0.5) * CELL - t.z;
        for (let i = i0; i <= i1; i++) {
          const dx = X0 + (i + 0.5) * CELL - t.x;
          if (dx * dx + dz * dz <= rr) block[j * W + i] = 1;
        }
      }
    });
    // recycling bins are placed by gameplay (maybe after us): keep their spots blocked anyway
    for (const b of BINS) stampRect(b.x - 0.35, b.x + 0.35, b.z - 0.35, b.z + 0.35);

    // chamfer distance transform (orthogonal CELL, diagonal CELL·√2)
    const d = this.clear, D = CELL * Math.SQRT2, BIG = 1e4;
    for (let k = 0; k < d.length; k++) d[k] = block[k] ? 0 : BIG;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i;
      let v = d[k];
      if (v === 0) continue;
      if (i > 0) v = Math.min(v, d[k - 1] + CELL);
      if (j > 0) {
        v = Math.min(v, d[k - W] + CELL);
        if (i > 0) v = Math.min(v, d[k - W - 1] + D);
        if (i < W - 1) v = Math.min(v, d[k - W + 1] + D);
      }
      d[k] = v;
    }
    for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
      const k = j * W + i;
      let v = d[k];
      if (v === 0) continue;
      if (i < W - 1) v = Math.min(v, d[k + 1] + CELL);
      if (j < H - 1) {
        v = Math.min(v, d[k + W] + CELL);
        if (i < W - 1) v = Math.min(v, d[k + W + 1] + D);
        if (i > 0) v = Math.min(v, d[k + W - 1] + D);
      }
      d[k] = v;
    }
    // cells are blocked from their centre: clearance measured from a cell's edge, not centre
    for (let k = 0; k < d.length; k++) if (d[k] > 0) d[k] = Math.max(0, d[k] - CELL * 0.5);
  }

  /** Metres from (x, z) to the nearest obstacle / road edge. 0 outside the grid. */
  clearance(x: number, z: number): number {
    const i = Math.floor((x - X0) / CELL), j = Math.floor((z - Z0) / CELL);
    if (i < 0 || j < 0 || i >= W || j >= H) return 0;
    return this.clear[j * W + i];
  }

  free(x: number, z: number, r: number): boolean {
    return this.clearance(x, z) >= r;
  }
}

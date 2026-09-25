// Accessories: the red felt chéchia (with a swinging black silk tassel) and the mint speed trail.
import { BufferAttribute, BufferGeometry, Color, Group, LatheGeometry, Mesh, Vector2, Vector3, type Material } from 'three';
import { computeNormals } from './builder';

const RED = new Color(0xa8121b);
const RED_DEEP = new Color(0x7e0c14);
const BLACK = new Color(0x121010);

function paint(g: BufferGeometry, fn: (x: number, y: number, z: number, c: Color) => void): BufferGeometry {
  const p = g.getAttribute('position');
  const cols = new Float32Array(p.count * 3);
  const c = new Color();
  for (let i = 0; i < p.count; i++) {
    fn(p.getX(i), p.getY(i), p.getZ(i), c);
    cols.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new BufferAttribute(cols, 3));
  // fur shader expects these attributes; zeroed for accessories
  g.setAttribute('aFur', new BufferAttribute(new Float32Array(p.count * 3), 3));
  return g;
}

export interface Chechia {
  root: Group; // attach to the head bone
  tassel: Group;
  dispose(): void;
}

/** A small felt chéchia (Tunisian fez: soft, slightly tapered, flat top, black silk tassel). */
export function createChechia(material: Material, segments: number): Chechia {
  const prof = [
    [0.049, -0.012], [0.055, -0.004], [0.0565, 0.004], [0.0556, 0.02], [0.0537, 0.038], [0.0518, 0.05], [0.049, 0.0555], [0.043, 0.0588], [0.03, 0.0604], [0.012, 0.0612], [0, 0.0613],
  ].map(([x, y]) => new Vector2(x, y));
  const cap = paint(new LatheGeometry(prof, segments), (x, y, z, c) => {
    // darker felt at the rolled bottom edge and a faint vertical pile variation
    c.copy(RED).lerp(RED_DEEP, Math.max(0, 1 - (y + 0.012) / 0.012) * 0.6 + 0.12 * Math.sin(Math.atan2(z, x) * 23) ** 2);
  });
  const root = new Group();
  root.name = 'chechia';
  const capMesh = new Mesh(cap, material);
  capMesh.castShadow = true;
  root.add(capMesh);

  // tassel: short cord from the centre + a flared fringe hanging to the back
  const tassel = new Group();
  tassel.position.set(0, 0.061, 0);
  const cordPts: Vector3[] = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    cordPts.push(new Vector3(0.012 * t, 0.006 * Math.sin(t * Math.PI) - 0.0 * t, -0.03 * t));
  }
  const fringe = tasselGeometry(cordPts, segments);
  const tMesh = new Mesh(fringe, material);
  tMesh.castShadow = false;
  tassel.add(tMesh);
  root.add(tassel);
  return {
    root,
    tassel,
    dispose() {
      cap.dispose();
      fringe.dispose();
    },
  };
}

/** Cord tube along `pts`, ending in a fringe (a flared, finely creased cone). */
function tasselGeometry(pts: Vector3[], segs: number): BufferGeometry {
  const around = Math.max(10, Math.round(segs / 2));
  const rows: { c: Vector3; r: number }[] = pts.map((c) => ({ c, r: 0.0022 }));
  const end = pts[pts.length - 1];
  // fringe hangs down from the cord end
  const fr = 12;
  for (let i = 1; i <= fr; i++) {
    const t = i / fr;
    rows.push({ c: new Vector3(end.x + 0.004 * t, end.y - 0.045 * t, end.z - 0.012 * t), r: 0.003 + 0.009 * Math.sqrt(t) });
  }
  const pos = new Float32Array(rows.length * around * 3);
  const idx: number[] = [];
  for (let r = 0; r < rows.length; r++)
    for (let a = 0; a < around; a++) {
      const ang = (a / around) * Math.PI * 2;
      const crease = r > pts.length ? 1 + 0.18 * Math.cos(ang * 9) : 1;
      const { c, r: rad } = rows[r];
      pos.set([c.x + Math.cos(ang) * rad * crease, c.y, c.z + Math.sin(ang) * rad * crease], (r * around + a) * 3);
      if (r < rows.length - 1) {
        const a1 = (a + 1) % around;
        const i0 = r * around + a, i1 = r * around + a1, i2 = (r + 1) * around + a, i3 = (r + 1) * around + a1;
        idx.push(i0, i2, i1, i1, i2, i3);
      }
    }
  const g = new BufferGeometry();
  const index = new Uint32Array(idx);
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(computeNormals(pos, index), 3));
  g.setIndex(new BufferAttribute(index, 1));
  return paint(g, (_x, y, _z, c) => c.copy(BLACK).multiplyScalar(y < -0.03 ? 0.8 : 1));
}

// ---------------------------------------------------------------------------------------------

export interface Trail {
  mesh: Mesh;
  /** Pushes the anchors' current world positions (call every frame while visible). */
  update(anchors: readonly Vector3[], fade: number, dt: number): void;
  dispose(): void;
}

/** History sample spacing (s): the ribbons span a fixed time, whatever the frame rate. */
const TRAIL_STEP = 1 / 50;

/** Camera-facing ribbons (one per anchor) drawn in world space, 1 draw call. */
export function createTrail(material: Material, ribbons: number, length = 18): Trail {
  const N = length;
  const V = ribbons * N * 2;
  const pos = new Float32Array(V * 3);
  const tan = new Float32Array(V * 3);
  const side = new Float32Array(V * 2);
  const idx: number[] = [];
  for (let r = 0; r < ribbons; r++)
    for (let i = 0; i < N; i++) {
      const v = (r * N + i) * 2;
      side.set([-1, i / (N - 1), 1, i / (N - 1)], v * 2);
      if (i < N - 1) idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
    }
  const g = new BufferGeometry();
  const pa = new BufferAttribute(pos, 3), ta = new BufferAttribute(tan, 3);
  g.setAttribute('position', pa);
  g.setAttribute('aTangent', ta);
  g.setAttribute('aSide', new BufferAttribute(side, 2));
  g.setIndex(idx);
  const mesh = new Mesh(g, material);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.matrixWorldAutoUpdate = false; // positions are already world space
  mesh.renderOrder = 5;
  // hist[0] is the live anchor (the head); hist[1..] are samples every TRAIL_STEP seconds
  const hist = new Float32Array(ribbons * N * 3);
  const last = new Float32Array(ribbons * 3); // anchors at the previous update
  let primed = false, acc = 0;
  return {
    mesh,
    update(anchors, fade, dt) {
      mesh.visible = fade > 0.001;
      (material as unknown as { uniforms: { uFade: { value: number } } }).uniforms.uFade.value = fade;
      const restart = !primed || fade <= 0.001;
      let steps = 0;
      if (restart) acc = 0;
      else { acc += dt; steps = Math.floor(acc / TRAIL_STEP); acc -= steps * TRAIL_STEP; steps = Math.min(steps, N - 1); }
      for (let r = 0; r < ribbons; r++) {
        const a = anchors[r];
        const o = r * N * 3, l = r * 3;
        // teleports (respawn) restart the ribbon instead of stretching it across the map
        const jump = (a.x - last[l]) ** 2 + (a.y - last[l + 1]) ** 2 + (a.z - last[l + 2]) ** 2 > 2.25;
        if (restart || jump) {
          for (let i = 0; i < N; i++) { hist[o + i * 3] = a.x; hist[o + i * 3 + 1] = a.y; hist[o + i * 3 + 2] = a.z; }
        } else {
          // insert the samples due this frame (oldest first), interpolated along the frame's anchor motion
          for (let j = steps; j >= 1; j--) {
            hist.copyWithin(o + 6, o + 3, o + (N - 1) * 3);
            const f = dt > 0 ? Math.min(1, Math.max(0, 1 - (acc + (j - 1) * TRAIL_STEP) / dt)) : 1;
            hist[o + 3] = last[l] + (a.x - last[l]) * f;
            hist[o + 4] = last[l + 1] + (a.y - last[l + 1]) * f;
            hist[o + 5] = last[l + 2] + (a.z - last[l + 2]) * f;
          }
          hist[o] = a.x; hist[o + 1] = a.y; hist[o + 2] = a.z;
        }
        last[l] = a.x; last[l + 1] = a.y; last[l + 2] = a.z;
        for (let i = 0; i < N; i++) {
          const h = o + i * 3;
          const n = o + Math.min(N - 1, i + 1) * 3, p = o + Math.max(0, i - 1) * 3;
          let tx = hist[p] - hist[n], ty = hist[p + 1] - hist[n + 1], tz = hist[p + 2] - hist[n + 2];
          const l = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (l < 1e-6) { tx = 0; ty = 1; tz = 0; } else { tx /= l; ty /= l; tz /= l; }
          const v = ((r * N + i) * 2) * 3;
          // [1 2 1] smoothing along the ribbon removes the kinks of the bouncing anchors (head stays put)
          const inner = i > 0 && i < N - 1 ? 1 : 0;
          const sx = hist[h] + (hist[p] + hist[n] - 2 * hist[h]) * 0.25 * inner;
          const sy = hist[h + 1] + (hist[p + 1] + hist[n + 1] - 2 * hist[h + 1]) * 0.25 * inner;
          const sz = hist[h + 2] + (hist[p + 2] + hist[n + 2] - 2 * hist[h + 2]) * 0.25 * inner;
          for (let k = 0; k <= 3; k += 3) {
            pos[v + k] = sx; pos[v + k + 1] = sy; pos[v + k + 2] = sz;
            tan[v + k] = tx; tan[v + k + 1] = ty; tan[v + k + 2] = tz;
          }
        }
      }
      primed = true;
      pa.needsUpdate = true;
      ta.needsUpdate = true;
    },
    dispose() {
      g.dispose();
    },
  };
}

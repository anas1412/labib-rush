// Signed-distance sculpting kit + Surface Nets mesher used to build Labib's organic shapes.
// Shapes are smooth unions of primitives, so the extracted meshes have no primitive seams, and the
// vertex normals come from the SDF gradient (perfectly smooth). Runs once at load time.

export type Sdf = (x: number, y: number, z: number) => number;

// ---------------------------------------------------------------------------------------------
// Primitives (Inigo Quilez' formulas). All take the sample point as plain numbers (no allocation).

export function sdSphere(x: number, y: number, z: number, cx: number, cy: number, cz: number, r: number): number {
  const dx = x - cx, dy = y - cy, dz = z - cz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

/** Approximate ellipsoid distance (bound-correct near the surface, good enough for sculpting). */
export function sdEllipsoid(x: number, y: number, z: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): number {
  const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz;
  const k0 = Math.sqrt(px * px + py * py + pz * pz);
  const qx = px / rx, qy = py / ry, qz = pz / rz;
  const k1 = Math.sqrt(qx * qx + qy * qy + qz * qz);
  return k1 < 1e-9 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}

/** Capsule whose radius changes linearly from ra (at a) to rb (at b): iq's round cone. */
export function sdRoundCone(
  x: number, y: number, z: number,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  ra: number, rb: number,
): number {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = ra - rb;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const pax = x - ax, pay = y - ay, paz = z - az;
  const yv = pax * bax + pay * bay + paz * baz;
  const zv = yv - l2;
  const cx = pax * l2 - bax * yv, cy = pay * l2 - bay * yv, cz = paz * l2 - baz * yv;
  const x2 = cx * cx + cy * cy + cz * cz;
  const y2 = yv * yv * l2;
  const z2 = zv * zv * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(zv) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - rb;
  if (Math.sign(yv) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - ra;
  return (Math.sqrt(x2 * a2 * il2) + yv * rr) * il2 - ra;
}

export function sdCapsule(x: number, y: number, z: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): number {
  const pax = x - ax, pay = y - ay, paz = z - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const h = clamp01((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz));
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
}

/** Parameter (0..1) of the closest point on segment ab. */
export function segT(x: number, y: number, z: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  return clamp01(((x - ax) * bax + (y - ay) * bay + (z - az) * baz) / (bax * bax + bay * bay + baz * baz));
}

/** Rounded box centred at c with half extents h and corner radius r (axis aligned). */
export function sdRoundBox(x: number, y: number, z: number, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, r: number): number {
  const qx = Math.abs(x - cx) - hx + r, qy = Math.abs(y - cy) - hy + r, qz = Math.abs(z - cz) - hz + r;
  const mx = Math.max(qx, 0), my = Math.max(qy, 0), mz = Math.max(qz, 0);
  return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

/** Torus in the XZ plane around centre c. */
export function sdTorus(x: number, y: number, z: number, cx: number, cy: number, cz: number, R: number, r: number): number {
  const dx = x - cx, dz = z - cz;
  const q = Math.sqrt(dx * dx + dz * dz) - R;
  const dy = y - cy;
  return Math.sqrt(q * q + dy * dy) - r;
}

// ---------------------------------------------------------------------------------------------
// Operators

/** Polynomial smooth minimum (blend radius k). */
export function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
export function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Cheap deterministic 3D value noise in [-1, 1] (for lumpy fur clumps and cloth folds). */
export function vnoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const h = (i: number, j: number, k: number) => {
    let n = (i * 374761393 + j * 668265263 + k * 1274126177) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) & 0xffff) / 32767.5 - 1;
  };
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(lerp(h(ix, iy, iz), h(ix + 1, iy, iz), ux), lerp(h(ix, iy + 1, iz), h(ix + 1, iy + 1, iz), ux), uy),
    lerp(lerp(h(ix, iy, iz + 1), h(ix + 1, iy, iz + 1), ux), lerp(h(ix, iy + 1, iz + 1), h(ix + 1, iy + 1, iz + 1), ux), uy),
    uz,
  );
}

// ---------------------------------------------------------------------------------------------
// Surface Nets

export interface RawMesh {
  positions: Float32Array; // xyz
  normals: Float32Array; // xyz, from the SDF gradient
  indices: Uint32Array;
}

/**
 * Extracts the zero level set of `f` inside [min, max] with cubic cells of size `h`.
 * A coarse pre-pass skips blocks that are provably far from the surface (assumes |∇f| ≤ ~1.3).
 * Vertices are projected onto the surface with two Newton steps, so the result is smooth and exact.
 */
export function surfaceNets(f: Sdf, min: readonly [number, number, number], max: readonly [number, number, number], h: number): RawMesh {
  const nx = Math.ceil((max[0] - min[0]) / h), ny = Math.ceil((max[1] - min[1]) / h), nz = Math.ceil((max[2] - min[2]) / h);
  const sx = nx + 1, sy = ny + 1, sz = nz + 1;
  const val = new Float32Array(sx * sy * sz);
  const done = new Uint8Array(sx * sy * sz);
  const id = (i: number, j: number, k: number) => i + sx * (j + sy * k);

  // coarse pass: blocks of C cells
  const C = 4;
  const cx = Math.ceil(nx / C), cy = Math.ceil(ny / C), cz = Math.ceil(nz / C);
  const coarse = new Float32Array((cx + 1) * (cy + 1) * (cz + 1));
  const cid = (i: number, j: number, k: number) => i + (cx + 1) * (j + (cy + 1) * k);
  for (let k = 0; k <= cz; k++)
    for (let j = 0; j <= cy; j++)
      for (let i = 0; i <= cx; i++)
        coarse[cid(i, j, k)] = f(min[0] + Math.min(i * C, nx) * h, min[1] + Math.min(j * C, ny) * h, min[2] + Math.min(k * C, nz) * h);
  const safe = C * h * Math.sqrt(3) * 1.3;
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        let near = false;
        let sign = 0;
        for (let c = 0; c < 8 && !near; c++) {
          const v = coarse[cid(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          if (Math.abs(v) < safe) near = true;
          const s = v < 0 ? -1 : 1;
          if (sign === 0) sign = s;
          else if (s !== sign) near = true;
        }
        const i0 = i * C, j0 = j * C, k0 = k * C;
        const i1 = Math.min(i0 + C, nx), j1 = Math.min(j0 + C, ny), k1 = Math.min(k0 + C, nz);
        for (let kk = k0; kk <= k1; kk++)
          for (let jj = j0; jj <= j1; jj++)
            for (let ii = i0; ii <= i1; ii++) {
              const n = id(ii, jj, kk);
              if (near) {
                if (done[n] !== 2) {
                  val[n] = f(min[0] + ii * h, min[1] + jj * h, min[2] + kk * h);
                  done[n] = 2;
                }
              } else if (done[n] === 0) {
                val[n] = sign * safe; // provably outside/inside, magnitude irrelevant
                done[n] = 1;
              }
            }
      }

  // one vertex per cell that straddles the surface
  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const pos: number[] = [];
  const cellId = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const corner = new Float32Array(8);
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = val[id(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          corner[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let ax = 0, ay = 0, az = 0, cnt = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a], vb = corner[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          ax += (a & 1) + t * ((b & 1) - (a & 1));
          ay += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
          az += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1));
          cnt++;
        }
        cellVert[cellId(i, j, k)] = pos.length / 3;
        pos.push(min[0] + (i + ax / cnt) * h, min[1] + (j + ay / cnt) * h, min[2] + (k + az / cnt) * h);
      }

  // quads across every sign-changing grid edge
  const idx: number[] = [];
  const P = pos;
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (!flip) { const t = b; b = d; d = t; }
    // split along the shorter diagonal
    const d1 = dist2(P, a, c), d2 = dist2(P, b, d);
    if (d1 <= d2) idx.push(a, b, c, a, c, d);
    else idx.push(a, b, d, b, c, d);
  };
  for (let k = 1; k < nz; k++)
    for (let j = 1; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        // edge along x from node (i,j,k) to (i+1,j,k)
        const v0 = val[id(i, j, k)], v1 = val[id(i + 1, j, k)];
        if (v0 < 0 === v1 < 0) continue;
        quad(cellVert[cellId(i, j - 1, k - 1)], cellVert[cellId(i, j, k - 1)], cellVert[cellId(i, j, k)], cellVert[cellId(i, j - 1, k)], v0 < 0);
      }
  for (let k = 1; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const v0 = val[id(i, j, k)], v1 = val[id(i, j + 1, k)];
        if (v0 < 0 === v1 < 0) continue;
        quad(cellVert[cellId(i - 1, j, k - 1)], cellVert[cellId(i - 1, j, k)], cellVert[cellId(i, j, k)], cellVert[cellId(i, j, k - 1)], v0 < 0);
      }
  for (let k = 0; k < nz; k++)
    for (let j = 1; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const v0 = val[id(i, j, k)], v1 = val[id(i, j, k + 1)];
        if (v0 < 0 === v1 < 0) continue;
        quad(cellVert[cellId(i - 1, j - 1, k)], cellVert[cellId(i, j - 1, k)], cellVert[cellId(i, j, k)], cellVert[cellId(i - 1, j, k)], v0 < 0);
      }

  // project onto the surface (2 Newton steps) + gradient normals, using tetrahedral differences
  const positions = new Float32Array(pos);
  const normals = new Float32Array(pos.length);
  const e = h * 0.25;
  const g = [0, 0, 0, 0]; // [value, gx, gy, gz]
  const tetra = (x: number, y: number, z: number) => {
    const a = f(x + e, y - e, z - e), b = f(x - e, y - e, z + e), c = f(x - e, y + e, z - e), d = f(x + e, y + e, z + e);
    g[0] = (a + b + c + d) * 0.25;
    g[1] = a - b - c + d; g[2] = -a - b + c + d; g[3] = -a + b - c + d;
  };
  for (let v = 0; v < positions.length; v += 3) {
    let x = positions[v], y = positions[v + 1], z = positions[v + 2];
    const x0 = x, y0 = y, z0 = z;
    for (let it = 0; it < 2; it++) {
      tetra(x, y, z);
      const g2 = (g[1] * g[1] + g[2] * g[2] + g[3] * g[3]) / (16 * e * e);
      if (g2 < 1e-12) break;
      const s = g[0] / g2 / (4 * e);
      x -= g[1] * s; y -= g[2] * s; z -= g[3] * s;
    }
    // never let a vertex wander more than ~one cell (keeps topology sane at thin features)
    const mx = x - x0, my = y - y0, mz = z - z0;
    const m = Math.sqrt(mx * mx + my * my + mz * mz);
    if (m > h) { const s = h / m; x = x0 + mx * s; y = y0 + my * s; z = z0 + mz * s; }
    positions[v] = x; positions[v + 1] = y; positions[v + 2] = z;
    tetra(x, y, z);
    const gl = Math.sqrt(g[1] * g[1] + g[2] * g[2] + g[3] * g[3]) || 1;
    normals[v] = g[1] / gl; normals[v + 1] = g[2] / gl; normals[v + 2] = g[3] / gl;
  }
  return { positions, normals, indices: new Uint32Array(idx) };
}

function dist2(p: number[], a: number, b: number): number {
  const dx = p[a * 3] - p[b * 3], dy = p[a * 3 + 1] - p[b * 3 + 1], dz = p[a * 3 + 2] - p[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

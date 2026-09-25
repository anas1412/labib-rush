// Offline bake of the bronze statue meshes (landmarks module). NOT part of the game build.
//   node dev/landmarks.bake.mjs <dir-with-source-glbs>
// Sources (CC0, Quaternius via poly.pizza — see docs/credits/landmarks.md):
//   horse_brown.glb  https://poly.pizza/m/qvTrSG9pZF   (rigged "Horse", Animated Animal Pack)
//   man_suit.glb     https://poly.pizza/m/mQnGoME1ez   (rigged "Man in Suit")
// Each rig is posed (clip frame + per-bone world-axis rotations), skinned on the CPU, welded,
// Loop-subdivided for a smooth cast-bronze surface, joined with procedural drapery/accessories and
// written as a compact binary (see src/world/landmarks/statueMesh.ts for the format).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeVertices, mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const SRC = process.argv[2] || '/tmp/claude-1000/refs';
const OUT = new URL('../public/models/landmarks/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const load = (f) => new Promise((res, rej) => {
  const b = readFileSync(f);
  new GLTFLoader().parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', res, rej);
});
const D = THREE.MathUtils.degToRad;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------------------------
// Posing

/**
 * Plays `clip` at `time`, then applies per-bone edits in order (parents before children):
 *   { aim: [x,y,z] }   rotate the bone (in world space) so its +Y axis points along the direction
 *   { rot: [[axis, deg], ...] }  extra world-axis rotations about the bone's origin
 *   { twist: deg }     rotation about the bone's own +Y axis
 *   { scale: s }       uniform bone scale (children inherit)
 *   { to: 'Bone' }     move the bone onto another bone's world position (IK targets such as the
 *                      man's FootL/FootR hang off the root, so re-aimed legs must drag them along)
 */
function pose(gltf, clip, time, edits) {
  const root = gltf.scene;
  const mixer = new THREE.AnimationMixer(root);
  mixer.clipAction(gltf.animations.find((c) => c.name.endsWith(clip))).play();
  mixer.setTime(time);
  root.updateMatrixWorld(true);
  const bones = {};
  root.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  const wq = new THREE.Quaternion(), pq = new THREE.Quaternion(), r = new THREE.Quaternion();
  const applyWorld = (b, q) => {
    b.getWorldQuaternion(wq);
    b.parent.getWorldQuaternion(pq);
    b.quaternion.copy(pq.invert().multiply(q.clone().multiply(wq)));
    b.updateMatrixWorld(true);
  };
  for (const [name, e] of edits) {
    const b = bones[name];
    if (!b) throw new Error('no bone ' + name);
    if (e.to) {
      b.position.copy(b.parent.worldToLocal(root.getObjectByName(e.to).getWorldPosition(V(0, 0, 0))));
      b.updateMatrixWorld(true);
    }
    if (e.aim) {
      b.getWorldQuaternion(wq);
      const cur = V(0, 1, 0).applyQuaternion(wq).normalize();
      applyWorld(b, r.setFromUnitVectors(cur, V(...e.aim).normalize()));
    }
    for (const [axis, deg] of e.rot ?? []) applyWorld(b, r.setFromAxisAngle(axis.clone().normalize(), D(deg)));
    if (e.scale) { b.scale.multiplyScalar(e.scale); b.updateMatrixWorld(true); }
    if (e.twist) {
      b.getWorldQuaternion(wq);
      applyWorld(b, r.setFromAxisAngle(V(0, 1, 0).applyQuaternion(wq).normalize(), D(e.twist)));
    }
  }
  root.updateMatrixWorld(true);
  return bones;
}

/** CPU-skins every SkinnedMesh (except `skip` materials) into one welded geometry. `channels`
 *  ({ name: RegExp }) adds a float attribute per entry: the summed skin weight of matching bones,
 *  used to deform body regions smoothly (weights blend exactly like the skinning does). */
function bakeSkinned(root, skip = [], channels = {}) {
  const parts = [];
  root.traverse((o) => {
    if (!o.isSkinnedMesh || skip.includes(o.material.name)) return;
    const src = o.geometry.attributes.position;
    const pos = new Float32Array(src.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < src.count; i++) {
      o.getVertexPosition(i, v);
      v.applyMatrix4(o.matrixWorld);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight;
    for (const [name, re] of Object.entries(channels)) {
      const w = new Float32Array(src.count);
      for (let i = 0; i < src.count; i++) {
        for (let k = 0; k < 4; k++) if (re.test(o.skeleton.bones[si.getComponent(i, k)].name)) w[i] += sw.getComponent(i, k);
      }
      g.setAttribute(name, new THREE.BufferAttribute(w, 1));
    }
    g.setIndex(o.geometry.index.clone());
    parts.push(g);
  });
  return mergeVertices(mergeGeometries(parts), 1e-3);
}

/** Pushes vertices out along their (welded, smooth) normals by `d(i)` (clothing bulk). */
function inflate(g, d) {
  g.computeVertexNormals();
  const P = g.attributes.position, N = g.attributes.normal;
  for (let i = 0; i < P.count; i++) {
    const k = d(i);
    P.setXYZ(i, P.getX(i) + N.getX(i) * k, P.getY(i) + N.getY(i) * k, P.getZ(i) + N.getZ(i) * k);
  }
  g.deleteAttribute('normal');
  return g;
}

/** Keeps only the position attribute (and index): subdivision/merging want uniform layouts. */
function positionsOnly(g) {
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  return g;
}

/** Nearest hit of a ray on an indexed mesh (both faces). Normal is flipped to face along the ray
 *  (rays are cast from inside a body, so that is the body's outward normal). */
function raycast(geo, o, d, maxT = 10) {
  const P = geo.attributes.position.array, I = geo.index.array;
  const a = V(0, 0, 0), b = V(0, 0, 0), c = V(0, 0, 0), e1 = V(0, 0, 0), e2 = V(0, 0, 0), p = V(0, 0, 0), t = V(0, 0, 0), q = V(0, 0, 0);
  let best = maxT, n = null;
  for (let f = 0; f < I.length; f += 3) {
    a.fromArray(P, I[f] * 3); b.fromArray(P, I[f + 1] * 3); c.fromArray(P, I[f + 2] * 3);
    e1.subVectors(b, a); e2.subVectors(c, a); p.crossVectors(d, e2);
    const det = e1.dot(p);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    t.subVectors(o, a);
    const u = t.dot(p) * inv;
    if (u < 0 || u > 1) continue;
    q.crossVectors(t, e1);
    const v = d.dot(q) * inv;
    if (v < 0 || u + v > 1) continue;
    const tt = e2.dot(q) * inv;
    if (tt > 1e-4 && tt < best) { best = tt; n = V(0, 0, 0).crossVectors(e1, e2).normalize(); }
  }
  if (!n) return null;
  if (n.dot(d) < 0) n.negate();
  return { p: o.clone().addScaledVector(d, best), n };
}

/**
 * Cloth laid over a body's back (saddle cloth, saddle): rows along z from z0 to z1; each row is a
 * cross-section from one hem over the spine to the other, found by casting rays out of `core`
 * (a point inside the body at that z) and hanging straight down below the body's widest point.
 * `drop(s)` = arc length from the spine to the hem, `lift(s, t)` raises the surface (pommel,
 * cantle, padding). s ∈ [0,1] along z, t ∈ [-1,1] across. Returns [outer, inner, hem tubes...].
 */
function drape(body, { z0, z1, core, drop, lift = () => 0, off = 0.03, thick = 0.035, nu = 30, nv = 24, hem = 0.028 }) {
  const rows = [];
  for (let i = 0; i <= nu; i++) {
    const s = i / nu, z = z0 + (z1 - z0) * s;
    const o = V(0, core(z), z);
    const side = (sd) => {
      const pts = [];
      for (let k = 0; k <= 30; k++) {
        const th = D(88) * (k / 30);
        const h = raycast(body, o, V(sd * Math.sin(th), Math.cos(th), 0));
        if (h) pts.push(h.p.addScaledVector(h.n, off));
      }
      // stop following the body where it turns back under (widest point), hang from there
      let w = 0;
      for (let k = 1; k < pts.length; k++) if (Math.abs(pts[k].x) >= Math.abs(pts[w].x)) w = k;
      const line = pts.slice(0, w + 1);
      line.push(line[line.length - 1].clone().add(V(0, -3, 0)));
      return line;
    };
    rows.push([side(-1), side(1), drop(s)]);
  }
  // resample a polyline at arc length L
  const at = (line, L) => {
    let acc = 0;
    for (let k = 1; k < line.length; k++) {
      const seg = line[k].distanceTo(line[k - 1]);
      if (acc + seg >= L) return line[k - 1].clone().lerp(line[k], (L - acc) / seg);
      acc += seg;
    }
    return line[line.length - 1].clone();
  };
  const surf = (inset) => grid(nv, nu, (u, v) => {
    const [L, R, dr] = rows[Math.round(v * nu)];
    const t = u * 2 - 1, s = v;
    const p = at(t < 0 ? L : R, Math.abs(t) * dr);
    p.y += lift(s, t) - inset;
    return p;
  });
  const outer = surf(0), inner = flip(surf(thick));
  const edge = (f, n) => tube(Array.from({ length: n + 1 }, (_, k) => f(k / n)), [hem, hem], 6, n * 2);
  const P = (s, t) => {
    const [L, R, dr] = rows[Math.round(s * nu)];
    const p = at(t < 0 ? L : R, Math.abs(t) * dr);
    p.y += lift(s, t) - thick / 2;
    return p;
  };
  return [outer, inner, edge((k) => P(k, -1), nu), edge((k) => P(k, 1), nu), edge((k) => P(0, k * 2 - 1), nv), edge((k) => P(1, k * 2 - 1), nv)];
}

/** Dominant skin bone name per vertex of a SkinnedMesh. */
function dominantBones(o) {
  const si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight;
  const out = [];
  for (let i = 0; i < si.count; i++) {
    let best = 0;
    for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
    out.push(o.skeleton.bones[si.getComponent(i, best)].name);
  }
  return out;
}

/** Like bakeSkinned, but keeps only triangles of `materials` whose 3 vertices are dominated by
 *  a bone matching `boneRe` (used to lift just the head and hands off a rig). */
function bakeParts(root, materials, boneRe) {
  const parts = [];
  root.traverse((o) => {
    if (!o.isSkinnedMesh || !materials.includes(o.material.name)) return;
    const dom = dominantBones(o);
    const I = o.geometry.index.array, keep = [];
    for (let f = 0; f < I.length; f += 3) {
      if (boneRe.test(dom[I[f]]) && boneRe.test(dom[I[f + 1]]) && boneRe.test(dom[I[f + 2]])) keep.push(I[f], I[f + 1], I[f + 2]);
    }
    if (!keep.length) return;
    const src = o.geometry.attributes.position;
    const pos = new Float32Array(src.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < src.count; i++) { o.getVertexPosition(i, v); v.applyMatrix4(o.matrixWorld); pos.set([v.x, v.y, v.z], i * 3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(keep);
    parts.push(g);
  });
  return mergeVertices(mergeGeometries(parts), 1e-3);
}

/** Crown of the posed head: top y, and centre/radius of the skull slice just below it. */
function headFit(root) {
  const pts = [];
  root.traverse((o) => {
    if (!o.isSkinnedMesh || !['Skin', 'Hair'].includes(o.material.name)) return;
    const dom = dominantBones(o), v = new THREE.Vector3();
    for (let i = 0; i < dom.length; i++) if (dom[i] === 'Head') { o.getVertexPosition(i, v); pts.push(v.clone().applyMatrix4(o.matrixWorld)); }
  });
  const top = Math.max(...pts.map((p) => p.y));
  const H = top - Math.min(...pts.map((p) => p.y)); // crown to chin (incl. beard)
  const box = new THREE.Box3();
  pts.filter((p) => p.y > top - 0.45 * H).forEach((p) => box.expandByPoint(p));
  const c = box.getCenter(V(0, 0, 0)), sz = box.getSize(V(0, 0, 0));
  // front of the forehead (brow band) and back of the skull, for caps that must sit flush
  const band = pts.filter((p) => p.y > top - 0.34 * H && p.y < top - 0.12 * H);
  const zFront = Math.max(...band.map((p) => p.z)), zBack = Math.min(...band.map((p) => p.z));
  return { top, H, c, rx: sz.x / 2, rz: sz.z / 2, zFront, zBack };
}

/** Tube with varying radius along a Catmull-Rom path (open ends capped by `caps`). */
function tube(points, radii, radial = 16, segs = 24) {
  const curve = new THREE.CatmullRomCurve3(points);
  const fr = curve.computeFrenetFrames(segs, false);
  const r = (t) => { const x = t * (radii.length - 1), i = Math.min(radii.length - 2, Math.floor(x)); return radii[i] + (radii[i + 1] - radii[i]) * (x - i); };
  return grid(radial, segs, (u, v) => {
    const k = Math.round(v * segs), a = u * Math.PI * 2;
    const p = curve.getPointAt(v);
    return p.addScaledVector(fr.normals[k], Math.cos(a) * r(v)).addScaledVector(fr.binormals[k], Math.sin(a) * r(v));
  }, true);
}

// ---------------------------------------------------------------------------------------------
// Loop subdivision (indexed, position only). Non-manifold / boundary edges use the crease rules.
function loopSubdivide(geo) {
  const P = geo.attributes.position.array, I = geo.index.array;
  const nv = P.length / 3, nf = I.length / 3;
  const edges = new Map();
  const key = (a, b) => (a < b ? a * nv + b : b * nv + a);
  for (let f = 0; f < nf; f++) {
    for (let e = 0; e < 3; e++) {
      const a = I[f * 3 + e], b = I[f * 3 + ((e + 1) % 3)], c = I[f * 3 + ((e + 2) % 3)];
      const k = key(a, b);
      let E = edges.get(k);
      if (!E) edges.set(k, (E = { a, b, opp: [], id: -1 }));
      E.opp.push(c);
    }
  }
  const out = [];
  const nbr = Array.from({ length: nv }, () => []);
  const bnd = Array.from({ length: nv }, () => []);
  for (const E of edges.values()) {
    nbr[E.a].push(E.b); nbr[E.b].push(E.a);
    if (E.opp.length !== 2) { bnd[E.a].push(E.b); bnd[E.b].push(E.a); }
  }
  // even (old) vertices
  for (let v = 0; v < nv; v++) {
    const p = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];
    let r;
    if (bnd[v].length === 2) {
      r = p.map((x, i) => 0.75 * x + 0.125 * (P[bnd[v][0] * 3 + i] + P[bnd[v][1] * 3 + i]));
    } else if (bnd[v].length > 0 || nbr[v].length === 0) { // corner / isolated vertex: fixed
      r = p;
    } else {
      const n = nbr[v].length;
      const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
      r = p.map((x, i) => (1 - n * beta) * x + beta * nbr[v].reduce((s, u) => s + P[u * 3 + i], 0));
    }
    out.push(...r);
  }
  // odd (edge) vertices
  let next = nv;
  for (const E of edges.values()) {
    const r = [0, 1, 2].map((i) =>
      E.opp.length === 2
        ? 0.375 * (P[E.a * 3 + i] + P[E.b * 3 + i]) + 0.125 * (P[E.opp[0] * 3 + i] + P[E.opp[1] * 3 + i])
        : 0.5 * (P[E.a * 3 + i] + P[E.b * 3 + i]));
    out.push(...r);
    E.id = next++;
  }
  const idx = [];
  for (let f = 0; f < nf; f++) {
    const a = I[f * 3], b = I[f * 3 + 1], c = I[f * 3 + 2];
    const ab = edges.get(key(a, b)).id, bc = edges.get(key(b, c)).id, ca = edges.get(key(c, a)).id;
    idx.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Procedural pieces (all indexed, position only, closed or double-layered so no backfaces show)

/** Grid surface f(u,v) → Vector3 for u,v in [0,1]; optional closed u. */
function grid(nu, nv, f, closeU = false) {
  const pos = [], idx = [];
  const cu = closeU ? nu : nu + 1;
  for (let j = 0; j <= nv; j++) for (let i = 0; i < cu; i++) pos.push(...f(i / nu, j / nv).toArray());
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * cu + i, b = j * cu + ((i + 1) % cu), c = (j + 1) * cu + i, d = (j + 1) * cu + ((i + 1) % cu);
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

function flip(g) {
  const I = g.index.array;
  for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; }
  return g;
}

/** Lathe from (radius, y) points around Y with center c, as an indexed closed-u grid. */
function lathe(points, segs, c = V(0, 0, 0), sx = 1, sz = 1) {
  return grid(segs, points.length - 1, (u, v) => {
    const k = Math.min(points.length - 1, Math.round(v * (points.length - 1)));
    const [r, y] = points[k];
    const a = u * Math.PI * 2;
    return V(c.x + Math.sin(a) * r * sx, c.y + y, c.z + Math.cos(a) * r * sz);
  }, true);
}

function boxGeo(w, h, d, m) {
  const g = mergeVertices(new THREE.BoxGeometry(w, h, d).deleteAttribute('normal').deleteAttribute('uv'));
  return g.applyMatrix4(m);
}

/** Smooth-normal, non-welded piece: compute normals now so hard edges between pieces survive. */
function finish(g) {
  g.computeVertexNormals();
  return g;
}

/**
 * Per-vertex concavity 0..1: mean curvature from the umbrella operator (normal · (neighbour
 * average − vertex) / mean edge²), positive in creases and folds, then blurred over the mesh so
 * the patina bleeds a little out of each crevice. `k` = curvature (1/m) that maps to 1.
 */
function cavity(g, k = 9, blur = 3) {
  const P = g.attributes.position.array, N = g.attributes.normal.array, I = g.index.array, n = P.length / 3;
  const nbr = Array.from({ length: n }, () => new Set());
  for (let f = 0; f < I.length; f += 3) {
    for (let e = 0; e < 3; e++) { const a = I[f + e], b = I[f + ((e + 1) % 3)]; nbr[a].add(b); nbr[b].add(a); }
  }
  let c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!nbr[i].size) continue;
    let ax = 0, ay = 0, az = 0, l2 = 0;
    for (const j of nbr[i]) {
      const dx = P[j * 3] - P[i * 3], dy = P[j * 3 + 1] - P[i * 3 + 1], dz = P[j * 3 + 2] - P[i * 3 + 2];
      ax += dx; ay += dy; az += dz; l2 += dx * dx + dy * dy + dz * dz;
    }
    const m = nbr[i].size;
    const curv = (2 * (N[i * 3] * ax + N[i * 3 + 1] * ay + N[i * 3 + 2] * az) / m) / (l2 / m);
    c[i] = THREE.MathUtils.clamp(curv / k, 0, 1);
  }
  for (let it = 0; it < blur; it++) {
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = c[i] * 2, w = 2;
      for (const j of nbr[i]) { sum += c[j]; w++; }
      o[i] = sum / w;
    }
    c = o;
  }
  return c;
}

function write(name, pieces) {
  const g = mergeGeometries(pieces.map((p) => { const q = p.index ? p : mergeVertices(p); return q; }));
  const box = new THREE.Box3().setFromBufferAttribute(g.attributes.position);
  const n = g.attributes.position.count, P = g.attributes.position.array, N = g.attributes.normal.array;
  const size = box.getSize(V(0, 0, 0));
  const q = new Uint16Array(n * 3), nn = new Int8Array(n * 3);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const lo = box.min.getComponent(k), s = size.getComponent(k) || 1;
      q[i * 3 + k] = Math.round(((P[i * 3 + k] - lo) / s) * 65535);
      nn[i * 3 + k] = Math.round(THREE.MathUtils.clamp(N[i * 3 + k], -1, 1) * 127);
    }
  }
  const I = g.index.array;
  const cav = Uint8Array.from(cavity(g), (x) => Math.round(x * 255));
  const idx = n < 65536 ? Uint16Array.from(I) : Uint32Array.from(I);
  const header = new TextEncoder().encode(JSON.stringify({
    v: 2, vertices: n, indices: I.length, index32: n >= 65536, min: box.min.toArray(), max: box.max.toArray(), cavity: true,
  }));
  const pad = (x) => (x + 3) & ~3;
  const hl = pad(header.length), pl = pad(q.byteLength), nl = pad(nn.byteLength), cl = pad(cav.byteLength);
  const buf = new Uint8Array(4 + hl + pl + nl + cl + idx.byteLength);
  new DataView(buf.buffer).setUint32(0, hl, true);
  buf.set(header, 4);
  buf.fill(32, 4 + header.length, 4 + hl); // pad JSON with spaces
  buf.set(new Uint8Array(q.buffer), 4 + hl);
  buf.set(new Uint8Array(nn.buffer), 4 + hl + pl);
  buf.set(cav, 4 + hl + pl + nl);
  buf.set(new Uint8Array(idx.buffer), 4 + hl + pl + nl + cl);
  writeFileSync(OUT + name + '.bin', buf);
  const mean = cav.reduce((a, b) => a + b, 0) / cav.length / 255;
  console.log(`${name}.bin  verts ${n}  tris ${I.length / 3}  bytes ${buf.length}  size ${size.toArray().map((x) => x.toFixed(2))}  cavity mean ${mean.toFixed(3)}`);
}

/** Scale, then drop onto y = 0 and centre on x/z = 0 at the bounding box. */
function normalise(pieces, scale, rotY = 0) {
  const m = new THREE.Matrix4().makeRotationY(rotY).premultiply(new THREE.Matrix4().makeScale(scale, scale, scale));
  pieces.forEach((p) => p.applyMatrix4(m));
  const box = new THREE.Box3();
  pieces.forEach((p) => { p.computeBoundingBox(); box.union(p.boundingBox); });
  const t = new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  pieces.forEach((p) => p.applyMatrix4(t));
  return t.multiply(m);
}

// ---------------------------------------------------------------------------------------------
// Equestrian group: horse (walking, near fore leg raised, neck arched) + rider waving.
const X = V(1, 0, 0);

const HORSE_POSE = [
  ['Neck1', { aim: [0, 0.62, 0.78] }],
  ['Neck2', { aim: [0, 0.78, 0.62] }],
  ['Neck3', { aim: [0, 0.55, 0.83] }],
  ['Head', { aim: [0, -0.9, 0.42], scale: 0.9 }], // the rig's cartoon head is oversized
  ['FrontUpperLegL', { aim: [0.05, -0.42, 0.9] }],
  ['FrontLowerLegL', { aim: [0, -0.92, -0.38] }],
  ['FrontUpperLegR', { aim: [0, -1, -0.04] }],
  ['FrontLowerLegR', { aim: [0, -1, 0.02] }],
  ['Tail1', { rot: [[X, 30]] }],
  ['Ear1L', { scale: 0.72 }],
  ['Ear1R', { scale: 0.72 }],
];
const RIDER_POSE = [
  ['Torso', { rot: [[X, 4]] }],
  ['UpperLegL', { aim: [0.72, -0.42, 0.55] }],
  ['UpperLegR', { aim: [-0.72, -0.42, 0.55] }],
  ['LowerLegL', { aim: [0.06, -0.97, -0.2] }], // shins hang down the flanks
  ['LowerLegR', { aim: [-0.06, -0.97, -0.2] }],
  ['FootL', { to: 'LowerLegL_end', aim: [0.1, 0.05, 1] }],
  ['FootR', { to: 'LowerLegR_end', aim: [-0.1, 0.05, 1] }],
  ['UpperArmR', { aim: [-0.92, 0.08, 0.36] }],
  ['LowerArmR', { aim: [-0.08, 1, 0.1] }],
  ['PalmR', { aim: [0, 1, 0.02], twist: 60 }],
  ['FingersR', { aim: [0.02, 1, 0.06] }], // open, waving hand (the clip curls the fingers)
  ['Thumb1R', { aim: [-0.55, 0.75, 0.3] }],
  ['UpperArmL', { aim: [0.2, -0.8, 0.45] }],
  ['LowerArmL', { aim: [-0.25, -0.15, 1] }],
  ['PalmL', { aim: [-0.1, -0.2, 1] }],
  ['Head', { rot: [[X, 3]] }],
];

async function bakeEquestrian() {
  const horse = await load(SRC + '/horse_brown.glb');
  pose(horse, 'Walk', 0.0, HORSE_POSE);
  // keep the eyeballs (Eye_Black): without them the sockets are holes that show the sky
  const horseBase = bakeSkinned(horse.scene, ['Eye_White']);
  // A barb stallion: stockier than the stylised rig (wider barrel and neck).
  horseBase.applyMatrix4(new THREE.Matrix4().makeScale(1.22, 1, 1));
  horseBase.computeVertexNormals();

  const man = await load(SRC + '/man_suit.glb');
  const mb = pose(man, 'Man_Sitting', 1.0, RIDER_POSE);
  const hf = headFit(man.scene);
  const mw = (n) => mb[n].getWorldPosition(V(0, 0, 0));
  let manBase = bakeSkinned(man.scene, ['Eyes'], { torso: /^(Hips|Abdomen|Torso|Shoulder)/, head: /^(Head|Neck)/ });
  // An overcoated statesman, not the rig's slim suit: broader chest and shoulders (driven by the
  // torso bones' skin weights, so it blends into arms and neck), then cloth thickness everywhere
  // but the face.
  {
    const P = manBase.attributes.position, wT = manBase.attributes.torso.array, wH = manBase.attributes.head.array;
    const c = mw('Torso');
    for (let i = 0; i < P.count; i++) {
      const k = wT[i];
      P.setX(i, c.x + (P.getX(i) - c.x) * (1 + 0.26 * k));
      P.setZ(i, c.z + (P.getZ(i) - c.z) * (1 + 0.16 * k));
    }
    inflate(manBase, (i) => 0.05 * (1 - wH[i]));
  }
  positionsOnly(manBase);
  const MS = 0.88; // man units → horse units (rider in proportion with the horse)
  const riderM = new THREE.Matrix4().compose(V(0.0, 2.0, 0.5), new THREE.Quaternion(), V(MS * 1.14, MS, MS * 1.12));
  manBase.applyMatrix4(riderM);
  const rw = (n) => mw(n).applyMatrix4(riderM);

  // chéchia: a tall felt cap, slightly tapered, flat-topped with a soft crown edge
  const cr = hf.rx * 1.04, h0 = hf.top - 0.26 * hf.H, ch = 0.62 * hf.H;
  const fez = lathe([[0, 0], [cr, 0], [cr * 1.01, 0.06], [cr * 0.93, ch * 0.92], [cr * 0.86, ch], [cr * 0.5, ch * 1.02], [0, ch * 1.02]], 32,
    V(hf.c.x, h0, (hf.zFront + hf.zBack) / 2), 1, ((hf.zFront - hf.zBack) / 2 + 0.01) / cr).applyMatrix4(riderM);

  // Overcoat skirt: falls from the waist over the thighs and the saddle at the sides and back
  // (open in front where the thighs come forward); whatever passes into the horse is hidden.
  const hip = rw('Hips'), waistY = rw('Abdomen').y + 0.05, hemY = 2.42;
  const coatPt = (u, v, inset) => {
    const a = D(58) + u * D(244); // 0 = forward (+z)
    const rx = 0.46 + 0.62 * Math.pow(v, 0.85), rz = 0.36 + 0.5 * Math.pow(v, 0.9);
    const k = 1 + v * (0.05 * Math.sin(a * 9 + 1.3) + 0.03 * Math.sin(a * 17 + 0.4)) - inset;
    return V(hip.x + Math.sin(a) * rx * k, waistY - v * (waistY - hemY) + 0.04 * v * Math.cos(a * 9), hip.z - 0.06 + Math.cos(a) * rz * k);
  };
  const coat = [grid(48, 18, (u, v) => coatPt(u, v, 0)), flip(grid(48, 18, (u, v) => coatPt(u, v, 0.05))),
    tube(Array.from({ length: 49 }, (_, i) => coatPt(i / 48, 1, 0.025)), [0.03, 0.03], 6, 96),
    ...[0, 1].map((u) => tube(Array.from({ length: 13 }, (_, i) => coatPt(u, i / 12, 0.025)), [0.03, 0.03], 6, 24))];

  // Tack, laid over the horse's back by ray casting (horse units): saddle cloth, saddle on it.
  const core = () => 2.35;
  const cloth = drape(horseBase, {
    z0: -1.05, z1: 0.8, core, off: 0.035, thick: 0.03, hem: 0.03,
    drop: (s) => 1.12 * (1 - 0.22 * Math.pow(Math.abs(2 * s - 1), 6)),
  });
  const saddle = drape(horseBase, {
    z0: -0.72, z1: 0.62, core, off: 0.1, thick: 0.08, hem: 0.035, nu: 24, nv: 20,
    drop: (s) => 0.62 * (1 - 0.3 * Math.pow(Math.abs(2 * s - 1), 3)),
    // padded seat, raised pommel (front) and cantle (back)
    lift: (s, t) => (1 - t * t) * (0.2 * THREE.MathUtils.smoothstep(s, 0.72, 1) + 0.26 * (1 - THREE.MathUtils.smoothstep(s, 0, 0.3))) + 0.05 * (1 - t * t),
  });
  // Stirrups under the balls of the feet, leathers up to the saddle's skirt; reins from the left
  // hand to the bit rings either side of the mouth, sagging a little.
  const irons = [];
  for (const [side, n] of [[1, 'L'], [-1, 'R']]) {
    const f = rw(`Foot${n}`).add(V(side * 0.02, -0.06, 0.1));
    const w2 = 0.1, hS = 0.2;
    irons.push(tube([V(f.x - w2, f.y + hS, f.z), V(f.x - w2 * 1.1, f.y + hS * 0.4, f.z), V(f.x - w2, f.y, f.z), V(f.x + w2, f.y, f.z),
      V(f.x + w2 * 1.1, f.y + hS * 0.4, f.z), V(f.x + w2, f.y + hS, f.z)], [0.022, 0.022], 6, 24));
    irons.push(boxGeo(w2 * 2, 0.025, 0.14, new THREE.Matrix4().makeTranslation(f.x, f.y, f.z)));
    const top = raycast(horseBase, V(0, 2.35, f.z - 0.05), V(side * Math.sin(D(55)), Math.cos(D(55)), 0)).p;
    irons.push(tube([V(f.x, f.y + hS, f.z), V((f.x + top.x) / 2 + side * 0.06, (f.y + top.y) / 2, f.z - 0.02), top.clone().add(V(side * 0.12, 0, 0))], [0.02, 0.02], 5, 12));
  }
  let tip = 0;
  const HP = horseBase.attributes.position;
  for (let i = 1; i < HP.count; i++) if (HP.getZ(i) > HP.getZ(tip)) tip = i;
  const muzzle = V(HP.getX(tip), HP.getY(tip), HP.getZ(tip));
  const hand = rw('PalmL').add(V(0, -0.05, 0.1));
  const reins = [];
  for (const side of [-1, 1]) {
    const bit = muzzle.clone().add(V(side * 0.15, -0.16, -0.3));
    reins.push(tube([hand, hand.clone().lerp(bit, 0.33).add(V(side * 0.18, -0.12, 0)), hand.clone().lerp(bit, 0.7).add(V(side * 0.2, -0.06, 0)), bit], [0.016, 0.016], 5, 30));
    reins.push(tube(Array.from({ length: 9 }, (_, k) => bit.clone().add(V(side * 0.012, Math.sin((k / 8) * Math.PI * 2) * 0.06, Math.cos((k / 8) * Math.PI * 2) * 0.06))), [0.012, 0.012], 5, 12));
  }

  const HS = 0.82; // horse 4.82 units → ~3.9 m to the ear tips (well over life size, like the original)
  // far version (THREE.LOD level 1): one subdivision of the horse, raw rider, no irons/reins
  const lod = [loopSubdivide(horseBase), manBase.clone(), fez.clone(), ...coat.slice(0, 2).map((g) => g.clone()), ...cloth.slice(0, 2).map((g) => g.clone()), ...saddle.slice(0, 2).map((g) => g.clone())].map(finish);
  const fine = [loopSubdivide(loopSubdivide(horseBase)), loopSubdivide(manBase), fez, ...coat, ...cloth, ...saddle, ...irons, ...reins].map(finish);
  const M = normalise(fine, HS);
  write('equestrian', fine);
  lod.forEach((g) => g.applyMatrix4(M));
  write('equestrian_lod', lod);
}

// ---------------------------------------------------------------------------------------------
// Ibn Khaldoun: scholar wrapped in a wide burnous over a long gown, turban, a large book held
// upright against the chest in the right hand, the left hand raised in front of it.
const SCHOLAR_POSE = [
  ['UpperArmR', { aim: [-0.16, -0.96, 0.22] }],
  ['LowerArmR', { aim: [0.66, -0.02, 0.75] }],
  ['UpperArmL', { aim: [0.24, -0.93, 0.28] }],
  // open left hand raised to chest height beside the book, palm toward it (as on the statue)
  ['LowerArmL', { aim: [-0.5, 0.3, 0.81] }],
  ['PalmL', { aim: [-0.3, 0.62, 0.72] }],
  ['FingersL', { aim: [-0.25, 0.7, 0.66] }],
  ['Thumb1L', { aim: [-0.7, 0.5, 0.5] }],
  ['PalmR', { aim: [0.75, 0.3, 0.6] }],
  ['FingersR', { aim: [0.5, 0.75, 0.4] }], // curled up the book's edge
  ['Head', { rot: [[X, 5]] }],
];
// Facade angel of the cathedral: robed, hands joined at the chest, wings folded behind.
const ANGEL_POSE = [
  ['UpperArmR', { aim: [-0.1, -0.95, 0.3] }],
  ['LowerArmR', { aim: [0.55, 0.55, 0.62] }],
  ['UpperArmL', { aim: [0.1, -0.95, 0.3] }],
  ['LowerArmL', { aim: [-0.55, 0.55, 0.62] }],
  ['Head', { rot: [[X, 12]] }],
];

async function bakeScholar({ name = 'scholar', poseEdits = SCHOLAR_POSE, fine = true, height = 4.1, book = true, turbanOn = true, wings = false, frame = null } = {}) {
  const man = await load(SRC + '/man_suit.glb');
  const b = pose(man, 'Man_Standing', 0.0, poseEdits);
  const w = (n) => b[n].getWorldPosition(V(0, 0, 0));
  const hf = headFit(man.scene);
  // head (face, ears, hair, beard) smoothed; the hands kept as modelled (thin fingers shrink under
  // subdivision)
  const headRaw = bakeParts(man.scene, ['Skin', 'Hair'], /^(Head|Neck)/);
  if (turbanOn) {
    // full beard (as on the statue): the jaw and chin pushed out and down, fading above the mouth
    const zc = (hf.zFront + hf.zBack) / 2;
    inflate(headRaw, (i) => {
      const P = headRaw.attributes.position;
      const t = THREE.MathUtils.smoothstep(P.getY(i), hf.top - 0.6 * hf.H, hf.top - 0.9 * hf.H) * THREE.MathUtils.smoothstep(P.getZ(i), zc - 0.04, zc + 0.1);
      P.setY(i, P.getY(i) - 0.07 * t * t);
      return 0.055 * t;
    });
  }
  const head = fine ? loopSubdivide(headRaw) : headRaw;
  const hands = bakeParts(man.scene, ['Skin'], /^(Palm|Fingers|Thumb|MiddleHand)/);

  const sL = w('UpperArmL'), sR = w('UpperArmR'), neck = w('Neck');
  const cx = (sL.x + sR.x) / 2, cz = neck.z - 0.02;
  const shY = (sL.y + sR.y) / 2 + 0.1;
  const halfW = Math.abs(sL.x - sR.x) / 2 + 0.1;

  // Burnous profile (radial scale × halfW, height): collar → rounded shoulders → bell to the hem.
  const prof = new THREE.CatmullRomCurve3([
    V(0.42, shY + 0.36, 0), V(0.54, shY + 0.28, 0), V(0.84, shY + 0.14, 0), V(1.1, shY - 0.04, 0),
    V(1.24, shY - 0.34, 0), V(1.3, shY - 0.9, 0), V(1.44, shY * 0.45, 0), V(1.6, shY * 0.2, 0), V(1.74, 0.02, 0),
  ]);
  // v: 0 = collar → 1 = hem on the ground; u: 0..1 around from the front-left edge.
  const cloak = (u, v, inset) => {
    const open = 0.14 + 0.36 * Math.pow(v, 1.1);
    const a = open + u * (Math.PI * 2 - 2 * open);
    const p = prof.getPointAt(v);
    const bell = THREE.MathUtils.smoothstep(v, 0.25, 1);
    // soft hanging folds: a few smooth harmonics, deepening toward the hem (no creases)
    const fold = (0.012 + 0.07 * bell) * (0.62 * Math.sin(a * 4 + 0.9) + 0.3 * Math.sin(a * 7 + 2.1 + v * 1.5) + 0.14 * Math.sin(a * 13 + 0.4) * bell);
    const k = (1 + fold - inset) * p.x * halfW;
    const depth = 0.7 + 0.14 * bell; // front-back / side-side ratio
    // the back hangs a little further out than the front (shoulder blades, hood)
    const back = Math.cos(a) < 0 ? 1 + 0.12 * (1 - bell) : 1;
    return V(cx + Math.sin(a) * k, p.y, cz + Math.cos(a) * k * depth * back);
  };
  const NU = fine ? 110 : 48, NV = fine ? 64 : 26;
  const outer = grid(NU, NV, (u, v) => cloak(u, v, 0));
  const inner = flip(grid(NU, NV, (u, v) => cloak(u, v, 0.05)));
  const edge = (side) => tube(Array.from({ length: 16 }, (_, i) => cloak(side, i / 15, 0.025)), [0.03, 0.045, 0.055], fine ? 8 : 5, fine ? 48 : 20);
  const hem = tube(Array.from({ length: 48 }, (_, i) => cloak(i / 47, 1, 0.025)), [0.055, 0.055], fine ? 8 : 5, fine ? 140 : 56);
  // Long gown under the cloak, with soft vertical folds.
  const gown = grid(fine ? 64 : 28, fine ? 30 : 12, (u, v) => {
    const a = u * Math.PI * 2, y = (shY - 0.2) * (1 - v) + 0.02;
    const r = halfW * (0.52 + 0.34 * v) * (1 + 0.04 * Math.sin(a * 9) * (0.3 + v));
    return V(cx + Math.sin(a) * r, y, cz + 0.04 + Math.cos(a) * r * 0.8);
  }, true);
  // Wide sleeves from inside the cloak to the wrists.
  const sleeve = (side) => {
    const s = w(`UpperArm${side}`), e = w(`LowerArm${side}`), p = w(`Palm${side}`);
    const wr = e.clone().lerp(p, 0.9);
    const t = tube([s, s.clone().lerp(e, 0.5), e, e.clone().lerp(wr, 0.5), wr], [0.19, 0.19, 0.18, 0.19, 0.22], fine ? 16 : 8, fine ? 30 : 12);
    // cuff: disc closing the sleeve just inside its mouth (the hand emerges from it)
    const dir = wr.clone().sub(e).normalize();
    const cuff = lathe([[0.215, 0], [0, 0.02]], fine ? 16 : 8).applyMatrix4(new THREE.Matrix4().compose(
      wr.clone().addScaledVector(dir, -0.03), new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), dir), V(1, 1, 1)));
    return mergeGeometries([t, cuff]);
  };
  // Turban fitted to the actual skull: the head surface above a brow line (lower at the back)
  // pushed out along its normals, the cloth wound in diagonal bands, the rim closed back onto
  // the head so no gap shows from below.
  const turban = (() => {
    const g = headRaw.clone();
    g.computeVertexNormals();
    const P = g.attributes.position, N = g.attributes.normal, I = g.index.array, H = hf.H;
    const zc = (hf.zFront + hf.zBack) / 2;
    const cut = (z) => hf.top - H * THREE.MathUtils.lerp(0.5, 0.33, THREE.MathUtils.smoothstep(z, zc - 0.05, hf.zFront));
    const sel = (i) => P.getY(i) > cut(P.getZ(i));
    const tris = [];
    for (let f = 0; f < I.length; f += 3) if (sel(I[f]) && sel(I[f + 1]) && sel(I[f + 2])) tris.push(I[f], I[f + 1], I[f + 2]);
    const used = [...new Set(tris)], map = new Map(used.map((v, k) => [v, k]));
    const n = used.length, pos = new Float32Array(n * 6);
    used.forEach((v, k) => {
      const x = P.getX(v), y = P.getY(v), z = P.getZ(v);
      const a = Math.atan2(x - hf.c.x, z - zc), t = THREE.MathUtils.clamp((y - cut(z)) / (hf.top - cut(z)), 0, 1);
      const band = Math.pow(0.5 + 0.5 * Math.sin(a * 2 + (y / H) * 24), 3) * (1 - THREE.MathUtils.smoothstep(t, 0.75, 1));
      const d = 0.085 + 0.07 * Math.sin(Math.PI * Math.min(1, t * 1.3)) + 0.05 * band;
      pos.set([x + N.getX(v) * d, y + N.getY(v) * d, z + N.getZ(v) * d], k * 3); // outer skin
      pos.set([x, y, z], (n + k) * 3); // on the skull (rim closure)
    });
    const idx = tris.map((v) => map.get(v));
    // rim: edges used by one selected triangle → quad from the skin down to the skull
    const cnt = new Map();
    for (let f = 0; f < idx.length; f += 3) for (let e = 0; e < 3; e++) {
      const u = idx[f + e], w = idx[f + ((e + 1) % 3)], key = u < w ? u * n + w : w * n + u;
      cnt.set(key, (cnt.get(key) ?? 0) + 1);
    }
    for (let f = 0, L = idx.length; f < L; f += 3) for (let e = 0; e < 3; e++) {
      const u = idx[f + e], w = idx[f + ((e + 1) % 3)], key = u < w ? u * n + w : w * n + u;
      if (cnt.get(key) === 1) idx.push(w, u, n + u, w, n + u, n + w);
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setIndex(idx);
    return fine ? loopSubdivide(out) : out;
  })();
  // Folio upright on the right forearm, leaning against the chest.
  const palm = w('PalmR'), elbow = w('LowerArmR');
  const bookC = V(palm.x * 0.6 + elbow.x * 0.4 - 0.02, palm.y + 0.36, cz + halfW * 0.66 + 0.1);
  // bound folio: boards, a slightly inset page block and a rounded spine
  const bookM = new THREE.Matrix4().compose(bookC, new THREE.Quaternion().setFromEuler(new THREE.Euler(D(-10), D(10), D(-4))), V(1, 1, 1));
  const book_ = mergeGeometries([
    boxGeo(0.62, 0.84, 0.035, new THREE.Matrix4().makeTranslation(0, 0, 0.075)),
    boxGeo(0.62, 0.84, 0.035, new THREE.Matrix4().makeTranslation(0, 0, -0.075)),
    boxGeo(0.58, 0.8, 0.13, new THREE.Matrix4().makeTranslation(0.015, 0, 0)),
    positionsOnly(new THREE.CylinderGeometry(0.095, 0.095, 0.84, 10, 1, false, Math.PI, Math.PI)).translate(-0.3, 0, 0),
  ].map((g) => (g.index ? g : mergeVertices(g)))).applyMatrix4(bookM);
  const pieces = [finish(head), finish(hands), finish(outer), finish(inner), finish(edge(0)), finish(edge(1)), finish(hem),
    finish(gown), finish(sleeve('R')), finish(sleeve('L'))];
  if (turbanOn) pieces.push(finish(turban));
  if (book) pieces.push(finish(book_));
  if (wings) {
    // folded wings: curved feathered blades rising behind the shoulders
    for (const side of [-1, 1]) {
      const sh = w(side < 0 ? 'UpperArmR' : 'UpperArmL');
      pieces.push(finish(grid(10, 16, (u, v) => {
        const len = 3.4, span = 0.55 * Math.sin(Math.PI * Math.min(1, u * 1.1)) * (1 - 0.6 * v);
        const y = sh.y + 0.9 - v * len + Math.sin(u * Math.PI) * 0.1;
        const x = sh.x + side * (0.12 + span * 0.35 + 0.08 * Math.sin(v * 9) * u);
        const z = cz - 0.45 - span - 0.12 * v;
        return V(x, y, z - 0.02 * Math.sin(u * 20));
      })));
      pieces.push(finish(flip(grid(10, 16, (u, v) => {
        const len = 3.4, span = 0.55 * Math.sin(Math.PI * Math.min(1, u * 1.1)) * (1 - 0.6 * v);
        const y = sh.y + 0.9 - v * len + Math.sin(u * Math.PI) * 0.1;
        const x = sh.x + side * (0.12 + span * 0.35 + 0.08 * Math.sin(v * 9) * u) - side * 0.05;
        const z = cz - 0.45 - span - 0.12 * v;
        return V(x, y, z - 0.02 * Math.sin(u * 20));
      }))));
    }
  }
  const box0 = new THREE.Box3();
  pieces.forEach((p) => { p.computeBoundingBox(); box0.union(p.boundingBox); });
  let M = frame;
  if (M) pieces.forEach((p) => p.applyMatrix4(M));
  else M = normalise(pieces, height / (box0.max.y - box0.min.y));
  write(name, pieces);
  return M;
}

// ---------------------------------------------------------------------------------------------
// Théâtre Municipal crowning group (stucco high relief): two rearing horses flanking a standing
// allegory with raised arms, reclining figures at both ends. Low poly on purpose (seen at 15 m+).
async function bakeRelief() {
  const pieces = [];
  for (const side of [-1, 1]) {
    const horse = await load(SRC + '/horse_brown.glb');
    pose(horse, 'Idle', 0.0, [
      ['Body', { rot: [[X, -38]] }],
      ['FrontUpperLegL', { aim: [0.1, -0.1, 1] }],
      ['FrontLowerLegL', { aim: [0, -1, 0.1] }],
      ['FrontUpperLegR', { aim: [-0.1, 0.1, 1] }],
      ['FrontLowerLegR', { aim: [0, -0.9, -0.2] }],
      ['BackUpperLegL', { aim: [0.05, -1, 0.15] }],
      ['BackLowerLegL', { aim: [0, -1, 0.2] }],
      ['BackUpperLegR', { aim: [-0.05, -1, 0.25] }],
      ['BackLowerLegR', { aim: [0, -1, 0.1] }],
      ['Neck1', { aim: [0, 0.8, 0.6] }],
      ['Head', { aim: [0, -0.3, 1] }],
    ]);
    const g = bakeSkinned(horse.scene, ['Eye_White', 'Eye_Black']);
    // horse faces +Z → turn to face outward along ±X, then move out from the centre
    g.applyMatrix4(new THREE.Matrix4().makeRotationY(side * Math.PI / 2));
    g.computeBoundingBox();
    g.translate(side * 3.2 - (g.boundingBox.min.x + g.boundingBox.max.x) / 2, -g.boundingBox.min.y, 0);
    pieces.push(finish(g));
  }
  const man = await load(SRC + '/man_suit.glb');
  pose(man, 'Man_Standing', 0.0, [
    ['UpperArmR', { aim: [-0.55, 0.8, 0.2] }], ['LowerArmR', { aim: [-0.3, 1, 0.1] }],
    ['UpperArmL', { aim: [0.55, 0.8, 0.2] }], ['LowerArmL', { aim: [0.3, 1, 0.1] }],
  ]);
  const fig = bakeSkinned(man.scene, ['Eyes']).applyMatrix4(new THREE.Matrix4().makeScale(1.25, 1.25, 1.25));
  fig.computeBoundingBox();
  fig.translate(0, -fig.boundingBox.min.y, 0);
  pieces.push(finish(fig));
  for (const side of [-1, 1]) {
    const r = await load(SRC + '/man_suit.glb');
    pose(r, 'Man_Sitting', 1.0, [
      ['Hips', { rot: [[V(0, 0, 1), side * 60]] }],
      ['UpperArmR', { aim: [-0.3, -0.6, 0.5] }], ['UpperArmL', { aim: [0.3, 0.6, 0.4] }],
    ]);
    const g = bakeSkinned(r.scene, ['Eyes']);
    g.computeBoundingBox();
    g.translate(side * 7.4 - (g.boundingBox.min.x + g.boundingBox.max.x) / 2, -g.boundingBox.min.y, 0);
    pieces.push(finish(g));
  }
  // flatten into high relief
  const box = new THREE.Box3();
  pieces.forEach((p) => { p.computeBoundingBox(); box.union(p.boundingBox); });
  const cz = (box.min.z + box.max.z) / 2;
  pieces.forEach((p) => { p.translate(0, 0, -cz); p.scale(1, 1, 0.5); p.computeVertexNormals(); });
  normalise(pieces, 0.55);
  write('relief', pieces);
}

await bakeEquestrian();
const scholarFrame = await bakeScholar();
await bakeScholar({ name: 'scholar_lod', fine: false, frame: scholarFrame });
await bakeScholar({ name: 'angel', poseEdits: ANGEL_POSE, fine: false, height: 2.5, book: false, turbanOn: false, wings: true });
await bakeRelief();

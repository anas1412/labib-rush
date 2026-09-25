// Facade helpers shared by the landmark buildings. All work in a local facade frame given by a
// matrix M: x along the facade, y up (0 = ground), +z out of the face; the wall face is z = 0.
import { Path, Shape, type Material, type Matrix4, type BufferGeometry } from 'three';
import { Bucket, archOutline, archivolt, box, extrude, lathe, openingPanel, wall, type Opening } from './kit';

const at = (M: Matrix4, g: BufferGeometry, x = 0, y = 0, z = 0) => g.translate(x, y, z).applyMatrix4(M);

/** Wall slab w×h, thickness t behind the face (z from -t to 0), with openings; x0 = left edge. */
export function facadeWall(b: Bucket, mat: Material, M: Matrix4, w: number, h: number, t: number, openings: Opening[] = [], x0 = -w / 2, y0 = 0): void {
  b.add(mat, at(M, wall(w, h, t, openings, x0), 0, y0, -t));
}

/** Glass (or dark void) panels filling the openings, set back `inset` from the face. */
export function fillOpenings(b: Bucket, mat: Material, M: Matrix4, openings: Opening[], inset: number, y0 = 0): void {
  for (const o of openings) b.add(mat, at(M, openingPanel(o), 0, y0, -inset));
}

/** Moulded frame around an opening: band width `band`, projecting `out` from the face. */
export function frame(b: Bucket, mat: Material, M: Matrix4, o: Opening, band: number, out: number, y0 = 0): void {
  const kind = o.kind ?? 'round';
  const outer = archOutline(o.cx, o.y0 - 0.001, o.w + 2 * band, kind === 'flat' ? o.spring + band : o.spring, kind);
  const inner = archOutline(o.cx, o.y0 + 0.02, o.w, o.spring, kind);
  const s = new Shape(outer);
  s.holes.push(new Path(inner.slice().reverse()));
  b.add(mat, at(M, extrude(s, out, 12), 0, y0, 0));
}

/** Window sill: a projecting slab under the opening. */
export function sill(b: Bucket, mat: Material, M: Matrix4, o: Opening, band: number, y0 = 0): void {
  b.add(mat, at(M, box(o.w + 2 * band + 0.14, 0.12, 0.22), o.cx, y0 + o.y0 - 0.12, 0.08));
}

/** Round archivolt ring over a round-arched opening (radius from the opening). */
export function archRing(b: Bucket, mat: Material, M: Matrix4, o: Opening, band: number, out: number, y0 = 0): void {
  b.add(mat, at(M, archivolt(o.w / 2, band, out, 20), o.cx, y0 + o.spring, 0));
}

/** Complete arched window: frame + sill + recessed glass. */
export function archWindow(b: Bucket, stone: Material, glass: Material, M: Matrix4, o: Opening, opts: { band?: number; out?: number; inset?: number; y0?: number } = {}): void {
  const band = opts.band ?? 0.22, out = opts.out ?? 0.12, y0 = opts.y0 ?? 0;
  frame(b, stone, M, o, band, out, y0);
  sill(b, stone, M, o, band, y0);
  fillOpenings(b, glass, M, [o], opts.inset ?? 0.3, y0);
}

/** Stone column with base and cushion capital, base on the origin (local frame). */
export function column(h: number, r: number, segs = 12): BufferGeometry {
  const cap = Math.min(0.45, h * 0.12);
  return lathe([
    [r * 1.45, 0], [r * 1.45, 0.08], [r * 1.25, 0.14], [r * 1.05, 0.2], [r, 0.26],
    [r * 0.94, h - cap - 0.06], [r * 1.08, h - cap], [r * 1.2, h - cap * 0.55], [r * 1.5, h - cap * 0.2],
    [r * 1.55, h - 0.001], [0, h],
  ], segs);
}

/** Flat annulus (ring) in XY, extruded `depth` toward +Z. */
export function ring(rIn: number, rOut: number, depth: number, segs = 32): BufferGeometry {
  const s = new Shape();
  s.absarc(0, 0, rOut, 0, Math.PI * 2, false);
  const h = new Path();
  h.absarc(0, 0, rIn, 0, Math.PI * 2, true);
  s.holes.push(h);
  return extrude(s, depth, segs);
}

/** Row of small blind arches (arcaded corbel frieze), x centred on 0, from y = 0 up to `h`. */
export function blindArcade(b: Bucket, face: Material, back: Material, M: Matrix4, length: number, h: number, archW: number, y0: number, t = 0.18): void {
  const n = Math.max(1, Math.round(length / (archW * 1.5)));
  const pitch = length / n;
  const ops: Opening[] = [];
  for (let i = 0; i < n; i++) ops.push({ cx: -length / 2 + pitch * (i + 0.5), y0: 0.05, w: archW, spring: h - archW / 2 - 0.08 });
  facadeWall(b, face, M, length, h, t, ops, -length / 2, y0);
  b.add(back, at(M, box(length, h, 0.02), 0, y0, -t - 0.01));
}

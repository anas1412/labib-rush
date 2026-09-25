// Loader for the baked statue meshes in public/models/landmarks/*.bin (written by
// dev/landmarks.bake.mjs). Format, little endian:
//   u32 headerBytes | JSON header (padded to 4) | u16×3 positions quantised to [min,max]
//   (padded to 4) | i8×3 normals (padded to 4) | [u8 cavity 0..255 (padded to 4), if header.cavity]
//   | u16 or u32 indices
// Origin at the bottom centre, meters, facing +Z.
import { BufferAttribute, BufferGeometry, FileLoader, LOD, Mesh, type Material } from 'three';
import type { Assets } from '../../core/assets';

interface Header {
  v: number;
  vertices: number;
  indices: number;
  index32: boolean;
  min: [number, number, number];
  max: [number, number, number];
  cavity?: boolean; // v2: per-vertex concavity for the bronze patina (attribute `cavity`, 0..1)
}

const pad4 = (n: number) => (n + 3) & ~3;

export async function loadStatueMesh(assets: Assets, url: string): Promise<BufferGeometry> {
  // Share the game's LoadingManager so the loading screen counts the download.
  const buf = (await new FileLoader(assets.manager).setResponseType('arraybuffer').loadAsync(url)) as ArrayBuffer;
  const hl = new DataView(buf).getUint32(0, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl))) as Header;
  let o = 4 + hl;
  const q = new Uint16Array(buf, o, h.vertices * 3);
  o += pad4(q.byteLength);
  const n8 = new Int8Array(buf, o, h.vertices * 3);
  o += pad4(n8.byteLength);
  let cav: Uint8Array | null = null;
  if (h.cavity) {
    cav = new Uint8Array(buf, o, h.vertices);
    o += pad4(cav.byteLength);
  }
  const idx = h.index32 ? new Uint32Array(buf, o, h.indices) : new Uint16Array(buf, o, h.indices);

  const pos = new Float32Array(h.vertices * 3);
  const nor = new Float32Array(h.vertices * 3);
  for (let i = 0; i < h.vertices * 3; i++) {
    const k = i % 3;
    pos[i] = h.min[k] + (q[i] / 65535) * (h.max[k] - h.min[k]);
    nor[i] = n8[i] / 127;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nor, 3));
  if (cav) g.setAttribute('cavity', new BufferAttribute(cav.slice(), 1, true));
  g.setIndex(new BufferAttribute(idx.slice(), 1));
  g.computeBoundingSphere();
  return g;
}

/** Statue as a THREE.LOD: the full bake up close, the light `_lod` bake beyond `dist` meters
 *  (the renderer picks the level per frame; the shadow pass uses the same level). */
export function statueLOD(name: string, near: BufferGeometry, far: BufferGeometry, mat: Material, dist = 45): LOD {
  const lod = new LOD();
  lod.name = name;
  for (const [g, d] of [[near, 0], [far, dist]] as const) {
    const mesh = new Mesh(g, mat);
    mesh.name = `${name}:${d ? 'far' : 'near'}`;
    mesh.castShadow = mesh.receiveShadow = true;
    lod.addLevel(mesh, d);
  }
  return lod;
}

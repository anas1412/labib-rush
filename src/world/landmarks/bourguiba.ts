// Equestrian statue of Habib Bourguiba (promenade, reinstalled 2016): bronze rider waving on a
// walking horse, on a tall stepped cream-marble plinth. Faces west (−X), down the avenue.
import { Group, type BufferGeometry } from 'three';
import { CURB, LANDMARKS } from '../../core/layout';
import { Bucket, T, box, flat, lathe } from './kit';
import type { Env, Landmark } from './env';
import { statueLOD } from './statueMesh';

export function buildBourguiba(env: Env, statue: BufferGeometry, far: BufferGeometry): Landmark {
  const m = env.mats;
  const { x: X0, z: Z0 } = LANDMARKS.bourguibaStatue;
  const b = new Bucket();
  let y = CURB;

  // Two low steps, the tall main block with a sloped (chamfered) shoulder, then the stepped dado.
  b.add(m.stoneWarm, box(7.6, 0.25, 5.4), T(X0, y, Z0)); y += 0.25;
  b.add(m.stoneWarm, box(6.9, 0.3, 4.7), T(X0, y, Z0)); y += 0.3;
  const bw = 6.2, bd = 3.9, bh = 3.5;
  b.add(m.stoneWarm, box(bw, bh, bd), T(X0, y, Z0)); y += bh;
  // chamfer: frustum from the block to the dado footprint (4-sided lathe = square pyramid slice)
  const chamfer = flat(lathe([[0, 0], [Math.SQRT1_2 * 1, 0], [Math.SQRT1_2 * 0.84, 0.55], [0, 0.55]], 4, Math.PI / 4));
  b.add(m.stoneWarm, chamfer, T(X0, y, Z0, 0, 0, 0, [bw, 1, bd]));
  y += 0.55;
  b.add(m.stoneWarm, box(bw * 0.84 - 0.1, 1.1, bd * 0.84 - 0.1), T(X0, y, Z0)); y += 1.1;
  b.add(m.stoneWarm, box(bw * 0.84 + 0.12, 0.22, bd * 0.84 + 0.12), T(X0, y, Z0)); y += 0.22;
  b.add(m.stoneWarm, box(bw * 0.82, 0.16, bd * 0.8), T(X0, y, Z0)); y += 0.16;

  const root = b.build('bourguiba');
  const fig = statueLOD('bourguiba:statue', statue, far, m.bronzeGreen);
  fig.position.set(X0, y - 0.02, Z0);
  fig.rotation.y = -Math.PI / 2; // statue faces +Z → west (−X)
  const group = new Group();
  group.add(root, fig);

  env.aabb(X0 - 3.8, CURB, Z0 - 2.7, X0 + 3.8, CURB + 0.25, Z0 + 2.7);
  env.aabb(X0 - 3.45, CURB + 0.25, Z0 - 2.35, X0 + 3.45, CURB + 0.55, Z0 + 2.35);
  env.aabb(X0 - bw / 2, CURB, Z0 - bd / 2, X0 + bw / 2, y, Z0 + bd / 2);
  return { root: group };
}

// Labib the fennec — the player avatar (visual only; the controller moves `root`).
// Built fully procedurally at load (see ./labib/*): SDF-sculpted skinned body, shell fur, procedural
// animation with spring secondary motion. Swap this module to use an authored GLB later.
import {
  Group, InstancedBufferGeometry, LOD, Matrix4, Object3D, Quaternion, SkinnedMesh, Sphere, Vector3, type BufferGeometry, type Material,
} from 'three';
import type { AvatarAction, AvatarMotion, BuildContext, LabibAvatar } from '../core/types';
import type { BodySet, LabibBodyData } from './labib/body';
import { toGeometry } from './labib/builder';
import { buildRig, EAR_LEN, P, TAIL_PTS, bi } from './labib/rig';
import { createMaterials, type LabibUniforms } from './labib/materials';
import { Animator } from './labib/anim';
import { createChechia, createTrail } from './labib/extras';

const SHELLS = { low: 0, medium: 0, high: 10, ultra: 14 } as const;
/** Camera → feet distance (m) beyond which the coarse sculpt is drawn (the gameplay camera sits at ~6 m). */
const LOD_DIST = 3.6;
/** Update() calls during which the hidden chéchia and trail stay in the scene (at zero size), so the
 *  engine's loading-time compile or the first rendered frames build their shader programs. */
const WARM_FRAMES = 30;

/** Build info for tooling / the dev page, stored in `root.userData.labibStats`. */
export interface LabibStats {
  triangles: number; // near (close-up) sculpt
  farTriangles: number; // coarse sculpt beyond LOD_DIST (0 when there is none)
  shellTriangles: number; // at the maximum shell count
  bones: number;
  buildMs: number;
  inWorker: boolean;
  parts: { name: string; tris: number; ms: number }[];
}

/** Runs the (CPU-heavy) body sculpt in a worker; falls back to the main thread (once) if the worker fails
 *  or goes silent (e.g. never starts, or is killed under memory pressure), so loading can't hang. A slow but
 *  running build (it posts a heartbeat first) gets a generous deadline instead of being duplicated. */
function buildBodyAsync(quality: BuildContext['quality']): Promise<LabibBodyData & { inWorker: boolean }> {
  const inline = () => import('./labib/body').then((m) => ({ ...m.buildBody(quality), inWorker: false }));
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./labib/worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(inline());
      return;
    }
    let settled = false;
    const settle = (result: () => Promise<LabibBodyData & { inWorker: boolean }> | (LabibBodyData & { inWorker: boolean })) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(result());
    };
    let timer = setTimeout(() => settle(inline), 10000);
    worker.onmessage = (e: MessageEvent<LabibBodyData | { alive: true }>) => {
      const d = e.data;
      if ('alive' in d) { clearTimeout(timer); timer = setTimeout(() => settle(inline), 60000); return; }
      settle(() => ({ ...d, inWorker: true }));
    };
    worker.onerror = worker.onmessageerror = () => settle(inline);
    worker.postMessage({ quality });
  });
}

export async function createLabib(ctx: BuildContext): Promise<LabibAvatar> {
  const t0 = performance.now();
  const body = await buildBodyAsync(ctx.quality);
  const shellSrc = body.shell ? toGeometry(body.shell) : null;
  const rig = buildRig();
  const u: LabibUniforms = {
    uFlash: { value: 0 },
    uRadar: { value: 0 },
    uGravity: { value: new Vector3(0, -1, 0) },
    uWindL: { value: new Vector3() },
    uDrag: { value: new Vector3() },
    uShells: { value: SHELLS[ctx.quality] },
    uSprint: { value: 0 },
  };
  const mats = createMaterials(ctx.quality, u, ctx.uniforms, ctx.renderer);

  const root = new Object3D();
  root.name = 'Labib';
  const rigGroup = new Group(); // squash/stretch + lean pivot at the feet
  root.add(rigGroup);
  rigGroup.add(rig.bones[0]);

  const bounds = new Sphere(new Vector3(0, 0.78, -0.05), 1.05);
  const identity = new Matrix4();
  const geometries: BufferGeometry[] = [];
  const skinned = (g: BufferGeometry, m: Material, shadow: boolean, parent: Object3D) => {
    const s = new SkinnedMesh(g, m);
    s.bind(rig.skeleton, identity);
    s.boundingSphere = bounds;
    s.castShadow = shadow;
    s.receiveShadow = true;
    parent.add(s);
    geometries.push(g);
    return s;
  };
  // one level of detail = the three material groups, all bound to the same skeleton
  const level = (set: BodySet) => {
    const g = new Group();
    skinned(toGeometry(set.fur), mats.fur, true, g);
    skinned(toGeometry(set.cloth), mats.cloth, true, g);
    skinned(toGeometry(set.gloss), mats.gloss, false, g);
    return g;
  };
  // three.js updates LOD visibility per render (before the shadow pass), from the camera → feet distance
  const lod = new LOD();
  lod.addLevel(level(body.near), 0);
  if (body.far) lod.addLevel(level(body.far), LOD_DIST, 0.08);
  rigGroup.add(lod);

  // fur shells: the fur geometry's attributes, fur triangles only, drawn N times (instanced)
  const maxShells = SHELLS[ctx.quality];
  if (mats.shell && shellSrc && maxShells > 0) {
    const sg = new InstancedBufferGeometry();
    for (const name of Object.keys(shellSrc.attributes)) sg.setAttribute(name, shellSrc.getAttribute(name));
    sg.setIndex(shellSrc.getIndex());
    sg.boundingSphere = bounds;
    sg.instanceCount = maxShells;
    const shells = skinned(sg, mats.shell, false, rigGroup);
    shells.renderOrder = 1;
    const fullCount = sg.getIndex()!.count;
    // fewer shells when the camera is far away (fur detail is sub-pixel anyway); from the gameplay camera
    // only the tail + ear silhouettes (the index prefix) get a few, beyond ~14 m none
    const camPos = new Vector3(), me = new Vector3();
    shells.onBeforeRender = (_r, _s, camera) => {
      camPos.setFromMatrixPosition(camera.matrixWorld);
      me.setFromMatrixPosition(root.matrixWorld);
      const d = camPos.distanceTo(me);
      const far = d > LOD_DIST;
      const n = d > 14 ? 0 : far ? 3 : Math.max(4, Math.min(maxShells, Math.round(maxShells * (1.8 / Math.max(d, 0.1)) ** 0.8)));
      sg.setDrawRange(0, far ? body.shellFarCount : fullCount);
      sg.instanceCount = n;
      u.uShells.value = Math.max(n, 1);
    };
  }

  // chéchia on the head bone
  const head = rig.bones[bi('head')];
  const chechia = createChechia(mats.felt, ctx.quality === 'low' ? 20 : 40);
  // sits on the crown between the ears (the head is sculpted at 1.2× scale), tilted back a touch;
  // cartoon-oversized so the ×2 power-up reads from the chase camera
  const CHECHIA_SCALE = 1.5;
  chechia.root.position.set(0, 1.226 - P.head[1], -0.01 - P.head[2]);
  chechia.root.rotation.set(-0.14, 0, 0.06);
  chechia.root.scale.setScalar(0.001); // hidden after the warm-up frames (see WARM_FRAMES)
  head.add(chechia.root);

  // mint speed trail from the ear tips and the tail tip
  const trail = createTrail(mats.trail, 3, 16);
  root.add(trail.mesh);
  const earTipL = rig.bones[bi('ear3L')], earTipR = rig.bones[bi('ear3R')], tailTip = rig.bones[bi('tail4')];
  const earOff = new Vector3(0, EAR_LEN * 0.34, 0);
  const tailOff = new Vector3(TAIL_PTS[5][0] - TAIL_PTS[4][0], TAIL_PTS[5][1] - TAIL_PTS[4][1], TAIL_PTS[5][2] - TAIL_PTS[4][2]);
  const anchors = [new Vector3(), new Vector3(), new Vector3()];
  const anchorsL = [new Vector3(), new Vector3(), new Vector3()]; // smoothed, avatar-local
  const invRoot = new Matrix4();

  const anim = new Animator(rig);
  let chechiaOn = false, chechiaS = 0, chechiaV = 0;
  let radarOn = false, radar = 0;
  let trailOn = false, trailFade = 0;
  let tasselX = 0, tasselV = 0, tasselZ = 0, tasselVZ = 0;
  let time = 0, warm = WARM_FRAMES;
  const q = new Quaternion();
  const prev = new Vector3(), vel = new Vector3(), tmp = new Vector3();
  let primed = false;

  const stats: LabibStats = {
    triangles: body.near.triangles,
    farTriangles: body.far ? body.far.triangles : 0,
    shellTriangles: shellSrc ? (shellSrc.index!.count / 3) * maxShells : 0,
    bones: rig.bones.length,
    buildMs: Math.round(performance.now() - t0),
    inWorker: body.inWorker,
    parts: body.parts,
  };

  root.userData.labibStats = stats;

  return {
    root,
    height: body.headTop,

    update(dt: number, motion: AvatarMotion) {
      time += dt;
      if (warm > 0) warm--;
      anim.out.earSpread = chechiaS * 0.12;
      anim.update(dt, motion, root);
      const o = anim.out;
      rigGroup.scale.set(1 / Math.sqrt(o.squash), o.squash, 1 / Math.sqrt(o.squash));
      rigGroup.rotation.set(o.leanX, 0, o.leanZ);
      u.uFlash.value = o.flash;

      // chéchia pop (spring with overshoot) + tassel pendulum
      const target = chechiaOn ? 1 : 0;
      chechiaV += ((target - chechiaS) * 260 - chechiaV * 16) * dt;
      chechiaS = Math.max(0, chechiaS + chechiaV * dt);
      chechia.root.visible = chechiaS > 0.01 || warm > 0;
      chechia.root.scale.setScalar(Math.max(0.001, chechiaS) * CHECHIA_SCALE);

      // radar: soft pulsing emissive on the ears
      radar += ((radarOn ? 1 : 0) - radar) * (1 - Math.exp(-dt * 8));
      u.uRadar.value = radar * (0.38 + 0.3 * Math.sin(time * Math.PI * 2 * 1.6));

      // frame for shell forces
      root.updateWorldMatrix(true, false);
      root.getWorldQuaternion(q).invert();
      tmp.setFromMatrixPosition(root.matrixWorld);
      if (primed && dt > 0) vel.subVectors(tmp, prev).divideScalar(dt);
      prev.copy(tmp);
      primed = true;
      const w = ctx.uniforms.uWind.value;
      u.uWindL.value.set(w.x, 0, w.z).multiplyScalar(0.05 * (1 + w.y)).applyQuaternion(q);
      u.uGravity.value.set(0, -1, 0).applyQuaternion(q);
      u.uDrag.value.copy(vel).multiplyScalar(-0.035).applyQuaternion(q).clampLength(0, 0.45);

      tasselV += (-tasselX * 90 - tasselV * 5 + u.uDrag.value.z * 40) * dt;
      tasselX += tasselV * dt;
      tasselVZ += (-tasselZ * 90 - tasselVZ * 5 - u.uDrag.value.x * 40) * dt;
      tasselZ += tasselVZ * dt;
      chechia.tassel.rotation.set(tasselX, 0, tasselZ);

      // world matrices now (so the trail anchors and next frame's springs see this pose)
      root.updateWorldMatrix(false, true);
      trailFade += ((trailOn ? 1 : 0) - trailFade) * (1 - Math.exp(-dt * (trailOn ? 10 : 4)));
      u.uSprint.value = trailFade * (0.5 + 0.12 * Math.sin(time * 9));
      if (trailFade > 0.001 || trail.mesh.visible) {
        // anchors smoothed in the avatar's frame: the ribbons flow instead of zig-zagging with every
        // bounce, without lagging behind the ear tips at sprint speed (as world-space smoothing would)
        const k = trailFade < 0.01 ? 1 : 1 - Math.exp(-dt * 18);
        invRoot.copy(root.matrixWorld).invert();
        anchorsL[0].lerp(tmp.copy(earOff).applyMatrix4(earTipL.matrixWorld).applyMatrix4(invRoot), k);
        anchorsL[1].lerp(tmp.copy(earOff).applyMatrix4(earTipR.matrixWorld).applyMatrix4(invRoot), k);
        anchorsL[2].lerp(tmp.copy(tailOff).applyMatrix4(tailTip.matrixWorld).applyMatrix4(invRoot), k);
        for (let i = 0; i < 3; i++) anchors[i].copy(anchorsL[i]).applyMatrix4(root.matrixWorld);
        trail.update(anchors, trailFade < 0.002 ? 0 : trailFade, dt);
      }
      if (warm > 0) trail.mesh.visible = true; // zero width while faded out
    },

    trigger(action: AvatarAction) {
      anim.trigger(action);
    },
    setChechia(on: boolean) {
      if (on && !chechiaOn) chechiaV = 6;
      chechiaOn = on;
    },
    setRadarGlow(on: boolean) {
      radarOn = on;
    },
    setSprintTrail(on: boolean) {
      trailOn = on;
    },
    dispose() {
      root.removeFromParent();
      for (const g of geometries) g.dispose();
      shellSrc?.dispose();
      chechia.dispose();
      trail.dispose();
      for (const m of mats.list) m.dispose();
      for (const t of mats.textures) t.dispose();
      rig.skeleton.dispose();
    },
  };
}

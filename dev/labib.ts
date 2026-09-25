// Labib preview: turntable + states/actions via URL.
//   ?anim=idle|walk|run|sprint|jump|fall|stun   locomotion state (walk/run animate in place)
//   ?action=kick|pickup|deposit|hit|victory|caught|jump|land   (re-triggered every ?every=s, default 2.5)
//   ?at=0.3        freeze `at` seconds after the action starts (deterministic screenshots)
//   ?chechia=1 &radar=1 &trail=1 &spin=0.4 (turntable rad/s) &yaw=0.5 (fixed facing) &turn=1.5 (turnRate)
//   ?move=1        actually travel forward at the state's speed (camera follows)
//   ?freeze=0.5    (no action) freeze after 0.5 s of deterministic idle — before the first glance
//   plus the harness params (?cam=x,y,z&target=x,y,z&fov=&q=)
import * as THREE from 'three';
import { createHarness } from './harness';
import { createLabib } from '../src/player/labib';
import type { AvatarAction, AvatarMotion, AvatarState } from '../src/core/types';

const qs = new URLSearchParams(location.search);
const h = await createHarness({ cam: [0, 2.6, 5.5], target: [0, 0.7, 0] });

// warm stone paving so the character sits in a plausible light environment
const tile = document.createElement('canvas');
tile.width = tile.height = 256;
const g = tile.getContext('2d')!;
g.fillStyle = '#b9ab98';
g.fillRect(0, 0, 256, 256);
for (let i = 0; i < 4000; i++) {
  g.fillStyle = `rgba(${90 + Math.random() * 60},${80 + Math.random() * 50},${70 + Math.random() * 40},0.18)`;
  g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
}
g.strokeStyle = 'rgba(70,60,50,0.45)';
g.lineWidth = 3;
for (let i = 0; i <= 256; i += 128) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
const tex = new THREE.CanvasTexture(tile);
tex.colorSpace = THREE.SRGBColorSpace;
tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
tex.repeat.set(40, 40);
tex.anisotropy = 8;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
h.scene.add(ground);

const labib = await createLabib(h.ctx);
h.scene.add(labib.root);
// dev-only handles for scripted checks (stats, leak test)
Object.assign(window, { __labib: { height: +labib.height.toFixed(3), ...labib.root.userData.labibStats }, __labibRoot: labib.root, __harness: h });

const anim = (qs.get('anim') || 'idle') as AvatarState | 'sprint';
const speeds: Record<string, number> = { idle: 0, walk: 2.2, run: 6.5, sprint: 9.5, jump: 5, fall: 5, stun: 0 };
const motion: AvatarMotion = {
  state: anim === 'sprint' ? 'run' : anim,
  speed: Number(qs.get('speed') ?? speeds[anim] ?? 0),
  maxSpeed: 6.5,
  verticalVelocity: anim === 'jump' ? 6 : anim === 'fall' ? -6 : 0,
  grounded: anim !== 'jump' && anim !== 'fall',
  turnRate: Number(qs.get('turn') ?? 0),
};
labib.setChechia(qs.get('chechia') === '1');
labib.setRadarGlow(qs.get('radar') === '1');
labib.setSprintTrail(qs.get('trail') === '1' || anim === 'sprint');

const action = qs.get('action') as AvatarAction | null;
const every = Number(qs.get('every') ?? 2.5);
const at = qs.get('at') !== null ? Number(qs.get('at')) : null;
const spin = Number(qs.get('spin') ?? 0);
labib.root.rotation.y = Number(qs.get('yaw') ?? 0);

// deterministic warm-up (springs settle), then optional freeze-frame
const step = 1 / 60;
for (let i = 0; i < 90; i++) labib.update(step, motion);
let frozen = false;
if (action && at !== null) {
  labib.trigger(action);
  for (let t = 0; t < at; t += step) labib.update(step, motion);
  frozen = true;
} else if (qs.get('freeze') !== null) {
  for (let t = 0; t < Number(qs.get('freeze')); t += step) labib.update(step, motion);
  frozen = true;
}

let sinceAction = every;
const move = qs.get('move') === '1';
const delta = new THREE.Vector3();
h.onFrame((dt) => {
  if (frozen) return;
  if (spin) labib.root.rotation.y += spin * dt;
  if (move && motion.speed > 0) {
    // travel forward; the camera follows so the framing stays put (trail/drag need real motion)
    const yaw = labib.root.rotation.y;
    delta.set(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(motion.speed * dt);
    if (labib.root.position.length() > 30) delta.copy(labib.root.position).negate();
    labib.root.position.add(delta);
    h.camera.position.add(delta);
    h.controls.target.add(delta);
  }
  if (action) {
    sinceAction += dt;
    if (sinceAction >= every) { sinceAction = 0; labib.trigger(action); }
  }
  labib.update(dt, motion);
});
h.ready();

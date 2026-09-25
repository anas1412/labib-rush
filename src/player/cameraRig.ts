// Third-person orbit camera: smoothed pivot at Labib's head, look-ahead, gentle auto-recentre,
// spring arm (sphere cast vs G.STATIC only; patient with line-of-sight blockers, rises over the
// head when blocked close behind), sprint FOV kick, trauma shake and a cinematic menu mode.
// yaw 0 looks toward +Z (same convention as the player's facing).
import { MathUtils, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { ALL, G, groups, type Physics } from '../core/physics';
import { PLAYER } from '../core/config';
import { PLAYER_SPAWN_YAW, TREE_ROWS_Z } from '../core/layout';
import type { CameraRig, InputFrame, PlayerController, Settings } from '../core/types';

const HEAD = 1.3; // pivot height above the feet
const AIM_UP = 0.45; // look slightly over the head so the avenue ahead gets more of the frame
const DISTANCE = 5.5;
const PITCH_MIN = MathUtils.degToRad(-10);
const PITCH_MAX = MathUtils.degToRad(55);
const PITCH_DEFAULT = MathUtils.degToRad(13);
const PROBE_RADIUS = 0.22; // sphere radius of the spring-arm cast (> near-plane half diagonal)
const ARM_OUT_SPEED = 3.5; // m/s the arm may lengthen again after being pushed in
// A trunk or lamp post sweeping across the arm while running past must not pump the zoom: the arm
// snaps in only when the camera itself would be inside geometry. A wall, kiosk or plinth that
// merely blocks the line of sight is tolerated for OCCLUDE_DELAY, then the arm pulls in fast.
// Thin round colliders (trunks, posts) never pull it in: pulling in behind a trunk leaves nothing
// to see (it is as tall as the camera can rise), while a trunk in front of Labib reads naturally
// and clears with any step.
const OCCLUDE_DELAY = 0.2; // s
const THIN_RADIUS = 0.45; // m
const OCCLUDE_RATE = 28; // 1/s
// Blocked right behind Labib (back to a wall): the camera rises and looks over his head instead of
// collapsing into it. Full lift when the arm is ≤ LIFT_FULL_AT, none from LIFT_NONE_AT.
const LIFT_PITCH = MathUtils.degToRad(60);
const LIFT_UP = 0.35; // m the orbit centre rises at full lift
const LIFT_ARM = 3; // m, arm length at full lift (when the space allows)
const LIFT_FULL_AT = 0.8, LIFT_NONE_AT = 2.2;
const HIDE_BELOW = 0.55, SHOW_ABOVE = 0.75; // m, hide the avatar when the camera is this close
const RECENTRE_AFTER = 1.5; // s without manual look
const RECENTRE_RATE = 1.6; // 1/s at run speed, for straight-ahead input
const RECENTRE_MAX = 0.6; // rad/s cap on the auto-turn (≥ 11 m turning circle at run speed)
const LOOK_AHEAD = 0.14; // s of velocity
const LOOK_AHEAD_MAX = 1.1; // m
const FOV = 60;
const FOV_SPRINT = 68;
const SHAKE_ANGLE = MathUtils.degToRad(2.2);
const SHAKE_OFFSET = 0.12; // m
const SHAKE_FREQ = 16; // Hz of the shake noise
const MENU_BLEND = 1.1; // s to glide from the menu shot into gameplay

// Menu shot: west end of the promenade, between the ficus rows, looking east.
const MENU_X0 = -233, MENU_TRAVEL = 16, MENU_PERIOD = 70; // s for a full dolly in/out cycle
const menuRowMid = (TREE_ROWS_Z[0] + TREE_ROWS_Z[1]) / 2;

/** Smooth 1D gradient noise in [-1, 1] (Perlin-style, integer lattice). */
function noise1(x: number, seed: number): number {
  const i = Math.floor(x), f = x - i;
  const grad = (n: number) => {
    const h = Math.sin((n + seed * 57.13) * 127.1) * 43758.5453;
    return (h - Math.floor(h)) * 2 - 1;
  };
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return MathUtils.lerp(grad(i) * f, grad(i + 1) * (f - 1), u) * 2;
}

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

export function createCameraRig(camera: PerspectiveCamera, physics: Physics, settings: Settings): CameraRig {
  const { world, R } = physics;
  let cfg = settings;
  let yaw = PLAYER_SPAWN_YAW;
  let pitch = PITCH_DEFAULT;
  let arm = DISTANCE; // at the player's own pitch
  let lift = 0; // 0..1 over-the-head lift
  let occluded = 0; // s the line of sight has been blocked
  let avatarHidden: PlayerController['avatar'] | null = null;
  let idleLook = 0;
  let snap = true; // next update jumps straight to the target pose
  const pivot = new Vector3();
  const ahead = new Vector3();
  let fov = FOV;

  let trauma = 0, traumaDecay = 1, shakeT = 0;

  let menu = false, menuT = 0, blend = 1; // blend: 0 = menu pose, 1 = gameplay pose
  const blendFromPos = new Vector3();
  const blendFromQuat = new Quaternion();
  let blendFromFov = FOV;

  const probe = new R.Ball(PROBE_RADIUS);
  const probeRot = { x: 0, y: 0, z: 0, w: 1 };
  const staticOnly = groups(ALL, G.STATIC);
  const noSensors = R.QueryFilterFlags.EXCLUDE_SENSORS;
  const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });

  const v1 = new Vector3(), v2 = new Vector3(), dir = new Vector3(), aim = new Vector3();
  const UP = new Vector3(0, 1, 0);
  const q1 = new Quaternion();

  let hitThin = false; // was the last sweep's first hit a trunk / post?
  /** Free distance from `from` along unit `d` (up to `max`) for a sphere, vs static geometry. */
  function sweep(from: Vector3, d: Vector3, max: number): number {
    const hit = world.castShape(from, probeRot, d, probe, 0, max, true, noSensors, staticOnly);
    if (!hit) { hitThin = false; return max; }
    const t = hit.collider.shapeType();
    hitThin = (t === R.ShapeType.Cylinder || t === R.ShapeType.Ball || t === R.ShapeType.Capsule) && hit.collider.radius() <= THIN_RADIUS;
    return hit.time_of_impact;
  }

  /** Would the camera sphere at `at` overlap static geometry? */
  function inside(at: Vector3): boolean {
    return world.intersectionWithShape(at, probeRot, probe, noSensors, staticOnly) !== null;
  }

  function rayFree(from: Vector3, d: Vector3, max: number): number {
    ray.origin = from; ray.dir = d;
    const hit = world.castRay(ray, max, true, noSensors, staticOnly);
    return hit ? hit.timeOfImpact : max;
  }

  function menuPose(dt: number, outPos: Vector3, outAim: Vector3): void {
    menuT += dt;
    const ph = (menuT / MENU_PERIOD) * Math.PI * 2;
    const x = MENU_X0 + MENU_TRAVEL * (0.5 - 0.5 * Math.cos(ph));
    outPos.set(x, 2.7 + 0.3 * Math.sin(ph * 0.5 + 0.8), menuRowMid + 1.1 * Math.sin(ph * 0.7));
    outAim.set(x + 60, 3.2 + 0.5 * Math.sin(ph * 0.9), menuRowMid + 2.2 * Math.sin(ph * 0.45 + 1.3));
  }

  function update(dt: number, input: InputFrame, target: PlayerController): void {
    dt = Math.min(dt, 0.1);
    shakeT += dt;
    trauma = Math.max(0, trauma - traumaDecay * dt);

    if (menu) {
      showAvatar();
      menuPose(dt, v1, aim);
      camera.position.copy(v1);
      camera.lookAt(aim);
      fov += (FOV - fov) * damp(4, dt);
      applyFov();
      return;
    }

    // ---- manual look & auto-recentre ----
    const looked = input.lookDX !== 0 || input.lookDY !== 0;
    yaw = wrapPi(yaw - input.lookDX);
    pitch = MathUtils.clamp(pitch + input.lookDY, PITCH_MIN, PITCH_MAX);
    idleLook = looked ? 0 : idleLook + dt;
    const vx = target.velocity.x, vz = target.velocity.z;
    const speed = Math.hypot(vx, vz);
    const mx = input.move.x, my = input.move.y, ml = Math.hypot(mx, my);
    if (idleLook > RECENTRE_AFTER && speed > 1.2 && ml > 0.2 && !target.stunned) {
      // Movement is camera-relative, so turning the camera during a strafe or diagonal would steer
      // Labib in circles: recentre only for mostly-forward input, gently, with a capped turn rate.
      const w = MathUtils.smoothstep(my / ml, 0.5, 0.95); // 0 beyond 60° off forward, 1 within 18°
      const diff = wrapPi(Math.atan2(vx, vz) - yaw);
      if (w > 0 && Math.abs(diff) < MathUtils.degToRad(100)) { // never swing round mid-reversal
        const sf = Math.min(1, speed / PLAYER.runSpeed);
        const maxStep = RECENTRE_MAX * w * dt;
        yaw = wrapPi(yaw + MathUtils.clamp(diff * damp(RECENTRE_RATE * w * sf, dt), -maxStep, maxStep));
        pitch += (PITCH_DEFAULT - pitch) * damp(0.8 * w * sf, dt);
      }
    }

    // ---- pivot (head) with separate horizontal / vertical smoothing ----
    const p = target.position;
    if (snap) {
      pivot.set(p.x, p.y + HEAD, p.z);
      ahead.set(0, 0, 0);
    } else {
      const kh = damp(20, dt), kv = damp(target.grounded ? 10 : 5, dt);
      pivot.x += (p.x - pivot.x) * kh;
      pivot.z += (p.z - pivot.z) * kh;
      pivot.y += (p.y + HEAD - pivot.y) * kv;
      v1.set(vx, 0, vz).multiplyScalar(LOOK_AHEAD);
      if (v1.lengthSq() > LOOK_AHEAD_MAX * LOOK_AHEAD_MAX) v1.setLength(LOOK_AHEAD_MAX);
      ahead.lerp(v1, damp(3, dt));
    }

    // Look-ahead shifts the orbit centre, but never into a wall: ray from the real head first.
    v2.set(p.x, p.y + HEAD, p.z); // unsmoothed head, always in free space
    v1.copy(pivot).add(ahead).sub(v2);
    const shift = v1.length();
    const centre = v2;
    if (shift > 1e-4) {
      dir.copy(v1).multiplyScalar(1 / shift);
      const free = Math.max(0, rayFree(v2, dir, shift + PROBE_RADIUS + 0.1) - PROBE_RADIUS - 0.1);
      centre.addScaledVector(dir, Math.min(shift, free));
    }

    // ---- spring arm (at the player's pitch) ----
    armDir(pitch);
    const wantArm = Math.max(0.05, sweep(centre, dir, DISTANCE) - 0.05); // no minimum: never pushed into geometry
    if (snap) arm = DISTANCE;
    if (wantArm >= arm) {
      occluded = 0;
      arm = Math.min(wantArm, arm + ARM_OUT_SPEED * dt);
    } else if (inside(v1.copy(centre).addScaledVector(dir, arm))) {
      occluded = 0;
      arm = wantArm; // the camera would clip: pull in now
    } else if (!hitThin && (snap || (occluded += dt) > OCCLUDE_DELAY)) {
      arm = snap ? wantArm : arm + (wantArm - arm) * damp(OCCLUDE_RATE, dt);
    }

    // ---- over-the-head lift when the arm is blocked close behind ----
    const liftTo = 1 - MathUtils.smoothstep(arm, LIFT_FULL_AT, LIFT_NONE_AT);
    lift = snap ? liftTo : lift + (liftTo - lift) * damp(liftTo > lift ? 10 : 2.5, dt);
    let camArm = arm;
    if (lift > 1e-3) {
      centre.y += Math.min(LIFT_UP * lift, Math.max(0, rayFree(centre, UP, LIFT_UP + PROBE_RADIUS) - PROBE_RADIUS));
      armDir(MathUtils.lerp(pitch, Math.max(pitch, LIFT_PITCH), lift));
      camArm = Math.max(0.05, Math.min(sweep(centre, dir, DISTANCE) - 0.05, MathUtils.lerp(arm, LIFT_ARM, lift)));
    }
    v1.copy(centre).addScaledVector(dir, camArm);
    v1.y = Math.max(v1.y, p.y + 0.25);
    aim.copy(centre).y += AIM_UP * (camArm / DISTANCE);
    // too close to see past him: hide the avatar (hysteresis), restored as soon as the arm frees up
    if (camArm < HIDE_BELOW && !avatarHidden) { avatarHidden = target.avatar; avatarHidden.root.visible = false; }
    else if (camArm > SHOW_ABOVE) showAvatar();

    // ---- FOV kick (sprint / mint tea) ----
    const t = MathUtils.clamp((speed - PLAYER.runSpeed * 1.05) / (PLAYER.sprintSpeed - PLAYER.runSpeed * 1.05), 0, 1);
    fov += (MathUtils.lerp(FOV, FOV_SPRINT, t) - fov) * damp(snap ? 1e3 : 3.5, dt);

    if (blend < 1) {
      // glide from the frozen menu pose into the live gameplay pose
      blend = Math.min(1, blend + dt / MENU_BLEND);
      const e = blend * blend * (3 - 2 * blend);
      camera.position.copy(v1);
      camera.lookAt(aim);
      q1.copy(camera.quaternion);
      camera.position.lerpVectors(blendFromPos, v1, e);
      camera.quaternion.slerpQuaternions(blendFromQuat, q1, e);
      camera.fov = MathUtils.lerp(blendFromFov, fov, e);
      camera.updateProjectionMatrix();
    } else {
      camera.position.copy(v1);
      camera.lookAt(aim);
      applyFov();
    }
    snap = false;
    applyShake();
  }

  function armDir(pitchAngle: number): void {
    const cp = Math.cos(pitchAngle);
    dir.set(-Math.sin(yaw) * cp, Math.sin(pitchAngle), -Math.cos(yaw) * cp);
  }

  function showAvatar(): void {
    if (avatarHidden) { avatarHidden.root.visible = true; avatarHidden = null; }
  }

  function applyFov(): void {
    if (Math.abs(camera.fov - fov) > 1e-3) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }

  function applyShake(): void {
    if (trauma <= 0) return;
    const s = trauma * trauma;
    const n = shakeT * SHAKE_FREQ;
    camera.rotateY(noise1(n, 1) * SHAKE_ANGLE * s);
    camera.rotateX(noise1(n, 2) * SHAKE_ANGLE * s);
    camera.rotateZ(noise1(n, 3) * SHAKE_ANGLE * 0.6 * s);
    camera.translateX(noise1(n, 4) * SHAKE_OFFSET * s);
    camera.translateY(noise1(n, 5) * SHAKE_OFFSET * s);
  }

  return {
    get yaw() { return yaw; },
    update,
    shake(intensity: number, duration = 0.4): void {
      if (!cfg.cameraShake || intensity <= 0) return;
      trauma = Math.min(1, trauma + intensity);
      traumaDecay = Math.max(trauma / Math.max(0.05, duration), 0.5);
    },
    setSettings(s: Settings): void {
      cfg = s;
      if (!s.cameraShake) trauma = 0;
    },
    setMenuMode(on: boolean): void {
      if (on === menu) return;
      menu = on;
      if (on) {
        menuT = 0;
        blend = 1;
      } else {
        blendFromPos.copy(camera.position);
        blendFromQuat.copy(camera.quaternion);
        blendFromFov = camera.fov;
        blend = 0;
        snap = true;
      }
    },
    reset(newYaw: number): void {
      yaw = newYaw;
      pitch = PITCH_DEFAULT;
      idleLook = 0;
      occluded = 0;
      trauma = 0;
      snap = true;
    },
  };
}

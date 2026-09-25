// Labib's movement: Rapier kinematic character controller (capsule, autostep, snap-to-ground,
// wall sliding) driven by camera-relative input with arcade acceleration, coyote time, jump
// buffering and variable jump height. Visual only via the avatar; gameplay reads position/velocity.
import { MathUtils, Vector3 } from 'three';
import { G, groups, type Physics } from '../core/physics';
import { PLAYER } from '../core/config';
import { PLAYER_SPAWN, PLAYER_SPAWN_YAW, inPlayArea } from '../core/layout';
import type { Emitter } from '../core/events';
import type { AvatarMotion, AvatarState, GameEvents, InputFrame, LabibAvatar, PlayerController } from '../core/types';

const SKIN = 0.02; // character controller offset
const SNAP_DISTANCE = 0.3; // > curb height so stepping down a curb stays grounded
const MAX_CLIMB = MathUtils.degToRad(45);
const MIN_SLIDE = MathUtils.degToRad(50);
const JUMP_CUT_GRAVITY = 2.6; // extra gravity while rising with the jump button released
const KICK_COOLDOWN = 0.35;
const KILL_Y = -5;
const STUN_FRICTION = 7; // m/s² horizontal slowdown while stunned on the ground
const STEP_SMOOTH_RATE = 18; // 1/s, visual easing of instant autostep height changes
const WALK_BELOW = 3.6; // m/s: below this the avatar walks
const HALF = PLAYER.capsuleHalfHeight + PLAYER.capsuleRadius; // feet → capsule centre
const WALL_NORMAL_Y = 0.3; // contacts flatter than this are walls; curb/step edges are not

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** PlayerController plus teardown (removes the collider and the Rapier controller). */
export interface CorePlayerController extends PlayerController {
  dispose(): void;
}

export function createPlayerController(physics: Physics, avatar: LabibAvatar, events: Emitter<GameEvents>): CorePlayerController {
  const { world, R } = physics;
  const gravity = world.gravity.y; // negative, arcade gravity shared with kicked litter
  const jumpSpeed = Math.sqrt(2 * -gravity * PLAYER.jumpHeight);

  // Capsule on a kinematic position-based body: Rapier derives a velocity from each
  // setNextKinematicTranslation, so dynamic litter is pushed smoothly and fixed sensors (bins,
  // pickups) report intersections, neither of which a teleported parentless collider gets. Its
  // collision filter skips STATIC/LOW_PROP: the character controller queries those itself, and
  // kinematic-vs-fixed contact pairs would only cost narrow-phase time.
  const body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(PLAYER_SPAWN.x, PLAYER_SPAWN.y + HALF + SKIN, PLAYER_SPAWN.z));
  const collider = world.createCollider(
    R.ColliderDesc.capsule(PLAYER.capsuleHalfHeight, PLAYER.capsuleRadius)
      .setCollisionGroups(groups(G.PLAYER, G.LITTER | G.NPC | G.VEHICLE | G.SENSOR))
      .setActiveCollisionTypes(R.ActiveCollisionTypes.DEFAULT | R.ActiveCollisionTypes.KINEMATIC_FIXED | R.ActiveCollisionTypes.KINEMATIC_KINEMATIC)
      .setFriction(0),
    body,
  );
  const cc = world.createCharacterController(SKIN);
  cc.setUp({ x: 0, y: 1, z: 0 });
  cc.enableAutostep(PLAYER.stepHeight, 0.15, false);
  cc.enableSnapToGround(SNAP_DISTANCE);
  cc.setMaxSlopeClimbAngle(MAX_CLIMB);
  cc.setMinSlopeSlideAngle(MIN_SLIDE);
  cc.setSlideEnabled(true);
  cc.setApplyImpulsesToDynamicBodies(false);
  const moveGroups = groups(G.PLAYER, G.STATIC | G.LOW_PROP | G.NPC | G.VEHICLE);
  const moveFlags = R.QueryFilterFlags.EXCLUDE_SENSORS;

  const position = PLAYER_SPAWN.clone();
  const velocity = new Vector3(); // actual motion (what the world sees)
  // Intended horizontal velocity: input + momentum, projected off walls only. Kept separate from
  // `velocity` so a frame of contact with a curb edge (before autostep lifts us) costs no speed.
  let mvx = 0, mvz = 0;
  let yaw = PLAYER_SPAWN_YAW;
  const lastSafe = PLAYER_SPAWN.clone(); // last grounded spot inside the play area
  let grounded = false;
  let stunTimer = 0;
  let speedMult = 1;
  let sinceGrounded = 0; // coyote clock
  let sinceJumpPress = 1e9; // jump-buffer clock
  let jumping = false; // rising from a jump (variable height applies)
  let airTime = 0;
  let kickCooldown = 0;
  let strideAcc = 0;
  let turnRate = 0;
  let stepOffset = 0; // visual-only y offset that hides instant autostep/snap pops
  const motion: AvatarMotion = { state: 'idle', speed: 0, maxSpeed: PLAYER.runSpeed, verticalVelocity: 0, grounded: false, turnRate: 0 };

  const desired = { x: 0, y: 0, z: 0 };
  const tmp = new Vector3();
  const hit = new R.CharacterCollision();

  // The controller keeps SKIN between the capsule and the ground: offset it so `position` is on it.
  const bodyPos = { x: 0, y: 0, z: 0 };
  const setBodyPos = () => { bodyPos.x = position.x; bodyPos.y = position.y + HALF + SKIN; bodyPos.z = position.z; return bodyPos; };
  /** Puts the capsule exactly at `position` now, for this frame's queries. The render rate can
   *  outpace the physics rate, so the last setNextKinematicTranslation may not be applied yet. */
  function syncCollider(): void {
    body.setTranslation(setBodyPos(), true);
    world.propagateModifiedBodyPositionsToColliders();
  }

  function forwardPoint(dist: number, up: number): Vector3 {
    return new Vector3(position.x + Math.sin(yaw) * dist, position.y + up, position.z + Math.cos(yaw) * dist);
  }

  function reset(p: Vector3, newYaw: number): void {
    position.copy(p);
    velocity.set(0, 0, 0);
    mvx = mvz = 0;
    yaw = newYaw;
    grounded = false;
    stunTimer = 0;
    sinceGrounded = 0; sinceJumpPress = 1e9; jumping = false; airTime = 0;
    kickCooldown = 0; strideAcc = 0; turnRate = 0; stepOffset = 0;
    syncCollider();
    avatar.root.position.copy(position);
    avatar.root.rotation.set(0, yaw, 0);
  }

  function update(dt: number, input: InputFrame, cameraYaw: number): void {
    if (dt <= 0) return;
    dt = Math.min(dt, 0.1); // the capsule is swept, so hitches can't tunnel; this only bounds integration
    const stunned = stunTimer > 0;
    stunTimer = Math.max(0, stunTimer - dt);
    kickCooldown = Math.max(0, kickCooldown - dt);
    sinceGrounded = grounded ? 0 : sinceGrounded + dt;
    sinceJumpPress = input.jumpPressed && !stunned ? 0 : sinceJumpPress + dt;

    // ---- horizontal: camera-relative wish direction, move-toward acceleration ----
    const fx = Math.sin(cameraYaw), fz = Math.cos(cameraYaw); // camera forward
    let wx = 0, wz = 0, wishLen = 0;
    if (!stunned) {
      wx = fx * input.move.y - fz * input.move.x; // right = (-cos, 0, sin)
      wz = fz * input.move.y + fx * input.move.x;
      wishLen = Math.min(1, Math.hypot(wx, wz));
    }
    const sprinting = !stunned && input.sprint && wishLen > 0.1;
    const topSpeed = (sprinting ? PLAYER.sprintSpeed : PLAYER.runSpeed) * speedMult;
    let tx = 0, tz = 0;
    if (wishLen > 1e-3) {
      const k = (topSpeed * wishLen) / Math.hypot(wx, wz);
      tx = wx * k; tz = wz * k;
    }
    if (stunned) {
      const sp = Math.hypot(mvx, mvz);
      const drop = (grounded ? STUN_FRICTION : STUN_FRICTION * 0.2) * dt;
      const k = sp > drop ? (sp - drop) / sp : 0;
      mvx *= k; mvz *= k;
    } else {
      const dx = tx - mvx, dz = tz - mvz;
      // accelerating along the current velocity vs braking/turning: reversing uses both rates
      const along = mvx * tx + mvz * tz;
      let rate = wishLen > 1e-3 ? (along < 0 ? PLAYER.accel + PLAYER.decel : PLAYER.accel) : PLAYER.decel;
      if (!grounded) rate *= PLAYER.airControl;
      const dl = Math.hypot(dx, dz), maxStep = rate * dt;
      if (dl <= maxStep) { mvx = tx; mvz = tz; }
      else { mvx += (dx / dl) * maxStep; mvz += (dz / dl) * maxStep; }
    }

    // ---- vertical: jump (coyote + buffer), gravity, variable height ----
    if (!stunned && sinceJumpPress <= PLAYER.jumpBuffer && sinceGrounded <= PLAYER.coyoteTime && !jumping) {
      velocity.y = jumpSpeed;
      jumping = true; grounded = false;
      sinceJumpPress = 1e9; sinceGrounded = PLAYER.coyoteTime + 1;
      events.emit('jump', { position: position.clone() });
      avatar.trigger('jump');
    }
    let g = gravity;
    if (jumping && velocity.y > 0 && !input.jumpHeld) g *= JUMP_CUT_GRAVITY;
    const vy0 = velocity.y;
    velocity.y += g * dt;
    if (velocity.y <= 0) jumping = false;

    // ---- collide & slide ----
    desired.x = mvx * dt;
    desired.y = (vy0 + velocity.y) * 0.5 * dt; // trapezoid: exact apex at any frame rate
    desired.z = mvz * dt;
    syncCollider();
    cc.computeColliderMovement(collider, desired, moveFlags, moveGroups);
    const m = cc.computedMovement();
    const wasGrounded = grounded;
    const prevY = position.y;
    position.x += m.x; position.y += m.y; position.z += m.z;
    grounded = cc.computedGrounded();
    body.setNextKinematicTranslation(setBodyPos()); // applied (with velocity) by the next physics step

    // walls absorb the intended velocity into them (sliding keeps the tangential part)
    for (let i = 0, n = cc.numComputedCollisions(); i < n; i++) {
      const c = cc.computedCollision(i, hit);
      if (!c || Math.abs(c.normal1.y) > WALL_NORMAL_Y) continue;
      const l = Math.hypot(c.normal1.x, c.normal1.z);
      if (l < 1e-4) continue;
      const ux = c.normal1.x / l, uz = c.normal1.z / l;
      const into = mvx * ux + mvz * uz;
      if (into < 0) { mvx -= ux * into; mvz -= uz * into; }
    }
    velocity.x = m.x / dt;
    velocity.z = m.z / dt;
    if (velocity.y > 0 && m.y < desired.y * 0.5) velocity.y = 0; // head bump
    const impact = -velocity.y;
    if (grounded && velocity.y < 0) velocity.y = 0;

    if (grounded && wasGrounded) {
      // autostep / snap-down moved us vertically in one frame: ease the visual instead
      const dy = position.y - prevY - desired.y;
      if (Math.abs(dy) > 0.02 && Math.abs(dy) < PLAYER.stepHeight + 0.05) stepOffset -= dy;
    }
    stepOffset *= Math.exp(-STEP_SMOOTH_RATE * dt);

    if (!grounded) airTime += dt;
    else {
      if (!wasGrounded && airTime > 0.08) {
        events.emit('land', { position: position.clone(), impact: Math.max(0, impact) });
        avatar.trigger('land');
        strideAcc = 0;
      }
      airTime = 0;
      jumping = false;
    }

    // ---- facing ----
    const prevYaw = yaw;
    const hSpeed = Math.hypot(velocity.x, velocity.z);
    if (!stunned && wishLen > 0.1) {
      const targetYaw = Math.atan2(wx, wz);
      yaw += wrapPi(targetYaw - yaw) * (1 - Math.exp(-PLAYER.turnSpeed * dt));
      yaw = wrapPi(yaw);
    }
    turnRate += (wrapPi(yaw - prevYaw) / dt - turnRate) * (1 - Math.exp(-12 * dt));

    // ---- footsteps, kick ----
    if (grounded && hSpeed > 0.6) {
      strideAcc += hSpeed * dt;
      const stride = 1.1 + 0.08 * hSpeed; // ≈ 4 steps/s running, ≈ 5 sprinting
      if (strideAcc >= stride) {
        strideAcc -= stride;
        events.emit('footstep', { position: position.clone(), sprint: sprinting });
      }
    }
    if (input.kickPressed && !stunned && kickCooldown <= 0) {
      kickCooldown = KICK_COOLDOWN;
      events.emit('kick', { position: forwardPoint(0.7, 0.25) });
      avatar.trigger('kick');
    }

    if (position.y < KILL_Y) { reset(PLAYER_SPAWN, PLAYER_SPAWN_YAW); return; }
    if (!inPlayArea(position.x, position.z)) { reset(lastSafe, yaw); return; } // escaped over something
    if (grounded) lastSafe.copy(position);

    // ---- avatar ----
    let state: AvatarState;
    if (stunTimer > 0) state = 'stun';
    else if (!grounded && airTime > 0.06) state = velocity.y > 0 ? 'jump' : 'fall';
    else if (hSpeed < 0.3) state = 'idle';
    else state = hSpeed < WALK_BELOW ? 'walk' : 'run';
    motion.state = state;
    motion.speed = hSpeed;
    motion.maxSpeed = topSpeed;
    motion.verticalVelocity = velocity.y;
    motion.grounded = grounded;
    motion.turnRate = turnRate;
    avatar.root.position.set(position.x, position.y + stepOffset, position.z);
    avatar.root.rotation.set(0, yaw, 0);
    avatar.update(dt, motion);
  }

  function knockback(direction: Vector3, strength: number, stunSec: number): void {
    tmp.set(direction.x, 0, direction.z);
    if (tmp.lengthSq() < 1e-6) tmp.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    tmp.normalize().multiplyScalar(strength);
    mvx = velocity.x = tmp.x;
    mvz = velocity.z = tmp.z;
    velocity.y = Math.min(5, 1.5 + strength * 0.25); // small hop so it reads as a hit
    grounded = false; jumping = false;
    stunTimer = Math.max(stunTimer, stunSec);
    avatar.trigger('hit');
  }

  reset(PLAYER_SPAWN, PLAYER_SPAWN_YAW);

  return {
    position, velocity, avatar,
    get yaw() { return yaw; },
    get grounded() { return grounded; },
    get stunned() { return stunTimer > 0; },
    update,
    knockback,
    setSpeedMultiplier(mult: number) { speedMult = mult; },
    reset,
    dispose() {
      world.removeCharacterController(cc);
      world.removeRigidBody(body); // also removes the capsule collider
    },
  };
}

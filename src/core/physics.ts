// Thin wrapper around Rapier. Static colliders (buildings, props, curbs) are parentless colliders.
import RAPIER from '@dimforge/rapier3d-compat';
import { Euler, Quaternion, Vector3, type BufferGeometry, type Matrix4, type Mesh } from 'three';

/** Collision membership bits. Filter = which groups a collider interacts with. */
export const G = {
  STATIC: 0x0001,
  PLAYER: 0x0002,
  LITTER: 0x0004, // dynamic kickable litter
  NPC: 0x0008,
  VEHICLE: 0x0010,
  SENSOR: 0x0020, // trigger volumes (bins, pickups)
  LOW_PROP: 0x0040, // benches, planters: block player + litter, ignored by camera
} as const;
export const ALL = 0xffff;

/** Rapier InteractionGroups: 16 high bits = membership, 16 low bits = filter. */
export const groups = (member: number, filter: number = ALL) => ((member & 0xffff) << 16) | (filter & 0xffff);

export const FIXED_DT = 1 / 60;

const q = new Quaternion();
const e = new Euler();

export class Physics {
  readonly R = RAPIER;
  readonly world: RAPIER.World;

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81 * 1.6, z: 0 }); // arcade gravity
    this.world.timestep = FIXED_DT;
  }

  static async create(): Promise<Physics> {
    await RAPIER.init();
    return new Physics();
  }

  step(): void {
    this.world.step();
  }

  /** Static axis-aligned (optionally Y-rotated) box. center/half in meters. */
  addBox(center: Vector3, half: Vector3, rotY = 0, member: number = G.STATIC, friction = 0.6): RAPIER.Collider {
    q.setFromEuler(e.set(0, rotY, 0));
    const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setTranslation(center.x, center.y, center.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setFriction(friction)
      .setCollisionGroups(groups(member));
    return this.world.createCollider(desc);
  }

  /** Static upright cylinder (tree trunks, lamp posts, statues). center = middle of the cylinder. */
  addCylinder(center: Vector3, radius: number, halfHeight: number, member: number = G.STATIC): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cylinder(halfHeight, radius)
      .setTranslation(center.x, center.y, center.z)
      .setCollisionGroups(groups(member));
    return this.world.createCollider(desc);
  }

  /** Static triangle mesh from a geometry + world matrix. Use sparingly (ramps, steps, odd shapes). */
  addTrimesh(geometry: BufferGeometry, matrixWorld: Matrix4, member: number = G.STATIC): RAPIER.Collider {
    const pos = geometry.getAttribute('position');
    const v = new Float32Array(pos.count * 3);
    const t = new Vector3();
    for (let i = 0; i < pos.count; i++) {
      t.fromBufferAttribute(pos, i).applyMatrix4(matrixWorld);
      v.set([t.x, t.y, t.z], i * 3);
    }
    const idx = geometry.getIndex();
    const indices = idx ? new Uint32Array(idx.array) : Uint32Array.from({ length: pos.count }, (_, i) => i);
    return this.world.createCollider(RAPIER.ColliderDesc.trimesh(v, indices).setCollisionGroups(groups(member)));
  }

  addTrimeshFromMesh(mesh: Mesh, member: number = G.STATIC): RAPIER.Collider {
    mesh.updateWorldMatrix(true, false);
    return this.addTrimesh(mesh.geometry, mesh.matrixWorld, member);
  }

  removeCollider(c: RAPIER.Collider): void {
    this.world.removeCollider(c, false);
  }

  /** Ray cast; returns hit distance and point, or null. filter = groups the ray should hit. */
  raycast(origin: Vector3, dir: Vector3, maxDist: number, filter: number = G.STATIC): { distance: number; point: Vector3; collider: RAPIER.Collider } | null {
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRay(ray, maxDist, true, undefined, groups(ALL, filter));
    if (!hit) return null;
    const d = hit.timeOfImpact;
    return { distance: d, point: origin.clone().addScaledVector(dir, d), collider: hit.collider };
  }
}

// People: the downtown-Tunis crowd — pedestrians, café patrons and litterbugs.
// Each person is ONE draw call: a procedurally modelled SkinnedMesh (≤ 3k triangles, vertex
// colours + per-vertex roughness + atlas UVs) over a 20-bone skeleton, all sharing one material
// and one procedurally painted detail atlas (./people/atlas.ts: faces, hair, garment seams and
// folds). Variety is deterministic from the seed (./people/traits.ts); animation is procedural
// (./people/anim.ts).
import { Bone, Color, Group, MeshPhysicalMaterial, Skeleton, SkinnedMesh, Sphere, Vector2, Vector3, type BufferGeometry } from 'three';
import type { BuildContext, PeopleFactory, Person, PersonAnim, Quality } from '../core/types';
import { createAtlas, type PeopleAtlas } from './people/atlas';
import { Animator } from './people/anim';
import { BONE_COUNT, PARENT, buildBody, type Dims } from './people/body';
import { makeTraits, type Traits } from './people/traits';

export { PICKUP_GRAB_SEC, SEAT_HEIGHT, THROW_RELEASE_SEC } from './people/anim';

/** Per-person triangle budget (see ?audit= on dev/people.html). */
export const TRI_BUDGET = 3000;
/** People farther than this from the camera (m) don't cast shadows. */
export const SHADOW_DIST = 32;

/** Build info for tooling / the dev page: `person.root.userData.people`. */
export interface PersonStats {
  seed: number;
  triangles: number;
  vertices: number;
  parts: Record<string, number>;
  traits: Traits;
}

/** One material for the whole crowd. Albedo = vertex colour × atlas shade, with painted decals
 *  (eyes, brows, lips, stitching) mixed over it; roughness comes from the `aRough` vertex attribute;
 *  the atlas normal map adds seams, folds and fabric weave; a soft sheen gives cloth and skin their
 *  velvety grazing-angle light. */
function createMaterial(atlas: PeopleAtlas, quality: Quality): MeshPhysicalMaterial {
  const m = new MeshPhysicalMaterial({
    vertexColors: true, roughness: 1, metalness: 0, sheen: 1, sheenRoughness: 0.75, sheenColor: new Color(0.2, 0.18, 0.17),
    map: atlas.decal, normalMap: atlas.detail, normalScale: new Vector2(1, 1).multiplyScalar(quality === 'low' ? 0.6 : 1),
  });
  m.onBeforeCompile = (s) => {
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aRough;\nvarying float vRough;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRough = aRough;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vRough;')
      .replace('#include <map_fragment>', '')
      .replace('#include <color_fragment>', [
        'vec4 pDecal = texture2D( map, vMapUv );',
        'float pShade = texture2D( normalMap, vNormalMapUv ).a * 2.0;',
        'diffuseColor.rgb *= mix( vColor.rgb * pShade, pDecal.rgb, pDecal.a );',
      ].join('\n'))
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRough;');
  };
  m.customProgramCacheKey = () => 'labib-people-v2';
  return m;
}

/** Built geometry for one seed, shared (ref-counted) by every live Person with that seed. */
interface Built { geometry: BufferGeometry; joints: Vector3[]; dims: Dims; traits: Traits; stats: PersonStats; users: number }

function build(seed: number): Built {
  const traits = makeTraits(seed);
  let body = buildBody(traits);
  if (body.builder.triangleCount > TRI_BUDGET) body = buildBody(traits, true); // rare heavy outfit
  for (const drop of [() => { traits.glasses = 'none'; }, () => { traits.carry = null; }]) {
    if (body.builder.triangleCount <= TRI_BUDGET) break;
    drop();
    body = buildBody(traits, true);
  }
  const geometry = body.builder.build();
  // generous fixed bounds (poses stay within ~0.8 H of the body centre); avoids per-frame skinned bounds
  geometry.boundingSphere = new Sphere(new Vector3(0, traits.H * 0.5, 0), traits.H * 0.8);
  const stats: PersonStats = { seed, triangles: body.builder.triangleCount, vertices: body.builder.vertexCount, parts: body.parts, traits };
  return { geometry, joints: body.joints, dims: body.dims, traits, stats, users: 0 };
}

class PersonImpl implements Person {
  readonly root = new Group();
  readonly height: number;
  private readonly mesh: SkinnedMesh;
  private readonly anim: Animator;
  // off-screen throttling: frames counted in update(), stamped when the mesh / its shadow renders
  private frame = 0;
  private seenFrame = -99;
  private shadowFrame = -99;
  private pendingDt = 0;
  private disposed = false;

  constructor(built: Built, material: MeshPhysicalMaterial, shadows: boolean, private readonly onDispose: (p: PersonImpl) => void) {
    const { joints, dims, traits, stats } = built;
    this.height = dims.top;
    const bones: Bone[] = [];
    for (let i = 0; i < BONE_COUNT; i++) {
      const b = new Bone();
      const par = PARENT[i];
      b.position.copy(joints[i]);
      if (par >= 0) { b.position.sub(joints[par]); bones[par].add(b); }
      bones.push(b);
    }
    this.mesh = new SkinnedMesh(built.geometry, material);
    this.mesh.add(bones[0]);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new Skeleton(bones));
    this.mesh.boundingSphere = built.geometry.boundingSphere!.clone();
    this.mesh.castShadow = shadows;
    this.mesh.receiveShadow = true;
    this.mesh.name = `person-${stats.seed}`;
    this.mesh.onBeforeRender = (_r, _s, camera) => {
      this.seenFrame = this.frame;
      // distant people skip the shadow passes (a draw call per cascade each); decided here for the
      // next frame's shadow render
      if (shadows) {
        const e = this.mesh.matrixWorld.elements, c = camera.matrixWorld.elements;
        this.mesh.castShadow = (e[12] - c[12]) ** 2 + (e[13] - c[13]) ** 2 + (e[14] - c[14]) ** 2 < SHADOW_DIST * SHADOW_DIST;
      }
    };
    this.mesh.onBeforeShadow = () => { this.shadowFrame = this.frame; };
    this.root.add(this.mesh);
    this.root.name = `person-${stats.seed}`;

    this.anim = new Animator(bones, joints, dims, traits);
    this.anim.update(0, 0);
    this.root.userData.people = stats;
  }

  setAnim(anim: PersonAnim): void { this.anim.set(anim); }

  update(dt: number, speed: number): void {
    if (!this.root.visible) return;
    this.frame++;
    // culled for a few frames: pose at 1/6 rate (1/2 if only its shadow is drawn) so it stays roughly
    // current when it reappears
    this.pendingDt += dt;
    const onScreen = this.frame - this.seenFrame <= 3;
    const shadowOnly = !onScreen && this.frame - this.shadowFrame <= 3;
    if (!onScreen && this.frame % (shadowOnly ? 2 : 6) !== 0) return;
    this.anim.update(this.pendingDt, speed);
    this.pendingDt = 0;
  }

  setVisible(on: boolean): void { this.root.visible = on; }

  dispose(): void {
    if (this.disposed) return; // the shared geometry is ref-counted: release exactly once
    this.disposed = true;
    this.onDispose(this);
    this.root.removeFromParent();
    this.mesh.skeleton.dispose();
  }
}

export async function createPeople(ctx: BuildContext): Promise<PeopleFactory> {
  const atlas = createAtlas(ctx.quality, ctx.renderer);
  const material = createMaterial(atlas, ctx.quality);
  const shadows = ctx.quality !== 'low';
  const alive = new Set<PersonImpl>();
  const cache = new Map<number, Built>();
  return {
    create(seed: number): Person {
      let b = cache.get(seed);
      if (!b) cache.set(seed, (b = build(seed)));
      b.users++;
      const built = b;
      const p = new PersonImpl(built, material, shadows, (q) => {
        alive.delete(q);
        if (--built.users === 0) { built.geometry.dispose(); cache.delete(seed); }
      });
      alive.add(p);
      return p;
    },
    dispose(): void {
      for (const p of [...alive]) p.dispose();
      material.dispose();
      atlas.dispose();
    },
  };
}

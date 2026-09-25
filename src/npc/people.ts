// People: the downtown-Tunis crowd — pedestrians, café patrons and litterbugs.
// Each person is ONE draw call: a procedurally modelled SkinnedMesh (≤ 3k triangles, vertex
// colours + per-vertex roughness + atlas UVs) over a 24-bone skeleton, all sharing one material
// and one procedurally painted detail atlas (./people/atlas.ts: faces, hair, garment seams and
// folds). Variety is deterministic from the seed (./people/traits.ts); animation is procedural
// (./people/anim.ts). The whole crowd shares one extra draw call: soft contact / blob shadows
// (an InstancedMesh) that ground everyone beyond the shadow-map distance.
import {
  Bone, CanvasTexture, Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshBasicMaterial,
  MeshPhysicalMaterial, PlaneGeometry, Skeleton, SkinnedMesh, Sphere, Vector2, Vector3, type BufferGeometry, type Object3D,
} from 'three';
import type { BuildContext, PeopleFactory, Person, PersonAnim, Quality } from '../core/types';
import { createAtlas, type PeopleAtlas } from './people/atlas';
import { Animator } from './people/anim';
import { BONE, BONE_COUNT, PARENT, buildBody, type Dims } from './people/body';
import { makeTraits, type Traits } from './people/traits';

export { PICKUP_GRAB_SEC, PICKUP_GRIP_Y, SEAT_HEIGHT, THROW_RELEASE_SEC } from './people/anim';

/** Per-person triangle budget (see ?audit= on dev/people.html). */
export const TRI_BUDGET = 3000;
/** People farther than this from the camera (m) don't cast shadow-map shadows (each caster costs
 *  a draw call per cascade); their blob shadow grounds them instead. Low quality: blobs only. */
export const SHADOW_DIST: Record<Quality, number> = { low: 0, medium: 12, high: 18, ultra: 26 };

/** Build info for tooling / the dev page: `person.root.userData.people`. */
export interface PersonStats {
  seed: number;
  triangles: number;
  vertices: number;
  parts: Record<string, number>;
  traits: Traits;
}

export interface PeopleOptions {
  /** Atlas painting progress 0..1 (createPeople yields to the main thread while painting). */
  onProgress?: (p01: number) => void;
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
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRough;')
      // ground occlusion: surfaces facing down (under the chin, arms, drape hems, between the legs)
      // see the pavement and the body, not the sky the HDRI would otherwise light them with
      .replace('#include <lights_fragment_end>', [
        '#include <lights_fragment_end>',
        'float pDown = inverseTransformDirection( normal, viewMatrix ).y;',
        'float pOcc = mix( 0.45, 1.0, smoothstep( -0.85, 0.35, pDown ) );',
        'reflectedLight.indirectDiffuse *= pOcc;',
        'reflectedLight.indirectSpecular *= pOcc;',
        '#ifdef USE_SHEEN',
        'sheenSpecularIndirect *= pOcc;',
        '#endif',
      ].join('\n'));
  };
  m.customProgramCacheKey = () => 'labib-people-v3';
  return m;
}

// ---------------------------------------------------------------------------------------------
/** Soft elliptical blob shadows for the whole crowd in one draw call. Instance colour .r = opacity. */
class Blobs {
  readonly mesh: InstancedMesh;
  private free: number[] = [];
  private readonly zero = new Matrix4().makeScale(0, 0, 0);

  constructor(private capacity = 128) {
    const g = new PlaneGeometry(1, 1);
    g.rotateX(-Math.PI / 2);
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d')!;
    const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    // soft penumbra (alpha map = the green channel): darkest under the feet, fading out inside the quad
    for (const [o, a] of [[0, 1], [0.4, 0.82], [0.72, 0.38], [0.9, 0.1], [1, 0]] as const) { const v = Math.round(255 * a); gr.addColorStop(o, `rgb(${v},${v},${v})`); }
    x.fillStyle = gr;
    x.fillRect(0, 0, 64, 64);
    const tex = new CanvasTexture(c);
    const mat = new MeshBasicMaterial({ color: 0x000000, alphaMap: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    mat.onBeforeCompile = (s) => { s.fragmentShader = s.fragmentShader.replace('#include <color_fragment>', 'diffuseColor.a *= vColor.r;'); };
    mat.customProgramCacheKey = () => 'labib-people-blob';
    this.mesh = this.make(g, mat, capacity);
    for (let i = capacity - 1; i >= 0; i--) this.free.push(i);
  }

  private make(g: BufferGeometry, mat: MeshBasicMaterial, n: number): InstancedMesh {
    const m = new InstancedMesh(g, mat, n);
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    m.instanceColor = new InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(DynamicDrawUsage);
    for (let i = 0; i < n; i++) m.setMatrixAt(i, this.zero);
    m.frustumCulled = false; // instances are all over the map; the vertex cost is trivial
    m.castShadow = m.receiveShadow = false;
    m.renderOrder = -1; // before other transparents (it lies on the ground)
    m.name = 'people-blob-shadows';
    return m;
  }

  alloc(): number {
    if (!this.free.length) {
      // grow ×2, keeping the existing instances (rare: more live people than slots)
      const n = this.capacity * 2, old = this.mesh;
      const m = this.make(old.geometry, old.material as MeshBasicMaterial, n);
      (m.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array);
      (m.instanceColor!.array as Float32Array).set(old.instanceColor!.array);
      old.parent?.add(m);
      old.removeFromParent();
      old.dispose();
      (this as { mesh: InstancedMesh }).mesh = m;
      for (let i = n - 1; i >= this.capacity; i--) this.free.push(i);
      this.capacity = n;
    }
    return this.free.pop()!;
  }

  set(i: number, m: Matrix4, opacity: number): void {
    this.mesh.setMatrixAt(i, m);
    this.mesh.instanceColor!.setX(i, opacity);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor!.needsUpdate = true;
  }

  hide(i: number): void { this.set(i, this.zero, 0); }

  release(i: number): void { this.hide(i); this.free.push(i); }

  /** Puts the blob mesh in the scene the people live in (called from update(); cheap once added). */
  attach(root: Object3D): void {
    if (this.mesh.parent) return;
    let top = root;
    while (top.parent) top = top.parent;
    if (top !== root) top.add(this.mesh);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    const mat = this.mesh.material as MeshBasicMaterial;
    mat.alphaMap?.dispose();
    mat.dispose();
    this.mesh.dispose();
  }
}

/** State shared by the crowd: where the camera was at the last render (for shadow decisions). */
interface Shared { camX: number; camY: number; camZ: number; camKnown: boolean; shadowDist2: number; blobs: Blobs }

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

const _m = new Matrix4(), _s = new Matrix4();

class PersonImpl implements Person {
  readonly root = new Group();
  readonly height: number;
  private readonly mesh: SkinnedMesh;
  private readonly anim: Animator;
  private readonly blob: number;
  private readonly blobW: number;
  private readonly blobD: number;
  // off-screen throttling: frames counted in update(), stamped when the mesh / its shadow renders
  private frame: number;
  private seenFrame = -99;
  private shadowFrame = -99;
  private pendingDt = 0;
  private disposed = false;

  constructor(built: Built, material: MeshPhysicalMaterial, private readonly sh: Shared, private readonly onDispose: (p: PersonImpl) => void) {
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
    this.mesh.castShadow = sh.shadowDist2 > 0;
    this.mesh.receiveShadow = true;
    this.mesh.name = `person-${stats.seed}`;
    this.mesh.onBeforeRender = (_r, _s, camera) => {
      this.seenFrame = this.frame;
      const c = camera.matrixWorld.elements;
      sh.camX = c[12]; sh.camY = c[13]; sh.camZ = c[14]; sh.camKnown = true;
    };
    this.mesh.onBeforeShadow = () => { this.shadowFrame = this.frame; };
    this.root.add(this.mesh);
    this.root.name = `person-${stats.seed}`;
    this.frame = (stats.seed * 7) % 6; // culled people don't all re-pose on the same frame
    this.blob = sh.blobs.alloc();
    this.blobW = 0.62 * dims.H * traits.width;
    this.blobD = 0.5 * dims.H;

    this.anim = new Animator(bones, joints, dims, traits);
    this.anim.update(0, 0);
    this.root.userData.people = stats;
  }

  setAnim(anim: PersonAnim): void { this.anim.set(anim); }

  update(dt: number, speed: number): void {
    if (!this.root.visible) return;
    this.frame++;
    const sh = this.sh;
    sh.blobs.attach(this.root);
    // shadow-map casting by distance to the camera (decided here, so it is current even for people
    // just behind the camera whose long golden-hour shadows are on screen)
    this.root.updateWorldMatrix(false, false);
    const e = this.root.matrixWorld.elements;
    const near = sh.shadowDist2 > 0 && (!sh.camKnown || (e[12] - sh.camX) ** 2 + (e[13] - sh.camY) ** 2 + (e[14] - sh.camZ) ** 2 < sh.shadowDist2);
    this.mesh.castShadow = near;
    // blob: a faint contact shadow when the shadow map has this person, a fuller one otherwise
    _m.copy(this.root.matrixWorld).multiply(_s.makeScale(near ? this.blobW * 0.7 : this.blobW, 1, near ? this.blobD * 0.7 : this.blobD));
    _m.elements[13] += 0.012;
    sh.blobs.set(this.blob, _m, near ? 0.45 : 0.8);

    // culled for a few frames: pose at 1/6 rate (1/2 if only its shadow is drawn) so it stays roughly
    // current when it reappears
    this.pendingDt += dt;
    const onScreen = this.frame - this.seenFrame <= 3;
    const shadowOnly = !onScreen && this.frame - this.shadowFrame <= 3;
    if (!onScreen && this.frame % (shadowOnly ? 2 : 6) !== 0) return;
    this.anim.update(this.pendingDt, speed);
    this.pendingDt = 0;
  }

  setVisible(on: boolean): void {
    this.root.visible = on;
    if (!on) this.sh.blobs.hide(this.blob);
  }

  /** World position of the right (throwing / picking) hand's grip point. */
  handWorldPosition(out: Vector3): Vector3 {
    this.root.updateWorldMatrix(true, true);
    return this.mesh.skeleton.bones[BONE.trash].getWorldPosition(out);
  }

  dispose(): void {
    if (this.disposed) return; // the shared geometry is ref-counted: release exactly once
    this.disposed = true;
    this.onDispose(this);
    this.sh.blobs.release(this.blob);
    this.root.removeFromParent();
    this.mesh.skeleton.dispose();
  }
}

/**
 * Where a litterbug's throw leaves the hand (call at THROW_RELEASE_SEC after setAnim('throw')), or
 * where a picked-up item is held. Works for any Person made by this module's factory.
 */
export function handWorldPosition(person: Person, out: Vector3): Vector3 {
  if (person instanceof PersonImpl) return person.handWorldPosition(out);
  return out.copy(person.root.position).setY(person.root.position.y + person.height * 0.7);
}

/** Builds the crowd factory. Paints the shared atlas first (≈ 1–3 s, yielding to the main thread
 *  between steps, so run it under the loading screen); `onProgress` reports that 0..1. */
export async function createPeople(ctx: BuildContext, opts: PeopleOptions = {}): Promise<PeopleFactory> {
  const atlas = await createAtlas(ctx.quality, ctx.renderer, opts.onProgress);
  const material = createMaterial(atlas, ctx.quality);
  const dist = SHADOW_DIST[ctx.quality];
  const shared: Shared = { camX: 0, camY: 0, camZ: 0, camKnown: false, shadowDist2: dist * dist, blobs: new Blobs() };
  const alive = new Set<PersonImpl>();
  const cache = new Map<number, Built>();
  return {
    create(seed: number): Person {
      let b = cache.get(seed);
      if (!b) cache.set(seed, (b = build(seed)));
      b.users++;
      const built = b;
      const p = new PersonImpl(built, material, shared, (q) => {
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
      shared.blobs.dispose();
    },
  };
}

// Shared PBR materials for the landmarks (one instance each, reused by every monument).
// Textured materials carry `userData.tile` (meters per repeat) → the merge bucket box-projects
// world UVs. Plaster and stone get a subtle shader "weathering" (grime near the ground, large-scale
// mottling); bronze gets a triplanar green patina that collects on upward faces.
import {
  CanvasTexture, MeshPhysicalMaterial, MeshStandardMaterial, SRGBColorSpace,
  Vector2, type Material, type Texture, type WebGLProgramParametersWithUniforms,
} from 'three';
import type { BuildContext, Quality } from '../../core/types';
import { CURB } from '../../core/layout';

const TEX = '/textures/landmarks/';

export interface LandmarkMaterials {
  stoneLight: MeshStandardMaterial; // white limestone: quoins, cornices, plinths
  stoneWarm: MeshStandardMaterial; // pinkish-cream marble-like stone (Bourguiba plinth)
  porteStone: MeshStandardMaterial; // weathered ochre ashlar (Bab el Bhar)
  plasterOchre: MeshStandardMaterial;
  plasterWhite: MeshStandardMaterial;
  plasterSand: MeshStandardMaterial;
  ornament: MeshStandardMaterial; // white stucco ornament (untextured, smooth)
  roof: MeshStandardMaterial;
  grass: MeshStandardMaterial;
  hedge: MeshStandardMaterial;
  bronze: MeshStandardMaterial; // dark bronze, light patina (Ibn Khaldoun)
  bronzeGreen: MeshStandardMaterial; // weathered verdigris (Bourguiba)
  gold: MeshStandardMaterial; // small gilded trim (merged into the trim material)
  gilt: MeshPhysicalMaterial; // large gilded surfaces (clock tower): clear-coated leaf
  iron: MeshStandardMaterial;
  blueIron: MeshStandardMaterial;
  greenIron: MeshStandardMaterial;
  galvanised: MeshStandardMaterial;
  glass: MeshStandardMaterial;
  shopWindow: MeshStandardMaterial; // shop glazing: reflective, with the warm glow of a lit interior
  wood: MeshStandardMaterial;
  bark: MeshStandardMaterial; // palm trunks
  doorCream: MeshStandardMaterial;
  marbleBlack: MeshStandardMaterial;
  dark: MeshStandardMaterial; // deep shadowed voids (louvres, passages)
  paving: MeshStandardMaterial; // footprint forecourts: the street module's plaza paving
  all: Material[];
  textures: Texture[];
}

interface Set3 { map: Texture; normalMap: Texture; arm: Texture }

async function loadSet(ctx: BuildContext, id: string, base = TEX, ext = 'jpg'): Promise<Set3> {
  const [map, normalMap, arm] = await Promise.all([
    ctx.assets.texture(`${base}${id}_diff.${ext}`, { srgb: true, repeat: [1, 1] }),
    ctx.assets.texture(`${base}${id}_nor.${ext}`, { repeat: [1, 1] }),
    ctx.assets.texture(`${base}${id}_arm.${ext}`, { repeat: [1, 1] }),
  ]);
  return { map, normalMap, arm };
}

/** The street module's plaza paving (shared through the asset cache, so no extra download);
 *  null if that module's files are missing, so the landmarks still build on their own. */
const STREET_PLAZA = { base: '/textures/street/', id: 'plaza', ext: 'webp', tile: 3.0 } as const;

function textured(name: string, set: Set3, color: number, tile: number, opts: { rough?: number; normal?: number } = {}): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    name, color, map: set.map, normalMap: set.normalMap, roughnessMap: set.arm, aoMap: set.arm,
    roughness: opts.rough ?? 1, metalness: 0, normalScale: new Vector2(opts.normal ?? 1, opts.normal ?? 1),
  });
  m.userData.tile = tile;
  return m;
}

// ---------------------------------------------------------------------------------------------
// Shader snippets

const NOISE = /* glsl */ `
float lmHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float lmNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(lmHash(i), lmHash(i + vec3(1,0,0)), f.x), mix(lmHash(i + vec3(0,1,0)), lmHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(lmHash(i + vec3(0,0,1)), lmHash(i + vec3(1,0,1)), f.x), mix(lmHash(i + vec3(0,1,1)), lmHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`;

function injectWorldVaryings(shader: WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vLmWorld;\nvarying vec3 vLmNormal;')
    .replace('#include <project_vertex>', '#include <project_vertex>\nvLmWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvLmNormal = normalize(mat3(modelMatrix) * objectNormal);');
  shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vLmWorld;\nvarying vec3 vLmNormal;\n${NOISE}`);
}

/** Grime toward the ground + soft large-scale mottling + faint vertical rain streaks. */
function weathering(m: MeshStandardMaterial, grime = 0.28, mottle = 0.12): void {
  m.onBeforeCompile = (shader) => {
    injectWorldVaryings(shader);
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', /* glsl */ `#include <map_fragment>
      {
        // 3 value-noise taps: two octaves of large-scale mottling (also modulating the grime line)
        // and one vertically stretched tap for faint rain streaks.
        float h = vLmWorld.y - ${CURB.toFixed(2)};
        float n = lmNoise(vLmWorld * vec3(0.18, 0.11, 0.18)) * 0.65 + lmNoise(vLmWorld * 0.63) * 0.35;
        float g = 1.0 - ${grime.toFixed(3)} * (1.0 - smoothstep(0.0, 2.4, h)) * (0.7 + 0.6 * n);
        float streak = lmNoise(vec3(vLmWorld.x * 3.1 + vLmWorld.z * 3.1, vLmWorld.y * 0.12, 0.0));
        float side = 1.0 - abs(vLmNormal.y);
        diffuseColor.rgb *= g * (1.0 - ${mottle.toFixed(3)} * (n - 0.45)) * (1.0 - 0.06 * side * smoothstep(0.55, 0.9, streak));
      }`);
  };
  m.customProgramCacheKey = () => `lm-weather-${grime}-${mottle}`;
}

/** Cast bronze: warm dark metal with a green-blue patina. The patina pools where water and dirt
 *  collect: in crevices (the statue meshes carry a baked per-vertex `cavity`), on upward faces and
 *  in thin vertical runs below them, broken up by fine-grained noise. `amount` shifts the coverage
 *  (0 = fresh dark bronze, 1 = mostly verdigris). */
function patina(m: MeshStandardMaterial, amount: number): void {
  m.onBeforeCompile = (shader) => {
    injectWorldVaryings(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float cavity;\nvarying float vLmCav;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLmCav = cavity;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nfloat lmPatina;\nvarying float vLmCav;')
      .replace('#include <map_fragment>', /* glsl */ `#include <map_fragment>
      {
        vec3 p = vLmWorld;
        float up = normalize(vLmNormal).y;
        float f1 = lmNoise(p * 3.1), f2 = lmNoise(p * 7.7);
        float fine = f1 * 0.6 + f2 * 0.4;
        // thin runs: narrow across, long down the surface, only on steep faces
        float run = smoothstep(0.7, 0.92, lmNoise(vec3(p.x * 13.0 + p.z * 9.0, p.y * 0.9, p.z * 13.0 - p.x * 6.0))) * (1.0 - max(up, 0.0));
        float k = vLmCav * (0.75 + 0.5 * fine) + smoothstep(0.3, 0.95, up) * (0.42 + 0.22 * fine) + run * 0.45 + (fine - 0.5) * 0.18;
        lmPatina = smoothstep(0.3, 0.8, k + ${(amount * 0.4 - 0.18).toFixed(3)});
        // weathered statuary bronze is dark brown, not new copper; verdigris is a muted grey-green
        vec3 bronze = vec3(0.07, 0.054, 0.039) * (0.78 + 0.44 * f2);
        vec3 green = mix(vec3(0.07, 0.12, 0.1), vec3(0.19, 0.28, 0.24), f1);
        diffuseColor.rgb = mix(bronze, green, lmPatina);
      }`)
      // uneven wear: roughness wanders with the fine noise so highlights break up (no plastic sheen)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(mix(0.5, 0.86, lmPatina) + (lmNoise(vLmWorld * 11.0) - 0.5) * 0.22, 0.3, 1.0);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(0.55, 0.1, lmPatina);');
  };
  m.customProgramCacheKey = () => `lm-bronze2-${amount}`;
}

/** Shared "trim" material: per-vertex colour + (roughness, metalness) from the `pbr` attribute,
 *  with the same ground grime as the masonry. Small metal, wood and marble parts of every
 *  landmark merge into it (see Bucket.build). */
function trimMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ name: 'trim', vertexColors: true, roughness: 1, metalness: 1 });
  m.onBeforeCompile = (shader) => {
    injectWorldVaryings(shader);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 pbr;\nvarying vec2 vPbr;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPbr = pbr;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPbr;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vPbr.x;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vPbr.y;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb *= 1.0 - 0.2 * (1.0 - smoothstep(0.0, 1.6, vLmWorld.y - ${CURB.toFixed(2)}));`);
  };
  m.customProgramCacheKey = () => 'lm-trim';
  return m;
}

// ---------------------------------------------------------------------------------------------

export async function createMaterials(ctx: BuildContext): Promise<LandmarkMaterials> {
  const [stone, porte, plaster, roofSet, grassSet, plazaSet] = await Promise.all([
    loadSet(ctx, 'sandstone_blocks_08'),
    loadSet(ctx, 'large_sandstone_blocks_01'),
    loadSet(ctx, 'painted_plaster_wall'),
    loadSet(ctx, 'clay_roof_tiles_02'),
    loadSet(ctx, 'leafy_grass'),
    loadSet(ctx, STREET_PLAZA.id, STREET_PLAZA.base, STREET_PLAZA.ext).catch(() => null),
  ]);
  const q: Quality = ctx.quality;

  const stoneLight = textured('stoneLight', stone, 0xf3ede2, 3.0, { normal: 0.8 });
  const stoneWarm = textured('stoneWarm', stone, 0xeedcc9, 3.6, { normal: 0.6 });
  const porteStone = textured('porteStone', porte, 0xfff4e6, 3.2, { normal: 0.9 });
  const plasterOchre = textured('plasterOchre', plaster, 0xe9d396, 2.2, { normal: 0.7 });
  const plasterWhite = textured('plasterWhite', plaster, 0xf4f0e8, 2.2, { normal: 0.6 });
  const plasterSand = textured('plasterSand', plaster, 0xe2c9a0, 2.2, { normal: 0.7 });
  const roof = textured('roof', roofSet, 0xffffff, 2.5, { normal: 1 });
  const grass = textured('grass', grassSet, 0xb7c98f, 1.6, { normal: 1 });
  for (const m of [stoneLight, stoneWarm, plasterWhite, plasterSand, plasterOchre]) weathering(m);
  weathering(porteStone, 0.16, 0.08);

  const ornament = plasterWhite; // stucco ornament shares the rendered plaster
  const hedge = new MeshStandardMaterial({ name: 'hedge', color: 0x3d5a26, roughness: 0.95, map: grassSet.map, normalMap: grassSet.normalMap });
  hedge.userData.tile = 0.9;

  const bronze = new MeshStandardMaterial({ name: 'bronze', color: 0xffffff, metalness: 0.9, roughness: 0.45 });
  patina(bronze, 0.25);
  const bronzeGreen = new MeshStandardMaterial({ name: 'bronzeGreen', color: 0xffffff, metalness: 0.9, roughness: 0.45 });
  patina(bronzeGreen, 1.0);

  const gold = new MeshStandardMaterial({ name: 'gold', color: 0xd6a650, metalness: 1, roughness: 0.3 });
  const gilt = new MeshPhysicalMaterial({
    name: 'gilt', color: 0xd9a954, metalness: 1, roughness: 0.34, clearcoat: q === 'low' ? 0 : 0.4, clearcoatRoughness: 0.22,
  });
  const iron = new MeshStandardMaterial({ name: 'iron', color: 0x1b1c1d, metalness: 0.7, roughness: 0.5 });
  const blueIron = new MeshStandardMaterial({ name: 'blueIron', color: 0x2a5aa8, metalness: 0.5, roughness: 0.42 });
  const greenIron = new MeshStandardMaterial({ name: 'greenIron', color: 0x1f4a33, metalness: 0.5, roughness: 0.45 });
  const galvanised = new MeshStandardMaterial({ name: 'galvanised', color: 0xb9bdc0, metalness: 0.9, roughness: 0.42 });
  const glass = new MeshStandardMaterial({ name: 'glass', color: 0x1a232a, metalness: 0.45, roughness: 0.05, envMapIntensity: 1.8 });
  // clear shop glazing over lit interior cards (SignAtlas.glow): reflections on top, interior through
  const shopWindow = new MeshStandardMaterial({ name: 'shopWindow', color: 0x06080a, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.3, envMapIntensity: 2.4 });
  const wood = new MeshStandardMaterial({ name: 'wood', color: 0x4a2f1c, roughness: 0.6 });
  const bark = new MeshStandardMaterial({ name: 'bark', color: 0x6a5846, roughness: 0.95 });
  const doorCream = new MeshStandardMaterial({ name: 'doorCream', color: 0xd9c08a, roughness: 0.45, metalness: 0.15 });
  const marbleBlack = new MeshStandardMaterial({ name: 'marbleBlack', color: 0x141416, roughness: 0.18, metalness: 0.0 });
  const dark = new MeshStandardMaterial({ name: 'dark', color: 0x16130f, roughness: 1, metalness: 0 });
  dark.envMapIntensity = 0.2;

  const paving = plazaSet
    ? textured('paving', plazaSet, 0xffffff, STREET_PLAZA.tile)
    : textured('paving', stone, 0xe9e2d6, 3.0, { normal: 0.6 });
  paving.aoMapIntensity = 0.6;
  weathering(paving, 0, 0.1); // mottling only: no wall grime on a floor

  const trim = trimMaterial();
  for (const t of [gold, iron, blueIron, greenIron, galvanised, wood, bark, doorCream, marbleBlack, dark]) t.userData.trim = trim;

  const all: Material[] = [
    trim, stoneLight, stoneWarm, porteStone, plasterOchre, plasterWhite, plasterSand, roof, grass, hedge,
    bronze, bronzeGreen, gold, gilt, iron, blueIron, greenIron, galvanised, glass, shopWindow, wood, bark, doorCream, marbleBlack, dark, paving,
  ];
  const textures = [stone, porte, plaster, roofSet, grassSet, plazaSet].flatMap((s) => (s ? [s.map, s.normalMap, s.arm] : []));
  return {
    stoneLight, stoneWarm, porteStone, plasterOchre, plasterWhite, plasterSand, ornament, roof, grass, hedge,
    bronze, bronzeGreen, gold, gilt, iron, blueIron, greenIron, galvanised, glass, shopWindow, wood, bark, doorCream, marbleBlack, dark, paving, all, textures,
  };
}

/** Small helper for canvas-painted textures owned by a landmark. */
export function canvasTexture(canvas: HTMLCanvasElement, srgb = true): CanvasTexture {
  const t = new CanvasTexture(canvas);
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}


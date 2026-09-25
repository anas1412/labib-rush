// Labib's materials: sheen fur, shell fur, jersey fabric, glossy eyes/nose, felt (chéchia), speed trail.
// Shader tweaks are injected with onBeforeCompile so the full three.js PBR lighting (IBL, sun, shadows)
// stays intact. Canvas textures (eye/nose atlas, chest emblem) are drawn procedurally at load.
import {
  AdditiveBlending, CanvasTexture, Color, DoubleSide, MeshPhysicalMaterial, SRGBColorSpace, ShaderMaterial,
  Vector3, type Material, type WebGLRenderer,
} from 'three';
import type { Quality, SharedUniforms } from '../../core/types';

export interface LabibUniforms {
  uFlash: { value: number };
  uRadar: { value: number };
  uGravity: { value: Vector3 }; // gravity in the avatar's local frame
  uWindL: { value: Vector3 }; // wind in the avatar's local frame (m/s, scaled)
  uDrag: { value: Vector3 }; // motion drag in the local frame
  uShells: { value: number };
  uSprint: { value: number }; // mint-tea rim glow 0..1
}

const NOISE = /* glsl */ `
float lbHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float lbNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(lbHash(i), lbHash(i + vec3(1, 0, 0)), f.x), mix(lbHash(i + vec3(0, 1, 0)), lbHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(lbHash(i + vec3(0, 0, 1)), lbHash(i + vec3(1, 0, 1)), f.x), mix(lbHash(i + vec3(0, 1, 1)), lbHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;

// perturbs the view-space normal with 3D noise evaluated on the rest pose (stable under animation);
// each octave is skipped once it is sub-pixel (coherent branch: the whole character at distance)
const GRAIN = /* glsl */ `
{
  vec3 pert = vec3(0.0);
  vec3 gq = vRest * GRAIN_FREQ;
  float fade = clamp(1.0 - length(fwidth(gq)) * 0.6, 0.0, 1.0);
  if (fade > 0.02) pert += (vec3(lbNoise(gq), lbNoise(gq + 17.3), lbNoise(gq + 31.7)) - 0.5) * (GRAIN_AMP * fade);
  vec3 fq = vRest * FOLD_FREQ * (1.0 + WRINKLE * vFurV.y);
  float fadeF = clamp(1.5 - length(fwidth(fq)) * 1.5, 0.0, 1.0);
  if (fadeF > 0.02) pert += (vec3(lbNoise(fq), lbNoise(fq + 9.1), lbNoise(fq + 4.7)) - 0.5) * (FOLD_AMP * (1.0 + WRINKLE * 3.0 * vFurV.y) * fadeF);
  normal = normalize(normal + pert);
}
`;

interface PatchOpts {
  grainFreq: number; grainAmp: number; foldFreq: number; foldAmp: number;
  emissive: boolean; // radar glow on vFurV.y (fur); for cloth vFurV.y is instead a wrinkle mask
  tone: number; // low-frequency albedo variation
  rim?: readonly [number, number, number]; // constant fresnel rim colour (makes small props pop)
}
/** (1 - N·V)³ in the physical fragment shader (view-space normal after the normal maps). */
const FRESNEL = 'pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0)';
function patchCommon(shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> }, u: LabibUniforms, opts: PatchOpts): void {
  shader.uniforms.uFlash = u.uFlash;
  shader.uniforms.uRadar = u.uRadar;
  shader.uniforms.uSprint = u.uSprint;
  const rim = opts.rim ? `totalEmissiveRadiance += vec3(${opts.rim.map((c) => c.toFixed(3)).join(', ')}) * ${FRESNEL};` : '';
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 aFur;\nvarying vec3 vRest;\nvarying vec3 vFurV;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = position;\nvFurV = aFur;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\nvarying vec3 vRest;\nvarying vec3 vFurV;\nuniform float uFlash;\nuniform float uRadar;\nuniform float uSprint;\n${NOISE}
#define GRAIN_FREQ ${opts.grainFreq.toFixed(1)}
#define GRAIN_AMP ${opts.grainAmp.toFixed(3)}
#define FOLD_FREQ ${opts.foldFreq.toFixed(1)}
#define FOLD_AMP ${opts.foldAmp.toFixed(3)}
#define WRINKLE ${opts.emissive ? '0.0' : '1.0'}`)
    .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb *= 1.0 + ${opts.tone.toFixed(3)} * (lbNoise(vRest * 31.0) - 0.5);`)
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${GRAIN}`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(0.34, 0.2, 0.17) * uFlash + vec3(0.2, 0.95, 0.68) * uSprint * ${FRESNEL};
${rim}
${opts.emissive ? 'totalEmissiveRadiance += vec3(0.12, 0.62, 0.46) * uRadar * vFurV.y + diffuseColor.rgb * vec3(0.07, 0.035, 0.012);' : ''}`);
}

export interface LabibMaterials {
  fur: MeshPhysicalMaterial;
  shell: MeshPhysicalMaterial | null;
  cloth: MeshPhysicalMaterial;
  gloss: MeshPhysicalMaterial;
  felt: MeshPhysicalMaterial;
  trail: ShaderMaterial;
  list: Material[];
  textures: CanvasTexture[];
}

export function createMaterials(quality: Quality, u: LabibUniforms, shared: SharedUniforms, renderer: WebGLRenderer): LabibMaterials {
  const shells = quality === 'high' || quality === 'ultra';
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const fur = new MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.82,
    sheen: 1,
    sheenColor: new Color(0xffe2bd),
    sheenRoughness: shells ? 0.55 : 0.4,
    envMapIntensity: 0.9,
  });
  fur.onBeforeCompile = (s) => patchCommon(s, u, { grainFreq: 520, grainAmp: shells ? 0.35 : 0.6, foldFreq: 60, foldAmp: 0.12, emissive: true, tone: 0.1 });
  fur.customProgramCacheKey = () => `labib-fur-${shells}`;

  let shell: MeshPhysicalMaterial | null = null;
  if (shells) {
    shell = new MeshPhysicalMaterial({
      vertexColors: true, roughness: 0.82, sheen: 1, sheenColor: new Color(0xffe2bd), sheenRoughness: 0.55,
      transparent: true, depthWrite: false, envMapIntensity: 0.9,
    });
    shell.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, { uGravity: u.uGravity, uWindL: u.uWindL, uDrag: u.uDrag, uShells: u.uShells, uTime: shared.uTime, uRadar: u.uRadar, uFlash: u.uFlash, uSprint: u.uSprint });
      s.vertexShader = s.vertexShader
        .replace('#include <common>', `#include <common>
attribute vec3 aFur; attribute vec3 aComb;
uniform vec3 uGravity; uniform vec3 uWindL; uniform vec3 uDrag; uniform float uShells; uniform float uTime;
varying float vShell; varying vec3 vRest; varying vec3 vFurV;`)
        .replace('#include <skinning_vertex>', `#include <skinning_vertex>
{
  float sh = (float(gl_InstanceID) + 1.0) / uShells;
  vShell = sh; vRest = position; vFurV = aFur;
  #ifdef USE_SKINNING
    vec3 comb = (skinMatrix * vec4(aComb, 0.0)).xyz;
  #else
    vec3 comb = aComb;
  #endif
  float len = aFur.x;
  vec3 n = normalize(objectNormal);
  vec3 dir = normalize(n * 0.8 + comb * 0.75);
  float flutter = 0.55 + 0.45 * sin(uTime * 7.0 + dot(position, vec3(41.0, 29.0, 37.0)));
  vec3 force = uGravity * 0.45 + uWindL * flutter + uDrag;
  transformed += dir * (len * sh) + force * (len * sh * sh);
}`);
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', `#include <common>
varying float vShell; varying vec3 vRest; varying vec3 vFurV; uniform float uRadar; uniform float uFlash; uniform float uSprint;
${NOISE}
float strands(vec3 q, float shell) {
  vec3 c = floor(q); vec3 f = fract(q) - 0.5;
  float h = lbHash(c);
  vec3 j = vec3(lbHash(c + 3.1), lbHash(c + 7.7), lbHash(c + 1.3)) - 0.5;
  float d = length(f - j * 0.45);
  float top = 0.45 + 0.55 * h;
  float r = 0.6 * (1.0 - shell / top) + 0.05;
  return step(shell, top) * smoothstep(r, r * 0.35, d);
}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
{
  float fine = max(strands(vRest * 1150.0, vShell), strands(vRest * 1150.0 + 0.5, vShell));
  float coarse = max(strands(vRest * 420.0, vShell), strands(vRest * 420.0 + 0.5, vShell));
  float a = mix(fine, coarse, smoothstep(0.006, 0.014, vFurV.x));
  a *= (0.9 - vShell * 0.3) * smoothstep(0.0012, 0.0035, vFurV.x);
  if (a < 0.04) discard;
  diffuseColor.a = a;
  diffuseColor.rgb *= mix(0.9, 1.05, vShell);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.9, 0.85), vFurV.z * smoothstep(0.2, 1.0, vShell));
}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(0.34, 0.2, 0.17) * uFlash + vec3(0.2, 1.0, 0.72) * uRadar * vFurV.y * 0.55 + diffuseColor.rgb * vec3(0.07, 0.035, 0.012)
  + vec3(0.2, 0.95, 0.68) * uSprint * ${FRESNEL};`);
    };
    shell.customProgramCacheKey = () => 'labib-shell';
  }

  const clothMap = new CanvasTexture(drawClothAtlas());
  clothMap.colorSpace = SRGBColorSpace;
  clothMap.anisotropy = aniso;
  const cloth = new MeshPhysicalMaterial({
    vertexColors: true,
    map: clothMap,
    roughness: 0.86,
    sheen: 0.7,
    sheenColor: new Color(0xd6e6ff),
    sheenRoughness: 0.45,
  });
  cloth.onBeforeCompile = (s) => patchCommon(s, u, { grainFreq: 1400, grainAmp: 0.22, foldFreq: 24, foldAmp: 0.12, emissive: false, tone: 0.07 });
  cloth.customProgramCacheKey = () => 'labib-cloth';

  const glossMap = new CanvasTexture(drawGlossAtlas());
  glossMap.colorSpace = SRGBColorSpace;
  glossMap.anisotropy = aniso;
  const glossProps = new CanvasTexture(drawGlossProps());
  const gloss = new MeshPhysicalMaterial({
    map: glossMap,
    roughness: 1,
    roughnessMap: glossProps, // G channel
    clearcoat: 1,
    clearcoatMap: glossProps, // R channel
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.1,
  });
  gloss.onBeforeCompile = (s) => {
    s.uniforms.uFlash = u.uFlash;
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uFlash;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(0.34, 0.2, 0.17) * uFlash * 0.5;');
  };
  gloss.customProgramCacheKey = () => 'labib-gloss';

  const felt = new MeshPhysicalMaterial({
    vertexColors: true,
    roughness: 0.93,
    sheen: 1,
    sheenColor: new Color(0xffa08a),
    sheenRoughness: 0.45,
  });
  // warm felt rim so the (small, ×2 score) cap pops against the sandy head from the chase camera
  felt.onBeforeCompile = (s) => patchCommon(s, u, { grainFreq: 900, grainAmp: 0.3, foldFreq: 40, foldAmp: 0.06, emissive: false, tone: 0.06, rim: [0.42, 0.1, 0.06] });
  felt.customProgramCacheKey = () => 'labib-felt';

  const trail = new ShaderMaterial({
    uniforms: { uFade: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute vec3 aTangent; attribute vec2 aSide; // x: -1/+1 across, y: age 0..1
      uniform float uFade;
      varying vec2 vUv;
      void main() {
        // camera-facing width; when the ribbon points at the camera (chase view) that cross product
        // collapses, so blend toward a horizontal width instead of dividing by ~0
        vec3 c = cross(aTangent, normalize(cameraPosition - position));
        float l = length(c);
        vec3 h = cross(aTangent, vec3(0.0, 1.0, 0.0));
        h = dot(h, h) > 1e-6 ? normalize(h) : vec3(1.0, 0.0, 0.0);
        if (dot(h, c) < 0.0) h = -h;
        vec3 across = l > 1e-4 ? normalize(mix(h, c / l, smoothstep(0.1, 0.6, l))) : h;
        float w = 0.075 * (1.0 - aSide.y * 0.7) * uFade;
        vUv = vec2(aSide.x, aSide.y);
        gl_Position = projectionMatrix * viewMatrix * vec4(position + across * aSide.x * w, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uFade;
      varying vec2 vUv;
      void main() {
        float edge = pow(1.0 - abs(vUv.x), 1.6); // soft edges, no hard core line
        float a = edge * pow(1.0 - vUv.y, 1.3) * smoothstep(0.0, 0.12, vUv.y) * uFade * 0.55;
        vec3 c = mix(vec3(0.45, 1.0, 0.8), vec3(0.1, 0.82, 0.58), smoothstep(0.0, 0.6, vUv.y));
        gl_FragColor = vec4(c, a); // additive: adds c * a
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });

  const list: Material[] = [fur, cloth, gloss, felt, trail];
  if (shell) list.push(shell);
  const names = ['labib-fur', 'labib-cloth', 'labib-gloss', 'labib-felt', 'labib-trail', 'labib-shell'];
  list.forEach((m, i) => (m.name = names[i])); // shows up as renderer.info.programs[].name
  return { fur, shell, cloth, gloss, felt, trail, list, textures: [clothMap, glossMap, glossProps] };
}

// ---------------------------------------------------------------------------------------------
// Canvas textures

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** 1024×512: left = eye (sclera, big brown iris, pupil), right = glossy black nose. */
function drawGlossAtlas(): HTMLCanvasElement {
  const [c, g] = canvas(1024, 512);
  const S = 512, cx = 256, cy = 256;
  // sclera: warm white, darker toward the rim and under the upper lid
  let gr = g.createRadialGradient(cx, cy, 60, cx, cy, S / 2);
  gr.addColorStop(0, '#f7f3ec');
  gr.addColorStop(0.7, '#efe8df');
  gr.addColorStop(1, '#e2d8cc');
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  gr = g.createLinearGradient(0, 0, 0, S * 0.5);
  gr.addColorStop(0, 'rgba(120,90,70,0.3)');
  gr.addColorStop(1, 'rgba(120,90,70,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S * 0.5);
  // iris
  const IR = 0.68 * (S / 2) * 0.98; // body.ts buildEye IRIS
  gr = g.createRadialGradient(cx, cy, IR * 0.3, cx, cy, IR);
  gr.addColorStop(0, '#c98b3e');
  gr.addColorStop(0.35, '#8a5424');
  gr.addColorStop(0.8, '#5a3217');
  gr.addColorStop(0.93, '#3a1e0d');
  gr.addColorStop(1, '#1d0f07');
  g.fillStyle = gr;
  g.beginPath(); g.arc(cx, cy, IR, 0, Math.PI * 2); g.fill();
  // radial fibres
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.lineCap = 'round';
  for (let i = 0; i < 260; i++) {
    const a = rnd() * Math.PI * 2, r0 = IR * (0.32 + rnd() * 0.1), r1 = IR * (0.75 + rnd() * 0.22);
    g.strokeStyle = rnd() > 0.5 ? `rgba(235,175,95,${0.12 + rnd() * 0.18})` : `rgba(40,18,6,${0.1 + rnd() * 0.2})`;
    g.lineWidth = 1 + rnd() * 2.5;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.stroke();
  }
  // limbal ring + pupil
  g.strokeStyle = 'rgba(20,10,5,0.85)'; g.lineWidth = 7;
  g.beginPath(); g.arc(cx, cy, IR - 3, 0, Math.PI * 2); g.stroke();
  gr = g.createRadialGradient(cx, cy, IR * 0.36, cx, cy, IR * 0.46);
  gr.addColorStop(0, '#070403');
  gr.addColorStop(1, 'rgba(7,4,3,0)');
  g.fillStyle = gr;
  g.beginPath(); g.arc(cx, cy, IR * 0.46, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#050302';
  g.beginPath(); g.arc(cx, cy, IR * 0.38, 0, Math.PI * 2); g.fill();
  // painted soft catchlight (keeps the eyes alive in shade; the clearcoat adds the real one)
  gr = g.createRadialGradient(cx - IR * 0.32, cy - IR * 0.34, 0, cx - IR * 0.32, cy - IR * 0.34, IR * 0.2);
  gr.addColorStop(0, 'rgba(255,255,255,0.85)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  // nose: near-black with a faint leather mottling
  g.fillStyle = '#0c0a09';
  g.fillRect(S, 0, S, S);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(60,50,45,${rnd() * 0.25})`;
    g.fillRect(S + rnd() * S, rnd() * S, 2, 2);
  }
  return c;
}

/** Gloss atlas properties: R = clearcoat, G = roughness (left = eye, right = nose). */
function drawGlossProps(): HTMLCanvasElement {
  const [c, g] = canvas(64, 32);
  g.fillStyle = 'rgb(255,70,0)'; // eye: full clearcoat, smooth
  g.fillRect(0, 0, 32, 32);
  g.fillStyle = 'rgb(170,52,0)'; // nose: wet but a touch satin — small sharp highlights, stays black
  g.fillRect(32, 0, 32, 32);
  return c;
}

/** 1024×1024 white fabric with the chest emblem in the bottom-right quadrant (centre 0.75, 0.25 in UV). */
function drawClothAtlas(): HTMLCanvasElement {
  const [c, g] = canvas(1024, 1024);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 1024, 1024);
  const cx = 768, cy = 768, R = 0.235 * 1024;
  // cream outer ring
  g.fillStyle = '#f3ecdc';
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  // blue band with a little laurel of leaves
  g.fillStyle = '#1d4f9e';
  g.beginPath(); g.arc(cx, cy, R * 0.86, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#f3ecdc';
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    g.save();
    g.translate(cx + Math.cos(a) * R * 0.795, cy + Math.sin(a) * R * 0.795);
    g.rotate(a + 0.6);
    g.beginPath(); g.ellipse(0, 0, R * 0.045, R * 0.018, 0, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  // inner disc: sun-yellow sky over green land
  g.save();
  g.beginPath(); g.arc(cx, cy, R * 0.72, 0, Math.PI * 2); g.clip();
  g.fillStyle = '#f4c233';
  g.fillRect(cx - R, cy - R, 2 * R, 2 * R);
  g.fillStyle = '#35a04e';
  g.beginPath(); g.moveTo(cx - R, cy + R * 0.12);
  g.quadraticCurveTo(cx, cy - R * 0.02, cx + R, cy + R * 0.12);
  g.lineTo(cx + R, cy + R); g.lineTo(cx - R, cy + R); g.fill();
  // white silhouette of Tunisia
  const T: [number, number][] = [
    [0.36, 0.0], [0.5, 0.02], [0.6, 0.07], [0.68, 0.06], [0.64, 0.15], [0.57, 0.2], [0.62, 0.29], [0.68, 0.36], [0.62, 0.45], [0.55, 0.5],
    [0.62, 0.56], [0.71, 0.6], [0.66, 0.67], [0.6, 0.73], [0.52, 0.83], [0.46, 1.0], [0.4, 0.86], [0.3, 0.71], [0.22, 0.62], [0.2, 0.5],
    [0.25, 0.4], [0.18, 0.3], [0.2, 0.15], [0.28, 0.05],
  ];
  const th = R * 1.12, tw = th;
  g.fillStyle = '#ffffff';
  g.strokeStyle = 'rgba(30,60,40,0.35)';
  g.lineWidth = 3;
  g.beginPath();
  T.forEach(([x, y], i) => {
    const px = cx - tw * 0.45 + x * tw, py = cy - th * 0.5 + y * th;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  });
  g.closePath(); g.fill(); g.stroke();
  g.restore();
  g.strokeStyle = 'rgba(25,40,80,0.5)';
  g.lineWidth = 4;
  g.beginPath(); g.arc(cx, cy, R * 0.72, 0, Math.PI * 2); g.stroke();
  return c;
}

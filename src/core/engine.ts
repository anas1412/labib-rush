// Rendering engine: WebGL renderer, golden-hour lighting (HDRI + cascaded sun), height fog,
// post-processing chain, quality presets, dynamic resolution and first-run quality detection.
//
// Post chain (postprocessing): RenderPass → N8AO (high/ultra) → EffectPass([SMAA], bloom, tone
// mapping, LUT grade, vignette) → [EffectPass(SMAA)]. At high/ultra SMAA runs in its own pass after
// tone mapping so edges against the bright sky are blended in display space; low/medium merge it.
import {
  Color, DataTexture, DataUtils, EquirectangularReflectionMapping, FogExp2, HalfFloatType,
  NoToneMapping, PCFShadowMap, RGBAFormat, PerspectiveCamera, PMREMGenerator, Scene, ShaderChunk,
  SRGBColorSpace, Vector3, WebGLRenderer, type Texture,
} from 'three';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import {
  BloomEffect, EdgeDetectionMode, EffectComposer, EffectPass, LookupTexture, LUT3DEffect, RenderPass,
  SMAAEffect, SMAAPreset, ToneMappingEffect, ToneMappingMode, VignetteEffect, type Effect, type Pass,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { Assets } from './assets';
import { LIGHTING } from './config';
import type { Engine, Quality } from './types';

/** Engine plus a few read-only diagnostics used by dev pages / the settings screen. */
export interface CoreEngine extends Engine {
  /** Dynamic-resolution factor applied on top of the preset pixel ratio (0.6..1). */
  readonly resolutionScale: number;
  /** Effective renderer pixel ratio right now. */
  readonly pixelRatio: number;
  /** Dynamic resolution on/off (default on). Off resets the scale to 1. */
  dynamicResolution: boolean;
}

interface Preset {
  pixelRatio: number; // cap on devicePixelRatio
  ao: 'off' | 'half' | 'full';
  aoMode: 'Performance' | 'Low' | 'Medium';
  aoDenoise: number; // denoise iterations
  bloomLevels: number; // 0 = no bloom
  smaa: SMAAPreset;
  /** SMAA in its own pass after tone mapping (cleaner edges vs bright sky) instead of merged. */
  smaaPass: boolean;
  shadowMapSize: number; // per cascade (the atlas is 2x1 cascades)
  shadowDistance: number; // m, far end of the cascades
  shadowRadius: number; // PCF filter radius in texels
}

// Costs measured on the target iGPU (Intel UHD 630-class, 1600x900, graybox, through the composer):
// the PBR scene ≈ 13–15 ms (IBL shading ≈ 4.5 of it, shadow sampling + cascades ≈ 2.5, height fog
// ≈ 1.5), N8AO ≈ 7.5 ms at half resolution (mostly its fixed full-screen passes: sample count barely
// matters), each other full-screen half-float pass ≈ 1 ms. Dynamic resolution absorbs the rest.
// Shadow radius stays ≤ 1.75 texels: the 5-tap rotated PCF shows its dither pattern beyond that.
const PRESETS: Record<Quality, Preset> = {
  low: { pixelRatio: 1.25, ao: 'off', aoMode: 'Performance', aoDenoise: 1, bloomLevels: 0, smaa: SMAAPreset.LOW, smaaPass: false, shadowMapSize: 1536, shadowDistance: 55, shadowRadius: 1.5 },
  medium: { pixelRatio: 1.5, ao: 'off', aoMode: 'Performance', aoDenoise: 1, bloomLevels: 4, smaa: SMAAPreset.MEDIUM, smaaPass: false, shadowMapSize: 2048, shadowDistance: 90, shadowRadius: 1.5 },
  // 2 denoise iterations: with 1, half-res AO leaves a blotchy grain on close curved surfaces (+0.5 ms)
  high: { pixelRatio: 1.75, ao: 'half', aoMode: 'Performance', aoDenoise: 2, bloomLevels: 5, smaa: SMAAPreset.HIGH, smaaPass: true, shadowMapSize: 2048, shadowDistance: 130, shadowRadius: 1.5 },
  ultra: { pixelRatio: 2, ao: 'full', aoMode: 'Medium', aoDenoise: 2, bloomLevels: 6, smaa: SMAAPreset.ULTRA, smaaPass: true, shadowMapSize: 3072, shadowDistance: 180, shadowRadius: 1.75 },
};
const ORDER: Quality[] = ['low', 'medium', 'high', 'ultra'];

// Look tuning (linear HDR units), tuned by eye in dev/core.html for warm late-afternoon Tunis.
const SUN_INTENSITY = 7.5;
const ENV_INTENSITY = 0.85;
const SKY_CLAMP = 3; // HDRI radiance cap for the IBL copy (the sky is ~0.2–2, the sun thousands)
const SUN_DISC_CLAMP = 12; // background cap: still a white disc, but bloom stays a soft glow (no mip rings)
// IBL "ground": sunlit sandstone paving ≈ albedo 0.45 × (sun + sky irradiance) / π, divided by the
// env intensity. Warm bounce for shaded facades and undersides.
const GROUND_RADIANCE = [0.62, 0.5, 0.36] as const;
const GROUND_BLEND_DEG = 6;
const EXPOSURE = 1.0;
// Colour grade (display-referred LUT, see buildGradeLUT)
const GRADE_SAT = 0.36; // extra saturation in mid-tones / highlights
const GRADE_WARM = 0.04; // warm push in the highlights
const S_CURVE_K = 0.3;
const FOG_DENSITY = 0.0011; // extinction per metre at street level
const FOG_FALLOFF = 0.03; // 1/m, height fog e-folds every ~33 m

// Dynamic resolution
const TARGET_FPS = 60;
/** Dynamic-resolution target: main.ts caps 'low' at 30 fps, the rest at 60. */
const targetFor = (q: Quality) => (q === 'low' ? 30 : TARGET_FPS);
const MIN_SCALE = 0.6;
const EVAL_WINDOW_MS = 750;
const PROBE_BACKOFF_MS = [15000, 30000, 60000, 120000]; // wait after each failed step up
// A step down (≥ 28 % fewer pixels) must raise fps by 10 % over the better of the two windows that
// triggered it, else the frame rate is capped (or CPU-bound) rather than GPU-bound.
const HELPED = 1.1;
const FIT_RATIO = 0.72; // autoDetect: fps at scale 1 that dynamic resolution can still lift to target

const isTouchDevice = () =>
  typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches));

export function createEngine(container: HTMLElement): CoreEngine {
  const renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, depth: false });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping; // ToneMappingEffect does it in the post chain
  renderer.toneMappingExposure = EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.info.autoReset = false; // reset once per frame so stats cover shadow + main + post
  const canvas = renderer.domElement;
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', zIndex: '0', touchAction: 'none' });
  container.appendChild(canvas);

  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1, 0.1, 1400);
  camera.position.set(0, 2, 6);

  // ---- sun: cascaded shadow maps fitted to the view frustum (three r186 SunLight: 2 cascades,
  // bounding-sphere fit + texel snapping, so no shimmering while the camera moves or turns).
  const sunDir = new Vector3(...LIGHTING.sunDirection).normalize();
  const sun = new SunLight(LIGHTING.sunColor, SUN_INTENSITY);
  sun.position.copy(sunDir); // SunLight shines from its position toward the origin
  sun.castShadow = true;
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.035;
  sun.shadow.camera.near = 1;
  scene.add(sun); // ambient/fill = the IBL (sky above, warm sunlit-paving bounce below)

  const composer = new EffectComposer(renderer, { frameBufferType: HalfFloatType, multisampling: 0, stencilBuffer: false });
  const renderPass = new RenderPass(scene, camera);
  const lut = buildGradeLUT();
  let postPasses: Pass[] = [];

  let quality: Quality = isTouchDevice() ? 'medium' : 'high'; // phones start light (and load the 1k sky)
  let preset = PRESETS[quality];
  let scale = 1;
  let dynamic = true;
  let width = 1, height = 1;

  // --------------------------------------------------------------------------------------------
  function applySize(): void {
    width = Math.max(1, container.clientWidth || innerWidth);
    height = Math.max(1, container.clientHeight || innerHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, preset.pixelRatio) * scale);
    composer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function buildPost(): void {
    composer.removeAllPasses();
    for (const p of postPasses) p.dispose();
    postPasses = [];
    composer.addPass(renderPass);

    if (preset.ao !== 'off') {
      const ao = new N8AOPostPass(scene, camera, width, height);
      // Scene traversal every frame + a second scene render when transparency is detected is far
      // too expensive for us; glass/particles simply don't occlude.
      (ao as unknown as { autoDetectTransparency: boolean }).autoDetectTransparency = false;
      ao.configuration.transparencyAware = false;
      ao.configuration.halfRes = preset.ao === 'half';
      ao.configuration.aoRadius = 2.4;
      ao.configuration.distanceFalloff = 1.2;
      ao.configuration.intensity = 2.6;
      ao.configuration.color = new Color(0x1a1410); // slightly warm occlusion, never pure black
      ao.setQualityMode(preset.aoMode);
      ao.configuration.denoiseIterations = preset.aoDenoise;
      postPasses.push(ao);
    }

    const smaa = new SMAAEffect({ preset: preset.smaa, edgeDetectionMode: EdgeDetectionMode.COLOR });
    const effects: Effect[] = [];
    if (!preset.smaaPass) effects.push(smaa); // must come first: it resamples the input buffer
    if (preset.bloomLevels > 0) {
      effects.push(new BloomEffect({ mipmapBlur: true, luminanceThreshold: 3.5, luminanceSmoothing: 0.6, intensity: 0.55, radius: 0.7, levels: preset.bloomLevels }));
    }
    // AgX: filmic highlight roll-off that desaturates deep shade gracefully (no crushed, over-
    // saturated darks); the grading LUT below puts back the golden-hour saturation it removes.
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.AGX }));
    effects.push(new LUT3DEffect(lut)); // gentle warm grade, display-referred
    effects.push(new VignetteEffect({ offset: 0.32, darkness: 0.42 }));
    const main = new EffectPass(camera, ...effects);
    const last = preset.smaaPass ? new EffectPass(camera, smaa) : main;
    last.dithering = true; // halffloat → 8 bit: no banding in the sky
    postPasses.push(main);
    if (last !== main) postPasses.push(last);
    for (const p of postPasses) composer.addPass(p);
  }

  function applyShadows(): void {
    const s = sun.shadow;
    if (s.mapSize.x !== preset.shadowMapSize) {
      s.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
      s.map?.dispose();
      s.map = null; // reallocated by the renderer at the new size
    }
    s.camera.far = preset.shadowDistance;
    s.radius = preset.shadowRadius;
  }

  function setQuality(q: Quality): void {
    quality = q;
    preset = PRESETS[q];
    applyShadows();
    applySize();
    buildPost();
    applySize(); // new passes pick up the current size
    resetFrameStats();
    resetDynamic();
    upgradeSky();
  }

  // ---- frame timing, fps, dynamic resolution ---------------------------------------------------
  // Driven by the rAF rate against `target`. A frame cap (30/48/50 Hz panels, laptop battery saver,
  // iOS low-power mode) holds fps below 60 whatever the load: a step down that does not raise fps
  // reveals it, the scale is restored and the cap becomes the target until fps exceeds it again.
  let lastFrameAt = 0;
  let emaMs = 1000 / 60;
  let target = targetFor(quality);
  let winMs = 0, winFrames = 0, prevWinFps = 0;
  let lowStreak = 0, highStreak = 0;
  let lastUpAt = -1e9, upBlockedUntil = 0, failedProbes = 0;
  let pendingDown: { fps: number; scale: number } | null = null; // verify that the last step down helped
  let settleUntil = 0; // ignore frames right after a change (shader compiles, reallocations)
  let measuring: { ms: number; frames: number; need: number; resolve: (fps: number) => void } | null = null;

  function resetFrameStats(): void {
    winMs = 0; winFrames = 0; prevWinFps = 0; lowStreak = 0; highStreak = 0;
    settleUntil = performance.now() + 400;
  }

  function resetDynamic(): void {
    target = targetFor(quality); failedProbes = 0; upBlockedUntil = 0; pendingDown = null;
  }

  function setScale(s: number): void {
    const next = Math.min(1, Math.max(MIN_SCALE, Math.round(s * 100) / 100));
    if (next === scale) return;
    scale = next;
    applySize();
    resetFrameStats();
  }

  function trackFrame(ms: number, now: number): void {
    if (ms > 250) return; // tab switch, breakpoint, huge hitch
    emaMs += (ms - emaMs) * 0.06;
    if (now < settleUntil) return;
    if (measuring) {
      measuring.ms += ms; measuring.frames++;
      if (measuring.ms >= measuring.need) {
        const m = measuring; measuring = null;
        m.resolve((m.frames * 1000) / m.ms);
      }
      return; // no dynamic resolution while measuring
    }
    if (!dynamic) return;
    winMs += ms; winFrames++;
    if (winMs < EVAL_WINDOW_MS) return;
    const fps = (winFrames * 1000) / winMs;
    const bestRecent = Math.max(fps, prevWinFps);
    winMs = 0; winFrames = 0; prevWinFps = fps;
    if (pendingDown) {
      const p = pendingDown;
      pendingDown = null;
      if (fps < p.fps * HELPED) { target = Math.max(20, p.fps); setScale(p.scale); return; } // capped
    }
    if (target < targetFor(quality) && fps > target * 1.1) target = targetFor(quality); // the cap is gone
    if (fps < target * 0.92) {
      highStreak = 0;
      if (now - lastUpAt < 3000) { // the last step up was too much: back off, longer every time
        upBlockedUntil = now + PROBE_BACKOFF_MS[Math.min(failedProbes++, PROBE_BACKOFF_MS.length - 1)];
        lastUpAt = -1e9;
      }
      if (++lowStreak >= 2 && scale > MIN_SCALE) {
        lowStreak = 0;
        pendingDown = { fps: bestRecent, scale };
        setScale(scale - (fps < target * 0.7 ? 0.15 : 0.1));
      }
    } else if (fps >= target * 0.97) {
      lowStreak = 0;
      if (scale === 1) failedProbes = 0; // full resolution holds the target
      else if (now > upBlockedUntil && ++highStreak >= 4) { highStreak = 0; lastUpAt = now; setScale(scale + 0.1); }
    } else {
      lowStreak = 0; highStreak = 0;
    }
  }

  const measure = (seconds: number) => new Promise<number>((resolve) => {
    measuring = { ms: 0, frames: 0, need: seconds * 1000, resolve };
  });

  // ---- lighting ----------------------------------------------------------------------------
  const owned: Texture[] = [];
  let heightFog: FogExp2 | null = null;
  const originalFog = { fp: ShaderChunk.fog_pars_vertex, fv: ShaderChunk.fog_vertex, ffp: ShaderChunk.fog_pars_fragment, ff: ShaderChunk.fog_fragment };

  // Background sharpness follows the quality tier: low/medium load the 1k HDRI, high/ultra the 2k
  // (swapped in later if the quality is raised). The IBL is built once, from whichever came first.
  let assetsRef: Assets | null = null;
  let sky2k = false, disposed = false;
  const wants2k = () => quality === 'high' || quality === 'ultra';

  async function initLighting(assets: Assets): Promise<void> {
    assetsRef = assets;
    sky2k = wants2k();
    const hdr = await assets.hdri(sky2k ? LIGHTING.hdri2k : LIGHTING.hdri1k);
    hdr.mapping = EquirectangularReflectionMapping;
    // The SunLight provides the sun; keeping the sun disc in the IBL would light every shadow a
    // second time with warm sun energy (grey, flat shade). Env = sky only, background = full HDRI.
    const skyOnly = clampRadiance(hdr, SKY_CLAMP, new Color(...GROUND_RADIANCE));
    const pmrem = new PMREMGenerator(renderer);
    const env = pmrem.fromEquirectangular(skyOnly).texture;
    pmrem.dispose();
    skyOnly.dispose();
    const background = clampRadiance(hdr, SUN_DISC_CLAMP);
    const h = sampleHorizon(hdr);
    hdr.dispose();
    owned.push(background, env);
    scene.environment = env;
    scene.background = background;
    scene.environmentIntensity = ENV_INTENSITY;
    scene.environmentRotation.set(0, LIGHTING.envRotationY, 0);
    scene.backgroundRotation.set(0, LIGHTING.envRotationY, 0);

    // Haze colour = the HDRI's own horizon (sampled above, toward / across / away from the sun) so
    // distant facades melt into the sky behind them in every direction.
    const fog = new FogExp2(0xffffff, FOG_DENSITY);
    fog.color.copy(h.side); // linear radiance, same space as the background
    scene.fog = fog;
    heightFog = fog;
    installFogChunks(h, sunDir);
    upgradeSky(); // quality raised while the 1k was loading
  }

  function upgradeSky(): void {
    if (!assetsRef || sky2k || !wants2k() || !scene.background) return;
    sky2k = true;
    assetsRef.hdri(LIGHTING.hdri2k).then((hdr) => {
      const old = scene.background as Texture;
      const i = owned.indexOf(old);
      if (disposed || i < 0) return; // torn down, or someone else replaced the background
      scene.background = owned[i] = clampRadiance(hdr, SUN_DISC_CLAMP);
      old.dispose();
    }, () => { sky2k = false; }); // keep the 1k sky; retried on the next quality change
  }

  // --------------------------------------------------------------------------------------------
  const ro = new ResizeObserver(() => applySize());
  ro.observe(container);
  setQuality(quality);

  const engine: CoreEngine = {
    renderer, scene, camera,
    get quality() { return quality; },
    get fps() { return 1000 / emaMs; },
    get resolutionScale() { return scale; },
    get pixelRatio() { return renderer.getPixelRatio(); },
    get dynamicResolution() { return dynamic; },
    set dynamicResolution(on: boolean) {
      dynamic = on;
      if (!on) setScale(1);
    },
    initLighting,
    setQuality,

    async autoDetectQuality(seconds = 2.5): Promise<Quality> {
      const top: Quality = isTouchDevice() ? 'medium' : 'ultra';
      const wasDynamic = dynamic;
      dynamic = false; // measure every candidate at native scale
      setScale(1);
      // Frame time here is mostly fill (∝ pixels ∝ scale²): a preset within FIT_RATIO of the target
      // is carried to it by dynamic resolution at a scale of ~0.85, which beats a lower preset.
      const fits = (fps: number) => fps >= TARGET_FPS * FIT_RATIO;
      let q: Quality = top === 'medium' ? 'medium' : 'high';
      setQuality(q);
      let fps = await measure(seconds);
      if (fps >= TARGET_FPS * 0.95 && q !== top) {
        setQuality('ultra'); // ultra is a luxury: it must hold the target outright
        if ((await measure(Math.max(1.2, seconds * 0.6))) >= TARGET_FPS * 0.95) q = 'ultra';
        else setQuality(q);
      }
      while (q !== 'low' && !fits(fps)) {
        const lower: Quality = ORDER[ORDER.indexOf(q) - 1];
        setQuality(lower);
        const f = await measure(Math.max(1.2, seconds * 0.5));
        // Not faster with less work: the frame rate is capped (or CPU-bound), keep the richer preset.
        if (f < fps * HELPED) { setQuality(q); break; }
        q = lower; fps = f;
      }
      dynamic = wasDynamic;
      return q;
    },

    setFocus(): void {
      // Nothing to do: the SunLight cascades are fitted to the view frustum every frame (which
      // always contains the player), texel-snapped by three. Kept for the Engine contract.
    },

    render(dt: number): void {
      const now = performance.now();
      if (lastFrameAt) trackFrame(now - lastFrameAt, now);
      lastFrameAt = now;
      // height-fog term that only depends on the camera: once per frame instead of per fragment
      if (heightFog) heightFog.density = FOG_DENSITY * Math.exp(-FOG_FALLOFF * Math.max(camera.position.y, 0));
      renderer.info.reset();
      composer.render(dt);
    },

    dispose(): void {
      disposed = true;
      ro.disconnect();
      for (const p of postPasses) p.dispose();
      composer.dispose();
      lut.dispose();
      for (const t of owned) t.dispose();
      sun.dispose();
      Object.assign(ShaderChunk, { fog_pars_vertex: originalFog.fp, fog_vertex: originalFog.fv, fog_pars_fragment: originalFog.ffp, fog_fragment: originalFog.ff });
      renderer.dispose();
      canvas.remove();
    },
  };
  return engine;
}

// ----------------------------------------------------------------------------------------------
// Height fog with sun-directional in-scattering, installed into three's shared fog chunks so every
// material with `fog: true` (built-ins and ShaderMaterials alike) gets the same atmosphere.
// Uses the standard uniforms only: fogColor (= horizon colour 90° from the sun) and fogDensity.
function installFogChunks(h: { toward: Color; side: Color; away: Color }, sunDir: Vector3): void {
  const ratio = (c: Color) => `vec3(${[c.r / Math.max(h.side.r, 1e-4), c.g / Math.max(h.side.g, 1e-4), c.b / Math.max(h.side.b, 1e-4)].map((v) => v.toFixed(4)).join(',')})`;
  const sxz = new Vector3(sunDir.x, 0, sunDir.z).normalize();
  ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogRay;
#endif`;
  ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogRay = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz; // camera → vertex, world space
#endif`;
  ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform float fogDensity;
  varying float vFogDepth;
  varying vec3 vFogRay;
#endif`;
  // fogDensity arrives pre-multiplied by exp(-falloff * cameraHeight) (see render()).
  const t = ratio(h.toward), w = ratio(h.away);
  ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  {
    // exponential height fog, optical depth integrated analytically along the view ray
    float fK = ${FOG_FALLOFF.toFixed(5)} * vFogRay.y;
    float fH = abs( fK ) > 1e-3 ? ( 1.0 - exp( - fK ) ) / fK : 1.0 - 0.5 * fK;
    float fogFactor = 1.0 - exp( - fogDensity * length( vFogRay ) * fH );
    // horizon colour varies with the azimuth to the sun (golden toward it, cooler away)
    float fAz = dot( vFogRay.xz, vec2( ${sxz.x.toFixed(4)}, ${sxz.z.toFixed(4)} ) ) * inversesqrt( dot( vFogRay.xz, vFogRay.xz ) + 1e-6 );
    vec3 fTint = fAz > 0.0 ? mix( vec3( 1.0 ), ${t}, fAz * fAz * fAz ) : mix( vec3( 1.0 ), ${w}, - fAz );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor * fTint, fogFactor );
  }
#endif`;
}

/** Copy of an equirect HDR with every channel clamped to `max` (removes the sun disc/aureole).
 *  With `ground`, the lower hemisphere is replaced by that radiance (blended over the first few
 *  degrees below the horizon): a pure-sky HDRI has a dark blue-grey "ground", but the avenue's
 *  sunlit sandstone paving bounces warm light into every shadow. */
function clampRadiance(tex: DataTexture, max: number, ground?: Color): DataTexture {
  const img = tex.image as { data: Uint16Array | Float32Array; width: number; height: number };
  const { width: w, height: h } = img;
  const out = img.data.slice();
  const half = out instanceof Uint16Array;
  const lim = half ? DataUtils.toHalfFloat(max) : max; // positive half floats sort like their bits
  for (let i = 0; i < out.length; i++) if ((i & 3) !== 3 && out[i] > lim && (!half || out[i] < 0x8000)) out[i] = lim;
  if (ground) {
    const g = [ground.r, ground.g, ground.b];
    const gRaw = half ? g.map((v) => DataUtils.toHalfFloat(v)) : g;
    for (let y = Math.floor(h / 2); y < h; y++) {
      const below = ((y + 0.5) / h - 0.5) * 180; // degrees under the horizon
      const t = Math.min(1, below / GROUND_BLEND_DEG);
      if (t <= 0) continue;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          if (t >= 1) { out[i + c] = gRaw[c]; continue; } // fully below the blend band
          const v = half ? DataUtils.fromHalfFloat(out[i + c]) : out[i + c];
          const m = v + (g[c] - v) * t;
          out[i + c] = half ? DataUtils.toHalfFloat(m) : m;
        }
      }
    }
  }
  const t = new DataTexture(out, w, h, RGBAFormat, tex.type);
  t.mapping = EquirectangularReflectionMapping;
  t.colorSpace = tex.colorSpace;
  t.minFilter = tex.minFilter; t.magFilter = tex.magFilter; t.generateMipmaps = false;
  t.flipY = tex.flipY;
  t.needsUpdate = true;
  return t;
}

/** Average HDRI radiance in a band just above the horizon toward, across and away from the sun. */
function sampleHorizon(tex: DataTexture): { toward: Color; side: Color; away: Color } {
  const img = tex.image as { data: Uint16Array | Float32Array; width: number; height: number };
  const { data, width: w, height: hgt } = img;
  const half = data instanceof Uint16Array;
  const px = (x: number, y: number, c: number) => {
    const v = data[(y * w + (((x % w) + w) % w)) * 4 + c];
    return half ? DataUtils.fromHalfFloat(v) : v;
  };
  // the sun = brightest texel of the upper hemisphere (row 0 = zenith)
  let best = -1, sunX = 0;
  for (let y = 0; y < hgt / 2; y += 2) for (let x = 0; x < w; x += 2) {
    const l = px(x, y, 0) + px(x, y, 1) + px(x, y, 2);
    if (l > best) { best = l; sunX = x; }
  }
  const band = (cx: number) => {
    const c = new Color(0, 0, 0);
    let n = 0;
    const y0 = Math.round(hgt * (84 / 180)), y1 = Math.round(hgt * (88.5 / 180)); // 1.5°..6° up
    const span = Math.round(w * (14 / 360));
    for (let y = y0; y <= y1; y++) for (let x = cx - span; x <= cx + span; x += 2) {
      c.r += px(x, y, 0); c.g += px(x, y, 1); c.b += px(x, y, 2); n++;
    }
    return c.multiplyScalar(1 / n);
  };
  const side = band(sunX + w / 4).add(band(sunX - w / 4)).multiplyScalar(0.5);
  return { toward: band(sunX), side, away: band(sunX + w / 2) };
}

/** Procedural 32³ grading LUT (display-referred sRGB in → out) on top of AgX: warm highlights,
 *  slightly cool shade, saturation back up in the mid-tones and highlights (AgX mutes them) but
 *  not in deep shade (keeps it grey-blue, never navy), and a soft S-curve for contrast. */
function buildGradeLUT(): LookupTexture {
  const lut = LookupTexture.createNeutral(32);
  const d = lut.image.data as Float32Array;
  const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sh = 1 - smooth(0, 0.45, l), hi = smooth(0.35, 1, l);
    r += -0.010 * sh + GRADE_WARM * hi;
    g += 0.000 * sh + GRADE_WARM * 0.62 * hi;
    b += 0.010 * sh - GRADE_WARM * 1.05 * hi;
    const l2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sat = 1 + GRADE_SAT * smooth(0.04, 0.4, l2);
    r = l2 + (r - l2) * sat; g = l2 + (g - l2) * sat; b = l2 + (b - l2) * sat;
    d[i] = sCurve(r); d[i + 1] = sCurve(g); d[i + 2] = sCurve(b);
  }
  lut.needsUpdate = true;
  return lut;
}

/** Soft S-curve on 0..1 with fixed end points: slope 1+k at mid-grey, 1-k at the ends. */
function sCurve(x: number): number {
  x = Math.min(1, Math.max(0, x));
  return x - (S_CURVE_K * Math.sin(2 * Math.PI * x)) / (2 * Math.PI);
}

// Shared preview harness for module dev pages (dev/*.html). NOT used by the game build.
// URL params: ?cam=x,y,z&target=x,y,z&fov=50&q=high&shadows=0
// Sets window.__ready = true once `ready()` is called by the page; window.__stats has fps/draw calls.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Assets } from '../src/core/assets';
import { Physics } from '../src/core/physics';
import { LIGHTING } from '../src/core/config';
import type { BuildContext, Quality, SharedUniforms } from '../src/core/types';

const params = new URLSearchParams(location.search);
const vec = (s: string | null, d: [number, number, number]) => (s ? (s.split(',').map(Number) as [number, number, number]) : d);

export interface Harness {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  ctx: BuildContext;
  onFrame(fn: (dt: number, t: number) => void): void;
  ready(): void;
}

export async function createHarness(opts: { cam?: [number, number, number]; target?: [number, number, number] } = {}): Promise<Harness> {
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = params.get('shadows') !== '0';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(Number(params.get('fov') || 50), innerWidth / innerHeight, 0.1, 2000);
  camera.position.set(...vec(params.get('cam'), opts.cam ?? [10, 6, 14]));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...vec(params.get('target'), opts.target ?? [0, 1, 0]));
  controls.update();

  const assets = new Assets(renderer);
  const hdr = await assets.hdri(LIGHTING.hdri2k);
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(hdr).texture;
  scene.background = hdr;
  scene.environmentRotation.set(0, LIGHTING.envRotationY, 0);
  scene.backgroundRotation.set(0, LIGHTING.envRotationY, 0);
  scene.environmentIntensity = 0.5;
  scene.fog = new THREE.Fog(0xe8c9a0, 120, 700);

  const sun = new THREE.DirectionalLight(LIGHTING.sunColor, 4.5);
  const sunDir = new THREE.Vector3(...LIGHTING.sunDirection).normalize();
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.03;
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -60; sc.right = sc.top = 60; sc.near = 1; sc.far = 400;
  scene.add(sun, sun.target);

  const uniforms: SharedUniforms = { uTime: { value: 0 }, uWind: { value: new THREE.Vector3(1.5, 0.3, 0.5) } };
  const physics = await Physics.create();
  const quality = (params.get('q') as Quality) || 'high';
  const ctx: BuildContext = { physics, assets, quality, renderer, uniforms };

  const frameFns: ((dt: number, t: number) => void)[] = [];
  const timer = new THREE.Timer();
  timer.connect(document);
  let frames = 0, acc = 0;
  (window as any).__stats = { fps: 0, calls: 0, triangles: 0 };
  renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    const t = timer.getElapsed();
    uniforms.uTime.value = t;
    controls.update();
    // shadow frustum follows the orbit target
    sun.target.position.copy(controls.target);
    sun.position.copy(controls.target).addScaledVector(sunDir, 200);
    frameFns.forEach((f) => f(dt, t));
    renderer.render(scene, camera);
    frames++; acc += dt;
    if (acc > 0.5) {
      (window as any).__stats = { fps: Math.round(frames / acc), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
      frames = 0; acc = 0;
    }
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  return {
    renderer, scene, camera, controls, sun, ctx,
    onFrame: (fn) => frameFns.push(fn),
    ready: () => ((window as any).__ready = true),
  };
}

// Landmarks preview: every monument at its real layout position on a flat paved floor.
// URL: ?cam=x,y,z&target=x,y,z&fov=50&q=high  ·  ?view=<name> jumps to a preset (see VIEWS)
// Presets are also listed on window.__views for the screenshot script.
import * as THREE from 'three';
import { createHarness } from './harness';
import { buildLandmarks } from '../src/world/landmarks';
import { CURB, LANDMARKS } from '../src/core/layout';

const L = LANDMARKS;
const VIEWS: Record<string, [number[], number[]]> = {
  wide: [[-150, 40, 90], [-260, 12, -20]],
  cathedral: [[-262, 1.35, 8], [-272, 16, -40]],
  cathedral40: [[-248, 12, 32], [-272, 18, -45]],
  embassy: [[-266, 1.35, 12], [-272, 5, 40]],
  embassy40: [[-240, 14, -8], [-272, 6, 45]],
  ibn: [[-264, 1.35, 5], [-272, 5, 0]],
  ibn40: [[-236, 12, 18], [-272, 4, 0]],
  theatre: [[-168, 1.35, -12], [-175, 12, -40]],
  theatre40: [[-150, 14, 2], [-175, 10, -45]],
  colisee: [[-24, 1.35, 12], [-30, 12, 40]],
  colisee40: [[0, 16, -8], [-30, 14, 45]],
  bourguiba: [[L.bourguibaStatue.x - 12, 1.35, 4], [L.bourguibaStatue.x, 7, 0]],
  bourguiba40: [[L.bourguibaStatue.x - 34, 10, 20], [L.bourguibaStatue.x, 7, 0]],
  clock: [[L.clockTower.x - 14, 1.35, 6], [L.clockTower.x, 16, 0]],
  clock40: [[L.clockTower.x - 40, 12, 16], [L.clockTower.x, 18, 0]],
  porte: [[L.porteDeFrance.x + 35, 1.35, 3], [L.porteDeFrance.x, 7, 0]],
  porte40: [[L.porteDeFrance.x + 38, 12, 20], [L.porteDeFrance.x, 7, 0]],
  avenueWest: [[-120, 1.35, 0], [-300, 10, 0]],
  avenueEast: [[40, 1.35, 0], [285, 18, 0]],
  // close-ups for detail review
  bourguiba34: [[L.bourguibaStatue.x - 9, 8.5, 6.5], [L.bourguibaStatue.x, 8.6, 0]],
  bourguibaSide: [[L.bourguibaStatue.x + 1, 8.8, 13], [L.bourguibaStatue.x, 8.4, 0]],
  ibnClose: [[L.ibnKhaldoun.x + 4.2, 6.6, 2.2], [L.ibnKhaldoun.x, 6.4, 0]],
  ibnPlaques: [[L.ibnKhaldoun.x + 3.4, 2.1, 0.4], [L.ibnKhaldoun.x, 2.0, 0]],
  coliseeGallery: [[-30, 1.35, 24.5], [-30, 2.6, 40]],
  coliseeArcade: [[-19, 1.35, 31.4], [-25, 1.9, 35.2]],
  theatreClose: [[-172, 1.9, -26.5], [-175, 4.5, -37]],
  cathedralPorch: [[-266, 1.9, -27], [-272, 4, -36]],
  embassyRoof: [[-262, 22, 8], [-272, 13, 45]],
  palms: [[-262, 1.35, 21], [-279, 7.5, 38]],
  clockBase: [[L.clockTower.x - 8.5, 1.35, 5], [L.clockTower.x, 1.0, 0]],
};
(window as unknown as { __views: typeof VIEWS }).__views = VIEWS;
const params = new URLSearchParams(location.search);
const preset = VIEWS[params.get('view') ?? ''] ?? VIEWS.wide;

const h = await createHarness({ cam: preset[0] as [number, number, number], target: preset[1] as [number, number, number] });
h.camera.far = 3000;
h.camera.updateProjectionMatrix();

// Flat stand-in floor (the street module owns the real paving).
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(1100, 400).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0xb8ad9c, roughness: 0.92 }),
);
floor.position.set(-40, CURB, 0);
floor.receiveShadow = true;
floor.visible = params.get('floor') !== '0'; // ?floor=0 shows only what the landmarks module builds
h.scene.add(floor);

// ?street=1: also build the street module (read-only import) to check seams against its paving.
if (params.get('street')) {
  const { buildStreet } = await import('../src/world/street');
  floor.visible = false;
  h.scene.add((await buildStreet(h.ctx)).root);
}

const t0 = performance.now();
const part = await buildLandmarks(h.ctx);
const buildMs = Math.round(performance.now() - t0);
console.log(`[landmarks] built in ${buildMs} ms`);
(window as unknown as { __lmBuildMs: number }).__lmBuildMs = buildMs;
h.scene.add(part.root);
h.onFrame((dt, t) => part.update?.(dt, t, h.camera.position));
// ?dispose=1: build → dispose → rebuild, reporting GPU memory + collider counts (leak check).
if (params.get('dispose')) {
  const info = h.renderer.info.memory;
  h.camera.far = 5000; h.camera.position.set(0, 900, 1); h.camera.lookAt(0, 0, 0); h.camera.updateProjectionMatrix();
  h.renderer.render(h.scene, h.camera); // upload everything
  const before = { geometries: info.geometries, textures: info.textures, colliders: h.ctx.physics.world.colliders.len() };
  part.dispose?.();
  h.renderer.render(h.scene, h.camera);
  const after = { geometries: info.geometries, textures: info.textures, colliders: h.ctx.physics.world.colliders.len() };
  (window as unknown as { __leak: unknown }).__leak = { before, after };
}
h.ready();
// Collider probe for tests: window.__ray([x,y,z], [dx,dy,dz], max) → hit distance or null.
// The harness never steps physics; one step builds Rapier's query pipeline (static colliders only).
h.ctx.physics.step();
(window as unknown as { __ray: (o: number[], d: number[], max: number) => number | null }).__ray = (o, d, max) =>
  h.ctx.physics.raycast(new THREE.Vector3(...o), new THREE.Vector3(...d).normalize(), max)?.distance ?? null;

// Per-mesh breakdown for perf work: window.__meshes() → [{name, tris, verts, shadow}] by triangles.
(window as unknown as { __meshes: () => { name: string; tris: number; verts: number; shadow: boolean }[] }).__meshes = () => {
  const out: { name: string; tris: number; verts: number; shadow: boolean }[] = [];
  part.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const n = (g.index ? g.index.count : g.attributes.position.count) / 3;
    const inst = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh).count : 1;
    out.push({ name: mesh.name, tris: Math.round(n * inst), verts: g.attributes.position.count * inst, shadow: mesh.castShadow });
  });
  return out.sort((a, b) => b.tris - a.tris);
};

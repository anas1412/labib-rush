# Module integration notes (end of phase B)
Written by each module's final agent. Public APIs, wiring, and known issues.

## core

### API
Unchanged signatures.

// src/core/engine.ts
export interface CoreEngine extends Engine {
  readonly resolutionScale: number;   // dynamic-resolution factor 0.6..1
  readonly pixelRatio: number;
  dynamicResolution: boolean;         // default true; false resets scale to 1 (and the frame-cap target)
}
export function createEngine(container: HTMLElement): CoreEngine
//   Initial quality: 'medium' on touch devices, 'high' otherwise.
//   initLighting(assets): loads the 1k HDRI for low/medium or the 2k for high/ultra. A later setQuality(high|ultra) swaps in the 2k background async.
//   setQuality(q): also resets the dynamic-resolution target and back-off.
//   autoDetectQuality(seconds = 2.5): Promise<Quality>. Touch devices are capped at medium; if a lighter preset is not faster (frame cap), the richer one is kept.
//   setFocus(): no-op (cascades fit the view).

// src/core/input.ts
export function createInput(canvas: HTMLElement, settings: Settings): Input
//   isTouch = the last device used (touch/pen → true; mouse press or WASD/arrow key → false).
//   Held keys persist across setEnabled(); edges and deltas are cleared.

// src/player/controller.ts
export interface CorePlayerController extends PlayerController { dispose(): void }   // removes the kinematic body + collider + character controller
export function createPlayerController(physics: Physics, avatar: LabibAvatar, events: Emitter<GameEvents>): CorePlayerController

// src/player/cameraRig.ts
export function createCameraRig(camera: PerspectiveCamera, physics: Physics, settings: Settings): CameraRig
//   May set target.avatar.root.visible = false while the camera is within 0.55 m of Labib; always restores it (above 0.75 m, and in menu mode).

// dev/core.ts (dev only): window.__core.sim(frames, moveX, moveY, { sprint?, lookDX?, jumpFrames? })
//   Deterministic fixed-dt controller + physics + rig run; returns per-frame samples (x, y, z, vx, vz, g, yaw, arm, clear, avatar).

### Integration
SETUP ORDER (main.ts)
- `const engine = createEngine(document.getElementById('app')!)`. The container fills the screen; the canvas goes in at z-index 0 with touch-action:none.
- Optionally call `engine.setQuality(saved)` before initLighting. Touch devices default to medium (1k sky); others to high (2k sky).
- `await engine.initLighting(new Assets(engine.renderer))` before building the world or compiling world materials.
- After adding the world's colliders, call `physics.step()` once.

PER FRAME (this order matters)
1. `const f = input.poll(); if (f.pausePressed) pause();`
2. `player.update(dt, f, rig.yaw)`
3. The fixed-step `physics.step()` loop. The player is a kinematic body: update() places it and sets its next kinematic translation, which the following step applies with a velocity. Stepping before update() delays litter pushing by one frame; it is otherwise harmless.
4. `rig.update(dt, f, player)`
5. `engine.render(dt)`

QUALITY
- For settings.quality 'auto', keep rendering the menu backdrop and `await engine.autoDetectQuality()`, then save the result. It takes about 7 s here.
- Dynamic resolution runs by itself. It detects 30/48/50 Hz frame caps and backs off failed probes. `engine.dynamicResolution = false` pins the scale at 1.

INPUT
- `createInput(engine.renderer.domElement, settings)`.
- setEnabled(true/false) on play / pause / menus. Held keys survive this, so W held through the countdown works at once.
- Call `input.requestPointerLock()` inside the Play/Resume click handler.
- The #touch overlay is click-through except its buttons. The stick and look drags start on the canvas, so the HUD container must keep pointer-events:none, and anything placed over the canvas in the bottom corners blocks touches there.
- isTouch follows the last device used, so the HUD may want to re-read it (e.g. to show touch or keyboard hints).

PLAYER
- Add avatar.root to the scene yourself.
- Run start: `player.reset(PLAYER_SPAWN, PLAYER_SPAWN_YAW); rig.reset(PLAYER_SPAWN_YAW)`.
- Taxi hit: `player.knockback(dir, ~9, RULES.hitStun)` plus `rig.shake(0.7)`.
- Mint tea: `player.setSpeedMultiplier(TEA_SPEED)`, and back to 1 when it ends.
- The kick event position is 0.7 m in front of Labib at +0.25 m height.
- The footstep event fires about 4 times/s running and 5 sprinting.

PHYSICS (changed)
- The player capsule is on a kinematicPositionBased body. Collider membership PLAYER, filter LITTER|NPC|VEHICLE|SENSOR, active collision types DEFAULT|KINEMATIC_FIXED|KINEMATIC_KINEMATIC.
- Fixed sensors (bins, pickups) report intersections with the player. Walking into dynamic litter pushes it; prefer distance checks (RULES.pickupRadius/depositRadius) for pickups.
- The character controller itself only collides with STATIC|LOW_PROP|NPC.

CAMERA
- `rig.setMenuMode(true)` behind the main menu; false glides into gameplay over 1.1 s.
- The rig may hide avatar.root while the camera is within 0.55 m of Labib; don't fight root.visible elsewhere.
- Camera blockers: only STATIC colliders count. Round STATIC colliders with radius ≤ 0.45 m (trunks, lamp posts) never pull the arm in unless the camera would penetrate them; boxes and big cylinders pull it in after 0.2 s of occlusion. Facades, trunks, kiosks and statues must be STATIC; benches, planters and café furniture LOW_PROP.

LOOK
- AgX tone mapping plus the grading LUT in the post chain; renderer.toneMapping stays NoToneMapping.
- Materials should be authored for AgX (slightly desaturating); the LUT puts mid-tone saturation back.

### Perf
Setup: Intel UHD (Comet Lake GT2), 1600x900, device pixel ratio 1, graybox, heaviest view (spawn at the west end looking east down the avenue). The machine never went quiet: load stayed at 9–17 for over an hour because of other agents' Chromium sessions. I waited 20+ minutes for it to drop and it did not, so no uncontended run was possible.

GPU ms per frame at scale 1, measured through the real composer path (the best of 5 interleaved rounds; each sample is 15 frames rendered back-to-back, then a readPixels sync), load about 14:

| preset | GPU ms | draw calls | triangles |
|---|---|---|---|
| low | 18.8 | 199 | 152k |
| medium | 20.3 | 224 | 155k |
| high | 31.0 | 247 | 158k |
| ultra | 53.6 | 265 | 162k |

- The previous least-contended reference (load about 3) was 16.1 / 19.3 / 29.5 / 54.1 ms. My changes add about 0.5 ms at high (2nd AO denoise) and a little at low (1536 shadow maps).
- The rAF fps and dynamic-resolution columns from core-perf.mjs are meaningless at this load (5–22 fps).
- autoDetectQuality() → medium, in 7.3 s.

Cost breakdown, measured at load about 5 through the composer path:
- low total 15.4 ms: the image-based lighting (IBL) is about 4.5 ms, shadow sampling + cascades about 2.5, height fog about 1.5.
- Front-to-back opaque sorting: no gain (15.3 ms).
- N8AO at high is about 7.4 ms (high 31.1 → 23.7 with AO off). Its fixed full-screen passes dominate: cutting samples from 8 to 4 saves about 1 ms.
- Overdraw into a depth-buffered target is 1.9 (1.45 with front-to-back sorting).

Phone viewport (844x390 @3x, low): about 10 ms GPU.

The dynamic-resolution logic is verified deterministically (virtual clock), independent of load.

### Known issues
- 60 fps at 'high' at native 1600x900 is still not met on this iGPU (about 29–31 ms per frame), and even 'low' is about 15–19 ms. Dynamic resolution recovers the frame rate, and autodetect picks a preset that reaches 60 fps at a render scale of about 0.85 or higher. See contract_changes_requested.
- Where I disagree with the critique's performance fixes (with measurements): (a) A downsampled PMREM does not help: a 64-size PMREM costs the same as the 2k one within noise. The IBL cost is shader arithmetic, not texture size. (b) The critique's 'raw scene' ablation (30.7 → 18.2 ms without the environment map) was measured on the dev page's raw path, which renders to the canvas. That canvas has no depth buffer, so overdraw there is about 7x instead of 1.9x, which inflates the IBL cost. Through the composer the IBL costs about 4.5 ms at low. (c) A LightProbe or spherical-harmonics replacement for diffuse/rough IBL recovers only about 1.5 ms of that 4.5 ms; most of the rest is the indirect-lighting BRDF math that any ambient term needs. It would also drop specular IBL on rough surfaces and force every glossy material in other modules to set an explicit envMap. Not done.
- Dynamic resolution is driven by the rAF rate (with frame-cap detection and probe back-off), not by EXT_disjoint_timer_query GPU time. The extension is missing on Safari and Firefox and gave inconsistent numbers on this ANGLE/Mesa stack.
- A trunk or lamp post directly between the camera and Labib is deliberately never collided in (only camera penetration pulls the arm in), so a trunk right behind a standing Labib can hide him until he moves. The alternative was a top-down view of the ground, which I tried and rejected.
- With his back to a facade the camera rises to a steep view (about 60°) over Labib's head. It is a transient state and clears as soon as he steps away from the wall.
- The avatar is hidden with root.visible when the camera is closer than 0.55 m; there is no fade (needs an avatar API, see contract_changes_requested).
- Kinematic-body capsule: dynamic litter is pushed at walking speed, but a small can hit by the lower hemisphere can squeeze under the capsule. Gameplay should pick litter up or kick it by proximity (RULES.pickupRadius), not by contact.
- The IBL is built once from whichever HDRI loaded first. A later quality change only swaps the background resolution.
- Under heavy GPU contention the keyboard-timed checks in core-test.mjs print SKIP. Their deterministic sim twins always run.
- The rotated PCF shadow penumbra still shows a faint stipple close up (reduced by the smaller radius). Beyond the preset shadow distance (55/90/130/180 m) there are no shadows; the haze mostly hides this.
- Carried over from the previous report: (1) initLighting() must run before world materials compile, because the fog shader chunks are installed there. (2) The sun is a SunLight, not a DirectionalLight, so custom shaders that read directionalLights[] won't see it. (3) setFocus is a no-op. (4) Chrome refuses to re-lock the pointer for about 1 s after Esc. (5) autoDetectQuality only resolves while engine.render() keeps being called. (6) Stepping up a curb costs one frame of reduced movement (average speed across it 6.40–6.48 m/s).

### Contract changes requested
- docs/ARCHITECTURE.md performance budget: replace '60 fps at high on a UHD 630' with '60 fps at the auto-detected preset with dynamic resolution (scale ≥ 0.8)'. Measured: even 'low' takes 15–19 ms per frame at native 1600x900 on this iGPU, and 'high' 29–31 ms; N8AO alone is about 7.4 ms.
- types.ts LabibAvatar: add setOpacity(v: number) (dithered fade 0..1), so the camera rig can fade Labib when the camera is close instead of toggling root.visible.
- types.ts PlayerController: add dispose(): void. CorePlayerController already has it; it removes the kinematic body, collider and character controller (for the 20-restart no-leak requirement).
- types.ts Engine.setFocus: redundant with the cascaded SunLight (kept as a no-op). Remove it or mark it optional.
- src/types/n8ao.d.ts: declare `autoDetectTransparency: boolean` and `setQualityMode`'s configuration fields `denoiseIterations`/`transparencyAware` (engine.ts casts for the first).
- dev/harness.ts: both use AgX now, but sun intensity (harness 4.5 vs engine 7.5 SunLight), environment (harness 0.5 with the sun disc vs engine 0.85 sun-clamped with warm ground) and fog (linear vs height fog) still differ. Have the harness use createEngine, or mirror these, so modules tune under the final look.

## street

### API
src/world/street.ts:
  export async function buildStreet(ctx: BuildContext): Promise<StreetResult>
  // StreetResult = { root: Object3D; anchors: SpawnAnchors; update(dt, time, cameraPosition): void; dispose(): void }
  // NEW: update() is now defined and must be called every frame with the render camera's position. It drives the tree LOD partition (a re-sort every 3 m of camera travel, no allocations). If it is never called, every tree stays at full detail, which is the old behaviour and cost.
  // dispose() removes root from its parent, frees all GPU resources and removes every collider it added.

Anchor counts (Vector3, world space, surface height in y; the same at every quality):
- benches 85: on the ground 0.6 m in front of each seat.
- cafeTables 140: table top, y = CURB + 0.757.
- kioskRoofs 30: 5 per kiosk, y = CURB + 2.3.
- planters 118: on the rim ledge, y = CURB + 0.57, |local z| 0.395. Now outside every collider.
- roadEdges 266: in the gutter, y = 0.
- cafeChairs 314: seat centre, y = CURB + 0.46.

Everything under src/world/street/ is internal.

### Integration
Wiring:
- Call `const street = await buildStreet(ctx); scene.add(street.root)`, then pass `street.anchors` into GameContext.anchors.
- NEW: every frame, call `street.update(dt, time, camera.position)` with the render camera; the tree LOD follows it. It is cheap: a 134-tree re-sort only after 3 m of camera travel. It also works for the menu camera.
- The engine must advance ctx.uniforms.uTime and keep uWind.xz as the wind vector (m/s), with uWind.y as gustiness 0..1. Trees, flags and water read these.

New G.STATIC colliders:
- Canopy boxes: 4 per ficus row, x from about -238 to 256, y from CURB+3.36 to CURB+6.46, |z| ≈ 5.8–13.2. The camera rig's sphere cast now avoids the foliage; kicked cans and blown bags bounce off it.
- Fence walls: 4.5 m tall, front face 0.1 m in front of each fence plane.
  - X_MIN: face at x = -309.4, |z| ≤ 12. The Avenue de France facades from the buildings module close |z| = 12.
  - X_MAX: face at x = 309.4, across the full |z| ≤ 30.
  - Alley ends: at z = ±(30+14-1.2), face 0.1 m on the avenue side. Each alley is fenced across its full 8 m width.
- The old closure walls are gone.

Other colliders, unchanged:
- Ground slabs (y -0.5 to CURB) plus the catch-all y = 0 floor.
- G.STATIC: trunks, lamps, kiosks, flag and sign poles.
- G.LOW_PROP: benches, café furniture, bollards, crates, flower stand.
- Planters now have two LOW_PROP boxes: stone up to CURB+0.57 over 2.3×1.0 m, and the hedge (1.9×0.58 m) up to CURB+1.05.

Mesh names (for debugging and profiling):
- Static props: `street-<group>-c<chunk>`, with chunk 0–5 of 120 m from x = -320. Groups: iron, wood, lamp-glass, planter-stone, hedges, flowers, galvanized, cafe.
- Trees: `street-ficus-{trunks,core,cards}-{near,far}`. Their `visible` flag is managed by the LOD, so hide them through layers instead.
- Fences: `street-fence-{tarps,mesh,feet}`.

Rendering:
- Ground meshes use renderOrder 2 (drawn after the other opaque meshes), inlays and covers 1.5, leaf cards 1, road paint -1.
- The lake-shore and hill silhouettes are drawn just in front of the far plane and are never culled, so they appear behind everything at any far-plane setting.
- The street adds no lights. Lamp glass is emissive for bloom. The lake uses scene.environment, and the silhouettes blend 30% toward scene.fog.color.

Layout facts other modules rely on (unchanged):
- Lanes and bins are clear.
- Landmark islands are kept free with r + 0.6 clearance.
- Café terraces occupy 0–5.4 m from the facade line.
- Kiosk crate steps are on the kiosk's local +x side.
- The flags near the Bourguiba statue now stand at (196.5, ±2.5).

Dev page: dev/street.html
- `?cam=…&target=…&q=…` for viewpoints and quality.
- `?hide=name|prefix*` hides meshes.
- `?far=1400` uses the game camera's far plane.
- `?gpu=all,halfRes,noShadowPass,noGround,noTrees,noCards,noCore,noProps,onlySky,cardsFirst,fullIbl,aniso2&rounds=4` runs the GPU-timer A/B; read window.__gpu.
- `?dispose` runs the memory and collider check; read window.__dispose.
- Self-check results are in window.__streetCheck: floorsOk, blockedBins, laneHits, roofsOk, plantersOff, canopyOk and canopy extents, fencesOk.
- The shared scripts/shot.mjs gets hit by Vite full reloads whenever other agents edit files. Blocking the page's WebSocket in Playwright (`page.routeWebSocket(/.*/, () => {})`) makes shots and benchmarks reliable.

### Perf
Setup: harness at 1600×900, Intel UHD 630, 4096 shadow map, no post-processing. Draw calls and triangles include the shadow pass.

Why fps is not used: other agents' browsers kept the load average at 10–19 and the machine was swapping, so fps swung between 11 and 39 on the same view. GPU time was measured instead with `EXT_disjoint_timer_query_webgl2` around each whole frame (`dev/street.html?gpu=…`, several A/B rounds in one page, reported as the 5th percentile). With the dev server's reload socket blocked, repeated runs agreed within about 0.5 ms.

GPU time per frame at high (the sky and clear alone cost 1.8 ms):
- West end, eye level (worst view): 16.9 ms, so about 15.1 ms for the street. At half resolution it is 7.7 ms, so about 12 ms depends on resolution.
- Other views: under the ficus 16.2 ms, wide aerial 16.0, café 17.0, lake 10.5.

Breakdown at the worst view (drop in frame time when each part is hidden):

| Part | ms |
|---|---|
| Ground | 5.9 |
| Trees in total | 6.9 |
| of which leaf cards | 1.9 |
| Props | 2.0 |
| Shadow pass | 2.5 |
| Water (lake view) | 1.2 |
| Cheaper foliage sky reflection (saving) | 0.4 |

Draw calls and triangles at the west view (previous version: 64 calls, 1.08M triangles):

| Quality | Draw calls | Triangles |
|---|---|---|
| low | 104 | 681k |
| medium | 105 | 729k |
| high | 106 | 762k |
| ultra | 106 | 857k |

Draw calls at high in other views: wide 110, under the ficus 106, café 97, kiosk 92, alley 77, X_MAX 59, X_MIN 48, lake 47. All are within the 150 budget.

Other numbers:
- Build time: 1.4–2 s.
- Download: 3.7 MB of the 12 MB budget (unchanged).

### Known issues
- Missed target (≤8 ms, ≥45 fps in the harness): the street still costs about 15 ms of GPU time at 1600×900 at high. The cost is almost all pixel shading: at half resolution the whole frame drops to 7.7 ms. Two surfaces cover the screen: the paving (about 6 ms) and the ficus canopies (about 5 ms including shadows). That matches the engine's own measurement of about 13 ms for a full-screen PBR graybox on this GPU. Further cuts would cost visible quality: AF 2 on the ground albedo saves about 0.9 ms but blurs the paving at grazing angles. The realistic lever is the engine's dynamic resolution.
- Partly disagree with 'split every instanced set into chunks': props are chunked (120 m, merged by material). Trees use a per-instance near/far split instead, because LOD by 120 m chunk would switch at a chunk edge up to 200 m away or pop at 40 m. The split gives exact distance LOD with 6 draw calls (plus shadows) instead of about 30. The far set spans the map but is light (320-triangle core, 336-triangle trunk, 45% of the cards, no card shadows).
- Disagree with 'every ground mesh spans the whole map': the ground is about 2.5k triangles in total, so chunking it would only add draw calls. Its cost is shading, which culling does not reduce. Hidden overdraw was the real problem and is fixed (the base plane is cut out, and the ground now draws last).
- Not done: canopies reaching over the central walk. Open sky over the central walk is kept on purpose. Canopies reaching |z|≈3 would sit about 1 m above the kiosk roofs (|z| up to 5.45, roof at 2.45 m). They would block Labib's roof jumps and squeeze the camera where litter spawns. Photos of the avenue also show the central walk mostly open between the two rows.
- Canopy colliders are boxes, 4 per row, sized to the smallest tree. The top 1–1.5 m of each crown (above CURB+6.46) has no collider, and at the tops of the gaps between neighbouring trees there are small invisible pockets.
- Fences: the visible fence is 2.3 m, but its collider is 4.5 m tall. From the ground, Labib's feet never rise above the fence top, so he always visibly touches it. Only a jump from a planter (hedge top 1.05 m, planters stand ≥2.2 m in front) could put his feet about 0.25 m above the fence top against the invisible part.
- Tree LOD needs street.update() every frame (see integration notes). A far tree switching to near shows a density change in the leaf-card fringe at 80 m (45 m at low); it is hard to see in the fog.
- Props have no distance LOD: low draws 681k triangles (incl. shadows), mostly iron props (≈150k) and café furniture (≈84k), the same at every quality. A simplified far-chunk version of the lamps and benches would be the next step for phones.
- Textures are still WebP, not KTX2: no basis/toktx encoder is installed and no dependency was added. GPU memory is therefore uncompressed (about 150 MB at high). Converting the 21 PBR maps would be quick once an encoder is available.
- The canopy underside is a dense, fairly smooth dark-green surface with baked leaf-clump shading. It reads as clipped ficus but shows no branches or sky gaps from directly below.
- Flags look salmon-pink when seen from the unlit side in full sun (tone mapping). Their albedo was lowered to 0.85 so the red holds up in direct light.
- The fps figures captured in the screenshot [stats] lines are not meaningful because of the contention described in perf. The GPU-timer p5 numbers are the reliable ones.

### Contract changes requested
- None required.

## buildings

### API
src/world/buildings.ts:
  export async function buildBuildings(ctx: BuildContext): Promise<WorldPart & { stats: BuildingsStats }>
  export interface BuildingsStats { buildings: number; chunks: number; meshes: number; trianglesNear: number; trianglesFar: number; trianglesHinter: number; trianglesProxy: number; colliders: number }

The returned WorldPart:
- root: a Group named 'buildings'. It contains 26 THREE.LOD objects named `bld-<N|S><chunk>`. Each has level children `bld-<key>-L0` / `-L1` holding the meshes `bld-<key>-L<0|1>-<masonry|cutout|glass|signs>`, plus a plain child `bld-<key>-hinter` that is always drawn. Directly under root are `bld-flags` and `bld-shadow-proxy`.
- There is no update(). Animation runs on ctx.uniforms.uTime and uWind.
- dispose() removes every collider and frees every geometry, material and texture the module created.

Internal to the module:
- plan.ts: planCity() → { buildings, reserved, walls }, assignSigns(), bayGrid(), BEND.
- facade.ts: buildBuilding(), collider(), hinterBlock(), impostorWall(), impostorGround().
- geo.ts: GeoBuf, now with extrudePath().
- textures.ts: loadBuildingTextures(), which now also returns `noise`.
- materials.ts: createMaterials(), which now also returns `proxy`; WIN.
- signs.ts: buildSignAtlas(), SIGNS.

### Integration
Wiring:
- Call `const bld = await buildBuildings(ctx); scene.add(bld.root);` after engine.initLighting(). The glass and the masonry's sky lighting rely on scene.environment being set.
- On teardown call bld.dispose(); it also removes the colliders.
- No per-frame call is needed. The engine only has to advance ctx.uniforms.uTime and uWind (flags and swaying plants).

Load hitch: call `renderer.compileAsync(scene, camera)` during the loading screen. Otherwise the first frame compiles about 10 large programs (masonry near and far, glass, ironwork, signs, flags, proxy), which is a visible stall on slow CPUs.

Shadows:
- Only `bld-shadow-proxy` (map-wide) and the near-version `-L0-cutout` meshes cast. Everything else receives.
- The proxy sets an empty draw range in onBeforeRender and restores it in onAfterRender, so only the shadow pass draws it. Don't give it an override material.
- The shaders support both SunLight (the game) and DirectionalLight (the dev harness) as the sun. Shadow lookups are skipped on surfaces facing away from the sun.

LOD: detail switches by camera distance to each chunk's anchor on the facade line: 100 / 130 / 180 m on medium / high / ultra, with 8% hysteresis. 'low' builds only the far version (512² textures, cheap shaders), keeping the flags.

Colliders:
- G.STATIC slabs about 1 m thick, front face 0.12 m in front of the facade line, reaching the roofline.
- They cover every facade segment, alley walls and backs, arm walls, the closing buildings, and the bend (its far end, the back of the corner building, and a safety wall along its inner side).
- Awnings (valance at 3.12 m or higher), balconies and signs have no colliders.

For the street module: extend the arm road (y=0) and the 2 m sidewalks into the bend (x from c.x+6 to c.x+20, |z| from 48 to 56).

For gameplay/traffic: the TAXI_ROUTES points are still at z=±54, 2 m in front of the closing facades and in view; see the requested layout change.

Dev page (dev/buildings.html) URL parameters:
- `cam`, `target`, `q`, `fov`: camera and quality, as in the shared harness.
- `engine=1`: render through the real engine.
- `street=1` / `landmarks=1`: add the neighbouring modules for context.
- `hide=<regex,…>`: hide meshes by name.
- `gpu=<hide|hidemas|hideglass|hidecut|plain|basic|noshadow|noproxy|nocutcast|noreceive|far|allfar>`: A/B GPU timing; the result (median and p10) appears in window.__gpu after ~20–40 s.

Self-checks are in window.__bld: `miss` must be [] and `narrow` must be []. window.__plan lists every building with its style, position, floors and shops.

### Perf
Draw calls (the [stats] line in harness mode, including the shadow pass, 1600×900; buildings budget is 150):
- Promenade: 86. Eye level looking west: 83. Mid north: 77.
- Skyline: 81.
- Café close-up: 63. Wall close-up: 48. Tower: 34. Alley: 22. Cross street: 25.
- Low quality: 69.
- About 1 extra call is the shadow proxy's empty main-pass draw.

Triangles:
- High: near version 346k, far 145k, hinterland 26.7k (now stored once), shadow proxy 38k.
- Low: far version 144k, hinterland 4.2k, proxy 29k.
- Per view, the stats line shows 71k (alley) to 170k (eye level west).
- Meshes: 236 on high, 131 on low. Colliders: 152.

Textures:
- Download: 2.3 MB (10 WebP files; budget 12 MB). Also a procedural 256² noise texture (0.35 MB on the GPU with mipmaps).
- GPU memory is about 115 MB on high, as before.
- CPU copies of textures and geometry are freed after upload (≈61 MB of geometry on high).

Build time: ~2 s on high, ~1.3 s on low (up to 5 s under CPU load).

GPU time. Method: alternating 30-frame blocks with and without the buildings, GPU timer queries, median and 10th percentile over ~180 frames each, 1600×900, DPR 1. Other agents' screenshot jobs ran during every run and inflate long frames most.
- Real engine (`?engine=1`, high, promenade): buildings cost 12.7 ms (median and p10 agree). The first engine measurement this session, before the facing-shadow, ironwork lighting and LOD changes, was 14.5 ms.
- Engine breakdown (p10, measured mid-session):
  - Masonry main pass: 6.0 ms. With an unlit material instead it is 2.6 ms less. The near shader's normal map and weathering together cost under 1 ms, and plain MeshStandardMaterial costs the same as the custom shader.
  - Shadow casting: 2.2 ms. Glass: 1.6 ms. Ironwork and plants: 1.5 ms.
  - Using the far version everywhere saves another 4–5 ms (this is what motivated the 130 m switch).
  - The rest is post-processing (N8AO etc.) running on pixels that would otherwise be sky.
- Harness (4096² single shadow map): 13.8 ms p10 / 16.1 ms median. The critique measured 15.6 ms median at a quieter time.
- In the harness, the proxy's shadow fill cost is 2–3 ms. That is shadow-map fill (the street walls cover ~40% of the map), not geometry. The engine's 2×2048² cascades roughly halve it.

### Known issues
- Still over the ≤6 ms GPU target: about 12.7 ms through the engine on the UHD 630 at 1600×900 on high, when facades fill half the screen. I disagree that 6 ms is reachable at this quality. Plain MeshStandardMaterial on the same geometry costs as much as the custom shader, the near-only shader features cost under 1 ms, and the rest is filling and shading facade pixels plus post-processing that would otherwise see sky. Further cuts have to come from the engine: dynamic resolution (already present), the shadow-map size and range, or 'low' (far version only).
- Critique fix (4) was only partly adopted. The normal detail and fine dirt fade out at 30–45 m as asked. The low-frequency weathering (patchy tone, streaks, damp) fades at 80–120 m instead: it now comes from a mip-filtered texture and costs under 1 ms measured, while fading it at 45 m would leave most of the visible avenue with clean walls.
- The shadow proxy saves geometry, not much time: shadow casting is limited by shadow-map fill, so any set of casters that reproduces the building shadows covers the same texels. Walls-only proxy shells remove the redundant footprint fill. Thin details that are not in the proxy (window reveals, surrounds, open shutters, signs, dishes) cast no shadow; balconies, cornices, bands, awnings and AC units do. Near ironwork casts its own alpha-tested shadow; far ironwork does not.
- The far version now switches in closer (130 m on high). Small props (AC units, dishes, plants), 3D shutters and fine mouldings pop once at that distance. The 8% hysteresis prevents flicker, but there is no cross-fade (it would mean drawing both versions during the fade).
- The cross-street bend (x from c.x+6 to c.x+20, |z| from 48 to 56) sits on the street module's base asphalt at y = -0.04, 4 cm below the arm road at y = 0, and has no sidewalks. It is only glimpsed from the avenue at an angle; head-on the arm reads as a T-junction. The taxi routes in layout.ts still start and end at z=±54 in the arm, in view (see contract_changes_requested).
- The café names and awning colours in signs.ts are copied by hand from src/world/street/cafes.ts, in CAFE_TERRACES order (see contract_changes_requested).
- Normals and colours are not packed into Int8/Uint8, because vertex colours go above 1.0 (whitewashed roofs at 1.2). GPU memory is unchanged (~115 MB of textures plus geometry). A lost WebGL context now needs a module rebuild, since both the textures and the geometry have freed their CPU copies.
- The first frame after adding the buildings compiles about 10 large shader programs. Under CPU load this took several seconds in the dev page (one context screenshot caught a frame from before it finished). See integration_notes.
- The shop interior type follows the shop kind (e.g. jeweller = sparse niches, prêt-à-porter = clothes rails, bookshop or chemist = stocked shelves), but all shops of one type share the same procedural layout. Interiors are only drawn within 60 m; beyond that the window shows a flat tint.
- Ironwork: alphaToCoverage is not used (the engine renders without MSAA). Distant railings are dark bands blended over a shade colour; foliage stays alpha-tested at every distance, so it thins out far away.
- The 8 m corner lot between the embassy (x=-248) and the west cross street (x=-240) is fixed by the layout: it has a 5 m main facade plus the cut corner and an 18 m side-street facade. The sliver check allows it.

### Contract changes requested
- layout.ts TAXI_ROUTES: move the spawn and exit points out of the visible arm into the bend east of each arm end: (267, 0, -52) spawn and (-221, 0, -52) exit for the westbound route; (-221, 0, 52) spawn and (267, 0, 52) exit for the eastbound route. The bend spans x from c.x+6 to c.x+20 and |z| from 48 to 56, with 7.8 m clear between the collider faces at |z| = 48.12 and 55.88.
- layout.ts CAFE_TERRACES: add the café name (fr/ar) and awning colour to each entry, so street/cafes.ts and buildings/signs.ts read one source instead of two hand-copied lists.

## landmarks

### API
**src/world/landmarks.ts** (unchanged contract)
```ts
export async function buildLandmarks(ctx: BuildContext): Promise<WorldPart>
```
- `root`: Group 'landmarks'. All monuments are in world coordinates; add it to the scene as is, unrotated.
- `update(dt: number, time: number, cameraPosition?: Vector3): void` turns the flags downwind (reads `ctx.uniforms.uWind`) and refreshes the clock hands once a second.
  - `cameraPosition` is not needed. Distance detail uses `THREE.LOD` objects, which the renderer updates itself per camera, and the shadow pass reuses the same level.
- `dispose(): void` frees every geometry, material and texture the module owns (including the hands' InstancedMesh) and removes all 101 colliders from `ctx.physics`.

**Internal modules** (not for other modules):
- kit.ts: `Bucket` (`add`, `addDetail`, `addMany`, `setOptions`, `build`), `DETAIL_DIST`, `T`, `box`/`cyl`/`lathe`/`extrude`/`wall`/`archOutline`/`archivolt`/`molding`/`balustrade`/`hipRoof`/`mergeAll`.
- facade.ts: facade helpers.
- materials.ts: `createMaterials(ctx)` returns `LandmarkMaterials`. New members: `paving`, `bark`.
- env.ts: `Env` (collider bookkeeping, `ground()`, `plants`), `SignAtlas` (skyline-packed; `material`, and the new self-lit `glow`), `fitFont()`, `remapUV()`.
- plants.ts: `plantCells()`, `palmCrown()`, `crossCards()`.
- flag.ts: flag builders.
- statueMesh.ts: `loadStatueMesh(assets, url)` (bin format v2 adds an optional `cavity` attribute) and `statueLOD(name, near, far, mat, dist?)`.
- One `build<Name>(env, …): Landmark` function per landmark file.

### Integration
**Wiring in main.ts**

```ts
const lm = await buildLandmarks(ctx);
scene.add(lm.root);
```

- Call `lm.update(dt, time, camPos)` every frame; `lm.dispose()` on teardown.
- Build once per session, not once per run.

**Loading and rendering**
- Textures load through `ctx.assets.texture`. The six statue `.bin` files load with a FileLoader on `ctx.assets.manager`, so they count in the loading progress.
- It awaits `loadFonts()` itself.
- Glass and gilding need `scene.environment` set; the engine's HDRI does this.
- **LODs are automatic.** The statues (full detail up to 45 m, lighter version beyond) and the fine ornament (hidden beyond 140 m: theatre garlands and sculpted group, cathedral angels) are `THREE.LOD` objects. Leave `LOD.autoUpdate` at its default (true); nothing needs calling.
- The Colisée shop and gallery glazing is one transparent draw (opacity 0.3) over self-lit interior cards. If N8AO puts halos on it, turn on N8AO's transparency awareness.
- The footprint paving shares the street's plaza textures through the asset cache, so there is no extra download.

**Colliders (101 in total)**
- G.STATIC:
  - building masses, tower bases, plinths and steps (one box per step)
  - cathedral piers and the three closed porch gates
  - theatre fronts split into doors, turrets and wings, following the real faces
  - embassy railing, booth and side walls
  - Colisée pillars, shop wall and gallery (the passage is walkable up to the glazed doors at z = 43.8)
  - lawns and planted islands (steppable, about 0.3 m)
- G.LOW_PROP: the Ibn Khaldoun fence ring and the embassy crowd barriers.
- Each footprint also gets a walkable slab: collider top at CURB, visual top 1 cm below CURB. The slab uses the street's plaza paving and UV frame, so it continues the street plaza seamlessly.
- Porte de France has no colliders.

**Space used outside or at the edge of the footprints (other modules must keep clear)**
- Cathedral steps reach z = −30.44. Theatre steps and lamp columns reach z = −30.4.
- Embassy barriers and booth sit at z 30.3–32.1, inside the footprint.
- Colisée overhangs (corrected figures):
  - The vertical blade sign reaches z ≈ 28.35, 1.95 m out from the facade at z 30.3, at heights 8.75–18.65 m.
  - Balcony slabs overhang to z ≈ 29.27 at 7.55 m and above.
- Ibn Khaldoun: raised lawn to r 6.4 and fence to r 6.5 around (−272, 0). Keep props out of r < 6.8, and see the island-radius request.
- Bourguiba plinth: 7.6 × 5.4 m around (205, 0). Keep promenade props out of x 201–209, z ±2.9.
- Clock tower: curb, lawn, hedge and flowers fill r ≤ 6.8 around (285, 0).
- Porte de France block: x −434.5 to −425.5, z ±6.4. The medina lane (visual only, with its own slab) runs x −470 to −440, z ±14.

**Quality**
- `ctx.quality === 'low'` drops the facade angels and the razor wire, plants fewer flowers (120) and uses a 512 px lattice texture.

**Tools**
- Re-bake the statues with `node dev/landmarks.bake.mjs <dir>`. The directory must hold `horse_brown.glb` and `man_suit.glb` (CC0 Quaternius; URLs in docs/credits/landmarks.md). It writes all six `.bin` files, including the `_lod` versions.
- Dev page views:
  - standard: `cathedral`, `cathedral40`, `embassy`, `embassy40`, `ibn`, `ibn40`, `theatre`, `theatre40`, `colisee`, `colisee40`, `bourguiba`, `bourguiba40`, `clock`, `clock40`, `porte`, `porte40`, `wide`, `avenueWest`, `avenueEast`
  - close-ups: `bourguiba34`, `bourguibaSide`, `ibnClose`, `ibnPlaques`, `coliseeGallery`, `coliseeArcade`, `theatreClose`, `cathedralPorch`, `embassyRoof`, `palms`, `clockBase`
- Dev page flags: `&street=1` also builds the street module (read-only import) to check seams; `&floor=0` hides the stand-in floor; `&dispose=1` runs the leak check.
- Dev page hooks: `window.__meshes()` gives triangles, vertices and shadow flag per mesh; `window.__ray(origin, dir, max)` probes the colliders.

**Credits**
- docs/credits/landmarks.md lists the Poly Haven textures, the Quaternius models and the shared street plaza texture. Copy them into CREDITS.md and the Credits screen.

### Perf
All figures are from the dev harness at 1600×900 with its 4096 shadow map. Draw-call and triangle counts include the shadow pass.

**Draw calls:**
- Everything visible (wide view and avenueWest): 69, budget 80. It was 61–63 before; the increase is 2 detail meshes and 1 lit-interior material.
- Single landmarks: 11–45. The Ibn Khaldoun views, which also take in the cathedral and embassy: 50–59.
- Colisée: 18–44. Clock tower: 15–16. Porte de France: 23. avenueEast: 18.

**Triangles per frame:**

| View | Before | Now |
|---|---|---|
| Wide / avenueWest | 525k | 378k |
| Cathedral eye | 398–455k | 346k |
| Cathedral 40 m | – | 403k |
| Theatre 40 m | 386k | 314k |
| Theatre eye | – | 265k |
| Bourguiba | 134k | 131k |
| Colisée | – | 42k |
| Clock tower | – | 29–69k |
| Ibn Khaldoun 40 m (includes cathedral and embassy) | – | 424k |

**Scene totals:**
- High quality: 62 meshes, 405k triangles (both LOD levels of each statue are counted; only one draws).
- Vertices: 480k. The same meshes non-indexed would be 1.22M corners, so about 2.5× fewer vertex-shader runs.
- Shadow casters: 273k triangles.
- Low quality: 61 meshes, 357k triangles.

**Biggest meshes:**

| Mesh | Triangles |
|---|---|
| Cathedral stone | 59.6k (+ 36.7k in its no-shadow detail mesh) |
| Bourguiba statue, near | 58.6k |
| Bourguiba statue, far | 19.1k |
| Ibn Khaldoun statue, near | 41.3k |
| Ibn Khaldoun statue, far | 8.1k |
| Theatre plaster | 35.4k (+ garlands and sculpted group in its detail mesh) |

**Frame rate:** not meaningful here. Load average was 16–17 on 8 cores with about 27 Chromium processes on the shared iGPU; I saw 11–39 fps across views.

**Other numbers:**
- Build time: about 1.3–1.4 s including fetches, measured under that same load. Before this pass it took 4–7 s under the same load.
- Downloads: 3.9 MB total, budget 8 MB: 2.3 MB textures and 1.63 MB statue meshes (6 `.bin` files). The paving reuses the street module's plaza textures from the cache.
- Colliders: 101.
- Leak check (`?dispose=1`): all 101 colliders removed, 58 GPU geometries and 26 textures freed. The 14 geometries and 7 textures left belong to the harness (floor, PMREM, background, shadow map).

### Known issues
- Hero statues are still built from stylised low-poly rigs. Faces are the flat Quaternius face, the waving hand is a mitten-like paddle, and Ibn Khaldoun's open left hand and sleeve read as a horn-like silhouette when backlit, within about 5 m. Both are now much better at gameplay distance (plinth tops are 4–6 m up). Truly realistic faces would need a sculpted source mesh.
- Where I disagree with the critique, rider scale: I did not scale the rider up 1.12×. Measured against the horse, the rider's sitting height is already at the statue's ratio (about 2.2–2.4× the ear height above the saddle, as in the reference photo), so scaling up would make him too big. I fixed the thin, child-like look with a broader torso (+26% width, driven by skin weights), cloth thickness, an overcoat skirt, a saddle and saddle cloth, stirrups and reins.
- Where I disagree with the critique, cameraPosition: `update()` still ignores cameraPosition on purpose. Distance detail uses THREE.LOD objects, which the renderer updates per camera, and the shadow pass then uses the same level. That is the native mechanism, with no per-frame code in the module.
- Flags cast no shadow. I took the critique's cheaper option (castShadow = false) rather than writing a custom depth material for the waving cloth.
- Shaded sides of the bronzes look very dark in the dev harness, which uses environment intensity 0.5 and sun 4.5. The game engine uses 0.85 and 7.5, so they will read lighter in-game. Looking toward the low sun, a statue is physically a near-silhouette.
- Shop interiors are flat painted cards. Their depth comes only from the 0.6 m display boxes behind the glass, not from interior mapping.
- The footprint paving depends on the street module's files `public/textures/street/plaza_*.webp`. If they are renamed or moved, the landmarks fall back to their own sandstone texture: no error, but the joint at the footprint edge would show.
- The dev harness never steps physics, so `dev/landmarks.ts` does one `physics.step()` to build Rapier's query pipeline for the `window.__ray` probes. This is dev-only.
- Unchanged from before: the sides and backs of the buildings are plain rendered walls, the medina lane behind Porte de France is visual only with no colliders, and every dev page logs a favicon 404 (not a landmarks asset).
- Screenshots from headless Chromium sometimes come back blank under GPU contention. A rerun fixes it; it is not a module bug.

### Contract changes requested
- street module (src/world/street/ground.ts, `ISLANDS`): raise the Ibn Khaldoun island radius from 5 to 6.6. The landmarks module's raised lawn reaches r 6.4 and its fence r 6.5, so at r 5 the street's inner granite ring (r+0.25..r+0.85) is buried under the lawn. Bourguiba (r 5; plinth corners at r 4.66) and the clock tower (r 7; planting to r 6.8) are fine as they are.

## labib

### API
**src/player/labib.ts**
- `export async function createLabib(ctx: BuildContext): Promise<LabibAvatar>` implements `LabibAvatar` exactly:
  - `root: Object3D`, origin at the feet, facing local +Z.
  - `height = 1.235` m (top of the head, ears excluded). Ear tips reach 1.484 m.
  - `update(dt, motion: AvatarMotion)`
  - `trigger(action: AvatarAction)`
  - `setChechia(on)`, `setRadarGlow(on)`, `setSprintTrail(on)`
  - `dispose()`
- `export interface LabibStats { triangles; farTriangles; shellTriangles; bones; buildMs; inWorker; parts: {name, tris, ms}[] }` is informational only, found on `avatar.root.userData.labibStats`. `farTriangles` is new: the coarse LOD, 0 at 'low'.

**Internal modules** (no need to import them):
- `labib/body.ts`: `buildBody(q: Quality): LabibBodyData`, which is `{ near: BodySet; far: BodySet | null; shell; shellFarCount; headTop; parts }`, with `BodySet` = `{ fur, cloth, gloss, triangles }`.
- `labib/rig.ts`: `buildRig()`, `BONE_SPECS`, landmarks `P`/`HD`, `EYE_*`, `EAR_*`, `TAIL_PTS`.
- `labib/anim.ts`: `class Animator`.
- `labib/materials.ts`: `createMaterials(quality, uniforms, shared, renderer)`.
- `labib/extras.ts`: `createChechia(material, segments)` and `createTrail(material, ribbons, length)`, whose trail `update(anchors, fade, dt)` now takes `dt`.
- `labib/builder.ts`: `GroupBuilder`, `toGeometry`.
- `labib/sdf.ts`: `surfaceNets` plus SDF primitives.

### Integration
**Setup**
- Call `const labib = await createLabib(ctx);` early. The sculpt runs in a Web Worker alongside other loading and posts a heartbeat when it starts. It falls back to the main thread once: after 10 s if the worker never starts, or 60 s if it goes silent after starting.
- Then `scene.add(labib.root)`.
- The controller owns root's position (feet) and `rotation.y` = yaw (0 faces +Z).
- Don't scale root: the avatar squashes, stretches and leans an inner group itself.

**Per frame**
- Call `labib.update(dt, motion)` once per rendered frame, after the controller has moved root. dt is the real frame dt (clamped internally to 1/20 s).
- Keep feeding the real speed during actions. Pickup, deposit, caught, hit and victory now layer over the walk/run cycle, so legs keep striding while the upper body acts.
- `turnRate` is signed rad/s, positive when yaw is increasing; it drives the lean into turns.

**Trigger mapping (suggested)**
- 'jump' on take-off; 'land' on touchdown.
- 'kick' on the kick button (plays up to 1.55× faster at run speed).
- 'pickup' and 'deposit' on those events.
- 'hit' on a taxi hit, then set state 'stun' for the stun duration.
- 'caught' when catching a litterbug.
- 'victory' on a ×5 combo, NEW BEST or GOOOAL.

**Power-ups**
- `setChechia` for the ×2 chéchia.
- `setRadarGlow(true)` for the 2 s ear radar.
- `setSprintTrail(true)` during mint tea. It shows mint ribbons from the ear and tail tips plus a mint rim glow; the trail length is time-based (0.3 s) and independent of fps.

**Rendering**
- Needs `scene.environment` (the HDRI) and the directional sun. Fur and cloth cast shadows; everything receives them.
- Detail level is automatic: a `THREE.LOD` inside root switches at 3.6 m from camera to feet, per render and before the shadow pass, so it works for any camera, including menus. Nothing needs calling.
- To avoid first-use hitches, keep `renderer.compileAsync(scene, camera)` during loading with root in the scene, before or within the first 30 `update()` calls. The chéchia and trail stay in the scene at zero size for those first 30 calls so their programs compile there or on the first rendered frames.
- Materials are named `labib-fur`, `labib-cloth`, `labib-gloss`, `labib-shell`, `labib-felt`, `labib-trail`.
- Frustum culling uses a fixed bounding sphere (centre y 0.78, radius 1.05) that covers all poses.
- Quality comes from `ctx.quality` at creation; to switch quality, `dispose()` and recreate.
- Shell fur is transparent, depth writes off, renderOrder 1.

**Dev page** (http://127.0.0.1:5180/dev/labib.html)
- `anim=idle|walk|run|sprint|jump|fall|stun`
- `action=kick|pickup|deposit|hit|victory|caught|jump|land`, with `at=<s>` to freeze and `every=<s>` to repeat
- `freeze=<s>`, `chechia=1`, `radar=1`, `trail=1`
- `move=1` travels forward (the camera follows); it wraps back to the origin at 30 m, and the trail resets on that jump
- `spin=`, `yaw=`, `turn=`, `q=`, plus the harness's `cam`, `target` and `fov`
- `window.__labib` holds stats; `window.__labibRoot` and `window.__harness` are available for scripts.

### Perf
**Triangles** (triangle and draw-call counts are deterministic):

| Quality | Near sculpt | Far LOD (> 3.6 m) | Shells at max count |
|---|---|---|---|
| low | 37.6k | none | none |
| medium | 58.0k | 37.6k | none |
| high | 85.5k | 37.6k | 100.8k (10 layers) |
| ultra | 125.1k | 37.6k | 205.2k (14 layers) |

**At the gameplay camera** (0, 2.6, −5.5), Labib alone, main and shadow passes:
- low: 73.1k triangles, 5 draw calls.
- medium: 73.1k, 5 draw calls.
- high: 88.2k, 6 draw calls (3 main + 2 shadow + 1 instanced shell pass on tail and ears only, 3 layers). The critique measured about 190k before.
- ultra: 94.7k.

**Close-ups** use the near set and more shells: high hero 3/4 is about 236k, ultra close-up about 389k.

**Draw calls:** 6 at most, plus 3 with the chéchia and 1 with the trail, so 10 at most (budget 20).

**GPU time is noisy.** The machine ran at load average 10–16, with other agents running GPU benchmarks; the empty harness scene alone took 9–17 ms per frame instead of about 1–2 ms. The method is the minimum over 20 interleaved rounds of 4 synchronous renders, Labib shown vs hidden, 1600×900 with 4×MSAA and a 4096² shadow map. At the gameplay camera:
- high: +4.7 to 5.5 ms (one outlier at 9.5).
- low: +1.4 to 3.5 ms.
- ultra: +2.7 to 2.9 ms. With the near sculpt forced on the same page, ultra measured +5.1 ms, so the LOD roughly halves the cost where the numbers are stable.
- The noise floor is about ±2 ms: at low, where no far set exists, the "full" and "near forced" runs should be identical but read 1.4 vs 3.8 ms.
- Re-measure on a quiet GPU before trusting absolute ms.

**CPU:** `update()` measured about 0.17–0.19 ms under that load (the previous quiet-machine figure was 55–70 µs). The new per-frame work is a few dozen vector operations. No new per-frame allocations: the rate lookup is a method (no closures), and preallocated vectors and matrices are reused.

**Build:** runs in a worker. The far LOD adds about 15–20% of build CPU. Wall time under this load was medium 2.8 s, high 4.7–9 s, ultra 9–14 s; the main thread stays free.

**Leak test:** 3 create/dispose cycles with everything on returned `renderer.info.memory` geometries (18) and textures (12) to baseline.

### Known issues
- Ears now go beyond the 0.35 m capsule: ±0.47 m sideways and 1.484 m tall (+0.25 m above the 1.235 m head). This is visual only, but they can clip into facades when he hugs a wall. I took the reviewer's splay and the reference's enormous ears over capsule fit. The brief asked for ears adding about 0.35 m; I stopped at +0.25 m so the splayed ears don't block too much of the chase-camera view.
- The profile eye is much better (sclera and an iris crescent show) but not fully open. A lid dome still covers the back-top of the eyeball in a pure side view, because the lid corners must meet on the blink axis for blinks to close. Pushing the corners further back would leave a visible slit at the corners in every blink.
- Disagreement with the critique on AO: it suggested reducing the baked AO in the eye socket. AO is only baked into the skin, not the eyeball, so the grey sclera came from the texture's darkened rim and from the lids shadowing themselves in their recess. I lightened the sclera texture and changed the lid colours instead.
- Actions while moving: the non-acting arm holds its action or stance pose instead of swinging (for example, the fist on the hip during a running 'caught'). The kick is still full-body (the legs leave the stride for about 0.4 s at run speed), but it plays 1.55× faster at full run.
- Running pickup has no hip dip, unlike the critique's suggestion: lowering the hips would push the planted foot into the ground. It uses a deeper waist bend and a longer reach instead.
- The mouth still can't open (it is a crisp painted line with a crease). A jaw would mean re-sculpting the muzzle as a separate hinged part, which I skipped because the critique marked it optional. Expressions come from brows, lids, eyes, ears and body.
- The ears have no 'cup twist': the darker back rim and gradient already make the pointed shape readable from behind (shots 05 and 27).
- Beyond 3.6 m the head has no shell fur (sheen fur only). Only the tail and ears get 3 shell layers there. The difference is sub-pixel at the chase camera.
- Shell fur is alpha-blended with depth writes off (renderOrder 1), so it can sort oddly against other transparent effects that overlap Labib.
- The very first chéchia shadow render in a scene with no other non-skinned shadow casters compiles three's generic depth program. In the city, static casters have already compiled it.
- GPU ms figures were taken on a heavily shared GPU and are noisy (see perf). Triangle and draw-call counts are exact.
- Small skinning intersections in extreme poses (right hand near the satchel on arm swings, armpit compression in the fist pump and hit) are unchanged from before.

### Contract changes requested
- Optional, non-breaking: `trigger(action, intensity?: number)`. 'land' could scale the squash by impact speed (GameEvents.land has `impact`), and 'hit' could scale the knockback pose. It works without this today.
- Optional: expose the gait phase (for example `avatar.gaitPhase01` or an `onFootstep` callback) so audio can sync footsteps to the planted foot instead of a timer.

## props

### API
src/props/index.ts:
- `export async function createProps(ctx: BuildContext): Promise<Props>`
- `export interface Props extends PropFactory { litterShape(kind: LitterKind): LitterShape }`
- `export type { LitterShape }`, where `interface LitterShape { radius: number; halfLength: number; half: { x: number; y: number; z: number } }`
- `Props` is assignable to `PropFactory`; BinModel and TaxiModel are implemented exactly as in types.ts.

**litter(kind): Object3D**
- A Group named `litter-<kind>`, containing the item mesh(es) plus, except for 'bag', a child Mesh named 'contact-shadow'.
- Origin at the bottom centre; long axis along local X.
- can: 3 flavours; chips: 2 flavours; bag: white/blue. Each kind cycles its own variants.
- golden now lies on its side.

**litterRadius(kind): number**
- Returns the capsule radius: can 0.049, bottle 0.058, chips 0.052, golden 0.059, bag 0.16 (bag is a ball).

**litterShape(kind): LitterShape**
- Capsule along local X centred at (0, radius, 0), with segment half-length `halfLength`:

| kind | radius | halfLength | box half (x, y, z) |
|---|---|---|---|
| can | 0.049 | 0.022 | 0.071, 0.049, 0.049 |
| bottle | 0.058 | 0.152 | 0.21, 0.058, 0.072 |
| chips | 0.052 | 0.13 | 0.182, 0.052, 0.145 |
| golden | 0.059 | 0.151 | 0.21, 0.059, 0.059 |
| bag | 0.16 | 0 | 0.152, 0.245, 0.098 |

- `half` is the rest-pose box, centred at (0, half.y, 0). The chips values were measured before a last small reduction of the end curl, so the real chips box is now a little flatter; read them from `litterShape()`, not this table.
- Use the capsule for can, bottle and golden, and the box for chips.

**bin(): BinModel**
- Unchanged: openingHeight 1.045, openingRadius 0.19, half {x: 0.31, z: 0.31}, height 1.07; setHighlight / bump / update(dt).

**powerup(kind): Object3D**
- Unchanged. tea is about 0.5 m tall with its saucer.

**taxi(variant = 0): TaxiModel**
- length 4.344 (including bumpers), width 1.76, height 1.61.
- `update(dt, distance, steer)`: steer is clamped to ±0.6 rad; positive = toward +X = the car's left.
- `setBraking(on)` switches the brake lights instantly.
- `honk()`: two headlight flashes over 0.5 s.
- Allocates nothing on the GPU per instance.

**dispose()**
- Frees everything the module created.

### Integration
**Setup:** call `createProps(ctx)` once at load and keep the factory for the whole session. Taxis, bins, litter and power-ups can now be created and dropped freely: none of them allocate GPU resources. Pooling is still good practice but is no longer needed for memory.

**Litter**
- **Colliders:** use `props.litterShape(kind)`.
  - Cans, bottles and golden bottles: a capsule along local X with radius `radius` and segment half-length `halfLength`, centred at (0, radius, 0).
  - Chips: a box with half extents `half`, centred at (0, half.y, 0).
  - Bag: a ball of radius 0.16.
- **Syncing to the physics body:** wrap the visual so it rotates around the collider centre: `pivot.add(obj); obj.position.y = -radius` (use `-half.y` for chips), then sync the pivot to the rigid body. Give each spawned item a random yaw, since rest poses are no longer randomised.
- **Contact shadow:** the `obj.getObjectByName('contact-shadow')` child must be hidden while an item is kicked, tumbling or flying, and shown again when it rests. Its geometry and material are shared per kind, so it can be instanced.
- **Instancing:** `obj.children[i].geometry` and `.material` are shared per kind and variant, so they can be batched into InstancedMeshes. Bags work instanced too: copy `customDepthMaterial` onto the InstancedMesh.
- **Other:** the golden bottle pulses and shines by itself; flying bags read `uWind` and `uTime`.

**Bin**
- Unchanged: static box collider with half (0.31, 0.535, 0.31) centred at y = 0.535.
- The opening is r = 0.19 at y = 1.045.
- Call `setHighlight` while Labib carries litter, `bump()` on deposit and `update(dt)` every frame.

**Taxi**
- **Collider:** the body spans z −2.242..+2.102 and x ±0.878; mirrors reach x ±1.0. Suggested box half (0.88, 0.72, 2.17) centred at (0, 0.72, −0.07).
- **Wheels:** at (±0.74, 0.305, ±1.30).
- **Every frame:** call `update(dt, speed * dt, steer)`, even when parked, so honk flashes time out. Positive steer turns toward +X, the car's left; if the traffic controller's yaw sign is the opposite, negate it.
- **Honk and brakes:** pair `honk()` with the audio 'honk' event, and use `setBraking` when a taxi slows for Labib.
- **Variants:** `taxi(i % 3)` gives 3 paints, 3 roof-sign styles and 3 different plates.
- **Draw calls:** 6 per taxi. Only the body and wheels cast shadows.

**Rendering**
- Contact shadows, tea glass, PET and taxi glass are transparent with depthWrite off. The tea and PET glass use renderOrder 1; the bin marker uses 2.
- On ultra, the PET and tea glass use physical transmission.
- The bin marker fades with scene fog, both the engine's FogExp2 and the harness's linear Fog.

**Dev page** (dev/props.html) takes the harness params (cam, target, fov, q) plus:
- `engine=1`: render through the real Engine; use it to judge colour.
- `only=litter|bin|powerup|taxi`, `anim=0`, `brake=1`, `honk=1`, `hl=0`
- `colliders=1`: draws the litter capsules and boxes.
- `stress=1`: gameplay-like load, including an instanced bag batch.
- `disposeTest=1`: fills `window.__dispose` with memory counts before, with one of everything, with 10 more instances, and after `dispose()`.
- The real gameplay camera pose for litter at z = 0 is `cam=x,2.54,8.9&target=x,1.75,3.5&fov=60`.

### Perf
The machine was badly shared during this pass: load average 13–19 on 8 cores, with other agents' Chromium processes running, and several screenshots rendered blank before their first frame. Treat every fps figure as a floor; draw calls and triangles are exact.

**Per prop, high quality (draw calls / triangles):**

| prop | calls | triangles | change |
|---|---|---|---|
| can | 2 | 1.9k | +contact shadow |
| bottle | 3 | 4.1k | |
| chips | 2 | 1.7k | |
| golden | 2 | 2.8k | was 2 without a shadow |
| bag | 1 | 1.8k | |
| bin | 2 + 1 marker while highlighted | 2.7k | |
| tea | 2 | 16.0k | was 6.7k: mint bunch + saucer |
| bambalouni | 1 | 5.6k | |
| mashmoum | 1 | 9.1k | |
| chéchia | 1 | 6.5k | |
| taxi | 6 (paint, glass, atlas, 3 wheels) | 24.8k | was 4 / 20.8k |

**Low quality:** can 1.2k, bottle 2.8k, tea 11.7k, taxi 19.4k triangles.

**Showroom** (engine, high): 91 calls, 284k triangles, 36 fps.

**Stress test** (?stress=1&engine=1: 60 litter, 11 taxis, 7 highlighted bins, 8 power-ups, 7 bags, all in view, with shadows, AO and post):
- high: 397 calls, 1.06M triangles, 19 fps
- low: 362 calls, 645k triangles, 14 fps
- The previous report's stress run had 254 calls. The increase comes from the 60 contact shadows, 2 more wheel draw calls per taxi (also drawn in the shadow cascades), and slightly heavier taxis.
- A realistic gameplay view (about 20 litter, 4 taxis, 2 bins, 1–2 power-ups) is about 75 main-pass calls from props.

**Other**
- GPU textures are about the same as before (≈39 MB at high, ≈10 MB at low).
- Allocation test: extra instances add 0 GPU resources; `dispose()` returns memory to the starting point, programs included.
- Build time: `createProps` took 3.3 s at load average 14. The previous figure was 2.2 s at load average 7; expect it to be lower on an idle machine.

### Known issues
- Contact shadows are child meshes of the litter object (named 'contact-shadow'), so they move and rotate with the item. When a kicked or spilled item is airborne or tumbling, gameplay must hide the child (`obj.getObjectByName('contact-shadow').visible = false`) until it rests again. I did not auto-hide it because the module cannot know the ground height under a flying item.
- Where I departed from the review: the lamps bulge 4–13 mm with a bezel wall instead of being recessed 1–2 cm. A true recess would mean cutting holes in the lofted paint mesh, and the bulging lens with a bezel gives the same depth cue.
- Where I departed from the review: the golden bottle has no separate star-glint sprite (the review listed it as optional). A shader shine sweeps along it every ~3.75 s, plus a Fresnel rim and a pulse, at no extra draw call; the fx module's goldSparkle can add sparkles on top.
- Litter is deliberately larger than life (can ×1.4, the others ×1.3) so it can be spotted. Even so, cans are still only about 12–15 px at 9 m, so the gameplay highlight is still needed for items far away.
- Below ultra, the tea is opaque: dark red-brown with an amber edge glow standing in for light passing through it. On ultra the glass uses real transmission and looks better. From the gameplay camera it reads as a gilded glass of dark tea with mint on a saucer. Close up, the tea column still looks more like a dense red-brown drink than a see-through amber one.
- The front bumper's painted band is fairly thick and rounded, a 1990s look. Door gaps and shut lines are drawn by the paint shader, not modelled. The rear corners stay rounded in plan view. Up close the taxi is still clearly procedural, though it no longer reads as a soap bar.
- Draw calls: litter in view now costs about 2 calls per item (item + contact shadow, 3 for the PET bottle). Crowded scenes need instancing on the gameplay side; every call shares geometry and material, so building InstancedMeshes per kind and flavour is straightforward. The bag shader already supports instancing.
- Brake lights now switch instantly instead of fading up over about 50 ms, because lamp states are shared materials.
- All fps figures were measured with load average 13–19 on 8 cores. Several screenshots came out blank or white until I lengthened the wait to 5–9 s.
- Paint colours are still tuned for the engine's AgX + grading LUT; in the plain harness (without engine=1) the yellows look paler (see props-medium.png).
- The recycling mark is still a simplified three-arrow triangle.

### Contract changes requested
- Add `litterShape(kind: LitterKind): { radius: number; halfLength: number; half: { x: number; y: number; z: number } }` to PropFactory, with the LitterShape type moved to types.ts. It is already implemented and exported as `Props` / `LitterShape` from src/props/index.ts, so it only needs moving into the shared contract. Capsule along local X centred at (0, radius, 0); `half` is the rest-pose box centred at (0, half.y, 0).
- Optional: a `litterBatch(kind, capacity): InstancedMesh`-style helper, if gameplay would rather not build instanced batches itself. Not needed for correctness, because geometry and materials are already shared per kind.
- Withdrawn: the earlier request for per-instance dispose() on TaxiModel and BinModel. Taxis and bins no longer allocate anything per instance.

## people

### API
src/npc/people.ts:
- `export async function createPeople(ctx: BuildContext, opts?: PeopleOptions): Promise<PeopleFactory>`
  - `PeopleOptions = { onProgress?: (p01: number) => void }` reports atlas-painting progress; painting yields to the main thread.
  - `PeopleFactory.create(seed: number): Person` gives deterministic variety from the seed. Live people with the same seed share one ref-counted geometry.
  - `PeopleFactory.dispose(): void` frees every person, the material, the atlas and the blob-shadow mesh.
- `Person` (core/types, implemented exactly):
  - `root: Object3D` has its origin at the feet, facing +Z.
  - `height: number` is the top of the head or hat.
  - `setAnim(a: PersonAnim)`, `update(dt: number, speed: number)`, `setVisible(on: boolean)`, `dispose()` (safe to call twice).
- `export function handWorldPosition(person: Person, out: Vector3): Vector3` returns the world position of the right hand's grip point (the trash bone), for spawning thrown litter at THROW_RELEASE_SEC.
- `export const TRI_BUDGET = 3000`
- `export const SHADOW_DIST: Record<Quality, number> = { low: 0, medium: 12, high: 18, ultra: 26 }` (changed from a single number).
- Re-exported from anim.ts:
  - `THROW_RELEASE_SEC = 0.42`
  - `PICKUP_GRAB_SEC = 0.75`
  - `PICKUP_GRIP_Y = 0.07` (m above the feet at the grab)
  - `SEAT_HEIGHT = 0.475`
- `export interface PersonStats { seed; triangles; vertices; parts; traits }`, available as `person.root.userData.people`.

### Integration
Loading:
- Call `const people = await createPeople(ctx, { onProgress: p => ui.setLoading(..., 'People') })` under the loading screen. Painting takes about 0.5–1 s and yields to the main thread.
- Create a pool of Persons once, with seeds from a fixed range (for example 0–199), add each `p.root` to the scene, and reuse them with `setVisible` and repositioning. A new seed costs about 5–8 ms to build.

Every frame:
- Call `p.update(dt, speed)` for each visible person, where speed is the horizontal walking speed in m/s.
- `update()` also decides shadow-map casting (within `SHADOW_DIST[quality]` of the camera that last rendered a person) and writes that person's blob shadow.
- The blob mesh (one draw call for everyone) adds itself to the scene automatically; nothing to wire.
- `setVisible(false)` hides the blob too.

Draw-call budget:
- Each person costs 1 call, plus 2 cascades within 12 / 18 / 26 m at medium / high / ultra (no shadow maps at low).
- Keep about 30–35 pedestrians near the player at high to stay under 120 calls for everything else.

Placement:
- `root` origin is at the feet, facing +Z, so `root.rotation.y = atan2(dirX, dirZ)`.
- Place people on the sidewalk surface (y = CURB).

Café patrons:
- Put the root on the floor under the chair anchor, at `(anchor.x, anchor.y − 0.46, anchor.z)`, and face the table: `rotation.y = atan2(table.x − chair.x, table.z − chair.z)`. Then `setAnim('sit')`.
- Any seed can sit, including skirts and robes.
- Bags are hidden while seated.
- One-shots fired while seated move only the upper body.

Litterbugs:
- Call `setAnim('throw')`. At THROW_RELEASE_SEC (0.42 s), spawn the litter at `handWorldPosition(p, v)` with a forward-down velocity, and emit `litterThrown`.
- On "Caught!": call `setAnim('pickUp')` (standing people only). At PICKUP_GRAB_SEC (0.75 s) the grip is 0.07 m above the feet: remove the litter item then (place it about 0.2–0.35 m in front of the feet, slightly to the right). Duration 1.8 s.
- Calling pickUp during a throw now crossfades from the current pose instead of popping.

Other animations:
- `'startled'` (1.0 s) when Labib dashes past.
- `'cheer'` is a loop; switch back to `'idle'` or `'walk'` afterwards.
- `'talk'` is a loop for standing pairs; face them toward each other.

Other notes:
- `person.height` is the top of the head or hat, for the litterbug warning icon: `root.position.y + height + 0.25`.
- Physics: none. For "pedestrians bump Labib", add a kinematic capsule per person (group `G.NPC`, radius ≈ 0.25, half-height ≈ height/2 − 0.25) and move it with the root.

Dev page (dev/people.html):
- `?engine=1` renders through the game renderer.
- `?anim=…&at=` freezes a pose.
- `?from=sit&anim=idle` checks a transition.
- `?cafeShot=startled&at=0.25` fires a one-shot on the seated row.
- `?walkSeeds=` and `?cafeSeeds=` choose seeds; the defaults include skirts and robes.
- `?stress=60` runs 60 walkers.
- `?audit=2000` checks the triangle budget, `?pickAudit=300` checks pickUp grip height (must be ≤ 0.1 m), `?disposeTest=1` runs the leak test.
- `?atlas=decal|normal|shade` inspects the atlas.

### Perf
Measured with headless Chromium on the iGPU while other agents shared the machine, so fps numbers are indicative only. Draw calls and triangle counts are deterministic.

Per person:
- Triangles: at most 3000 over 2000 seeds (`?audit=2000`: max 3000, average 2839).
- Draw calls: 1, plus 2 shadow cascades when within `SHADOW_DIST[quality]` of the camera.
- The blob shadows for the whole crowd cost 1 draw call in total.

60-person stress scene, game renderer at 1600×900, camera 22–52 m from the crowd:

| Quality | Draw calls | Triangles | fps |
|---|---|---|---|
| low | 66 | 171k | 55 |
| medium | 74 | 171k | 45 |
| high | 84 | 171k | 45 |
| ultra | 93 | 193k | 24 |

The previous version used 144–200 calls at high and ultra.

Dev scene:
- Eye-level lineup (12 people): 59 calls, 100k triangles.
- Gameplay-distance view (25 people plus 42 dev café-furniture meshes that also cast shadows): 175 calls, 190k triangles.

CPU and memory:
- `update()` for 60 people: 0.9–1.2 ms per frame in total.
- Building a new seed: about 4.4 ms (audit) to 8 ms (in scene).
- `createPeople()`:

| Quality | Total time | Longest main-thread task | Tasks over 50 ms |
|---|---|---|---|
| high | about 0.9 s | about 150 ms | 1 |
| low | about 0.5 s | about 130 ms | 1 |

- Atlas GPU memory: 2 × 2048×1280 RGBA with mips, about 28 MB, at high/ultra; about 7 MB at low/medium.
- Download: 0 bytes.

Checks:
- pickUp grip height over 300 seeds: 0.070–0.074 m.
- Leak test (100 people created and disposed): 0 geometries or textures leaked.

### Known issues
- FPS numbers come from a GPU shared with other agents' browsers; re-measure 60 people in the integrated game.
- Disagreement with the review (budget): the hijab drape uses 18 segments and 7 rings, not the 22–24 suggested. At 22 the hijab alone cost about 590 triangles and pushed covered women over 3000. With the new rounding ring, hem and folds it no longer reads as a polygonal cape (people-a5-hijabs.png).
- Disagreement with the review (budget): glasses use 8-segment loops, not 10–12. At 1–2 cm on screen the octagon doesn't show, and 10 segments made sunglasses cost 212 triangles.
- Face sculpting was done within the budget rather than by adding the suggested 300–400 triangles. The head has 13 rows on the facial landmarks and 14 centre-weighted front columns (about 350 triangles at the front), with broad forms in the geometry; lids, lips and creases stay painted. Faces are still static decals: no blinking or lip motion.
- Kneeling pickUp in long skirts or robes makes the fabric a tent-like volume; the hand does reach the floor.
- A pickUp fired while seated moves only the upper body, so the hand stays around knee height. Switch the patron to 'idle' before a pickUp.
- Close up (about 1 m), shoulders on short-sleeve tops still look a little square, and jeans show a slightly lighter wedge at the crotch.
- The atlas's longest single task is about 150 ms (the stroke-heavy curly-hair cell, independent of resolution): one hitch on the loading screen.
- The blob-shadow InstancedMesh adds itself to the top ancestor (the scene) of the first person whose update() runs while in a scene. If people later move to a different scene, it stays in the first one.
- Changed export: `SHADOW_DIST` is now a per-quality record, not a number. Nothing else imports it yet.
- No colliders: the module is visual only. Phase C's crowd.ts should add kinematic capsules (see integration notes).

### Contract changes requested
- Optional: add `handWorldPosition(out: Vector3): Vector3` to the `Person` interface in core/types. It is already implemented; today it is available through the exported `handWorldPosition(person, out)` from src/npc/people.ts.
- Optional: document the extra second parameter `createPeople(ctx, { onProgress })` in core/types so the loading screen can show atlas progress. It is backward compatible.

## ui

### API
// src/ui/index.ts
export function createUI(root: HTMLElement, handlers: UIHandlers, opts?: UIOptions): UIController  // implements UIController exactly
export interface UIOptions { storagePrefix?: string } // dev page only; the game uses the default 'labibRush.v1.'
export function createProjector(camera: Camera): (world: Vector3) => ScreenPoint // for ui.setProjector(); returns one reused object; a point behind the camera gives visible=false with x/y pushed off-screen in the right direction (for the bin arrow)

// src/gameplay/rules.ts (pure: no DOM, three.js types only)
export interface Run { timeLeft; elapsed; score; chain; comboTimer; multiplier; bag: LitterKind[]; power: Record<'tea'|'bambalouni'|'chechia', number>; radarCooldown; radarTime; difficulty; over; stats; readonly hud: HudState; readonly events: RuleEvent[]; ... }
export type RuleEvent = { type:'timeWarning'; secondsLeft:number } | { type:'comboBreak'; chain:number } | { type:'powerupEnd'; kind:PowerUpKind } | { type:'difficulty'; level:number } | { type:'runOver' }
export function createRun(): Run
export function tick(run: Run, dt: number): RuleEvent[]   // skip while paused; returns run.events (the same array every call, valid until the next tick); empty once over
export function pickup(run: Run, kind: LitterKind, respilled?: boolean): { accepted: boolean; points: number; multiplier: number; chain: number; callout?: string } // respilled=true: 0 points, not counted in stats.pickups, still fills the bag and extends the combo
export function deposit(run: Run): { items: number; points: number; timeAdded: number; callout?: string } // points = items² × 5 (× chéchia); callout 'Yaatik saha!' on a full bag
export function trickShot(run: Run, kind: LitterKind): { points: number; timeAdded: number } // base × 2 × chéchia; counts as a binned item
export function caught(run: Run): number
export function hit(run: Run): { spilled: LitterKind[]; chainLost: number } // spills half the bag (rounded up, newest first) and resets the combo; re-pick spilled items with pickup(run, kind, true)
export function applyPowerup(run: Run, kind: PowerUpKind): { duration: number; timeAdded: number } // refreshes rather than stacks; mashmoum = +10 s at once
export const speedMultiplier: (run: Run) => number, scoreMultiplier: (run: Run) => number, magnetActive: (run: Run) => boolean, radarReady: (run: Run) => boolean, radarActive: (run: Run) => boolean
export function useRadar(run: Run): boolean
export function multiplierFor(chain: number): number
export function hudState(run: Run): HudState // same object every call
export function result(run: Run): RunResult
export const FULL_BAG_CALLOUT = 'Yaatik saha!'

// src/ui/storage.ts
export function createStore(prefix?: string, backend?: Storage): GameStore // { persistent, getName, setName, getScores, addScore → {rank, list}, bestScore(name) → number|null, getSettings, setSettings, hintSeen, markHint }
// keys: labibRush.v1.name / .scores / .settings / .hints / .best (per-player best, case-insensitive)
export function validateName(raw: string): { ok: true; name: string } | { ok: false; name: string; problem: 'empty'|'short'|'long'|'chars'; error: string }
export function normalizeName(raw: string): string; export function nameLength(s: string): number
export function compareScores(a: ScoreEntry, b: ScoreEntry): number; export function insertScore(list: readonly ScoreEntry[], e: ScoreEntry): { list: ScoreEntry[]; rank: number }
export function rankOf(list: readonly ScoreEntry[], e: ScoreEntry): number; export function bestFor(list: readonly ScoreEntry[], name: string): ScoreEntry | null
export function sanitizeSettings(v: unknown): Settings
export const STORAGE_PREFIX = 'labibRush.v1.', LEADERBOARD_KEEP = 50, LEADERBOARD_SHOW = 10, NAME_MIN = 2, NAME_MAX = 16

// src/ui/credits.ts
export const CREDITS: Credit[]; export const CREDIT_GROUPS; export const DISCLAIMER: string; export const PROCEDURAL_NOTE: string
export interface Credit { group: 'Sky & textures'|'3D models'|'Audio'|'Fonts'|'Code'; what: string; author: string; license: string; url: string }

// src/ui/dom.ts (internal helper, exported for the UI files)
export function timed(e: HTMLElement, onHide?: () => void): { show(ms): void; hide(): void; pause(): void; resume(): void; readonly active: boolean }

// Window event for audio: 'ui:click' CustomEvent<{ kind: 'click'|'hover'|'back' }> (credit links now fire it too)

### Integration
**Setup in main.ts**
- `const ui = createUI(document.getElementById('app')!, handlers)`. The loading screen shows at once. Feed it `ui.setLoading(p, label)` from `assets.onProgress`, then call `ui.finishLoading()`: it fades loading out and shows name entry on a first visit, otherwise the main menu.
- At start, apply `ui.getSettings()` to input, cameraRig, audio and engine, calling `engine.setQuality` unless the setting is 'auto'. After that, `handlers.onSettingsChange(s)` fires on every change.
- Call `ui.setProjector(createProjector(engine.camera))` once. The projector assumes a full-window canvas.

**Handlers**
The UI shows and hides its own menus, then calls the handler.
- **onPlay** (menu Play, or game-over Play again by click, Enter or R): reset the run, then call `ui.enterGame()`. That hides the menus, shows the HUD, and shows the controls card on the first play only. Repeat Play presses are ignored for 2 s or until `enterGame()`.
- **onPause** (touch pause button, or a phone turned upright mid-run): pause the game and call `ui.showPause()`.
- **onResume** (Resume button or Esc): the menu is already hidden; unpause and re-enable input. The UI stops that Esc from reaching input.ts.
- **onRestart**: reset the run and call `ui.enterGame()`.
- **onQuitToMenu**: the menu is already shown; stop the run and switch the camera to menu mode.
- Esc or P during play and tab blur come from input.ts `pausePressed` or main's visibility handler: main calls `ui.showPause()`, which only works while `isInGame()`. `ui.hidePause()` exists for resuming from code.
- Wire `handlers.onUserGesture` to `audio.unlock()`. Audio should listen for the window 'ui:click' event and map `e.detail.kind` to uiClick, uiHover or uiBack.

**Each frame**
- Call `ui.updateHud(hudState(run))`, except while paused.
- Call `ui.setBinPointer(nearestBinWorldPos | null)` with a point about 1.5 m above the bin. The arrow only shows when that point is off-screen.
- `tick(run, dt)` returns a reused array: handle its events before the next tick, and don't keep a reference to it.

**Events (route to both UI and audio)**
- **pickup:** `floatText('+' + r.points, pos, kind === 'golden' ? 'gold' : 'points')`, and if `r.callout` is set, `callout(r.callout, 'combo')`. For a re-picked spilled item, call `pickup(run, kind, true)`: points are 0, so skip the float text.
- **deposit:** `floatText('+' + d.points, …)` and `floatText('+' + d.timeAdded.toFixed(1) + ' s', pos, 'time')`, plus `d.callout` if set.
- **trickShot:** `callout('GOOOAL!', 'good')`.
- **caught:** `callout('Caught!', 'good')`.
- **hit:** `floatText('-' + spilled.length, pos, 'bad')`, optionally `callout('Aïe!', 'bad')`. Scatter `spilled`, and flag those litter objects as respilled for their next pickup.
- **Power-ups:** mashmoum shows `floatText('+10 s', pos, 'time')`.
- **tick events:** timeWarning → audio 'tick' (the HUD already pulses the timer); comboBreak → audio; powerupEnd → avatar visual off and audio; difficulty → spawners; runOver → end the run.

**First-run hints**
- Call `ui.showHint('pickup' | 'deposit' | 'kick' | 'radar' | 'litterbug')` at the right moments. Each shows once per browser, and repeat calls are harmless. 'move' is covered by the first-play controls card.
- Hints and the card freeze while any menu is over the run and come back on resume. `showHint` does nothing while a menu is open.

**End of run**
- Call `ui.showGameOver(result(run))`. It saves `{name: ui.getPlayerName(), …}` and shows the count-up, rank, badges ('NEW BEST!' uses the new per-name best key) and the leaderboard, then marks the UI as not in game.
- Main should disable input and keep rendering the scene behind. Play again goes straight to onPlay.

**Rules module and layers**
- Pickups score at pickup (value × combo × chéchia); the deposit pays only the items² × 5 bonus (× chéchia) plus time.
- The magnet (bambalouni) and radar are gameplay's job: use `magnetActive(run)`, `useRadar(run)` and `radarActive(run)` for the avatar glow and highlight.
- Layers: HUD z-index 30, menus 50, rotate overlay 90 (phones only), loading 100. Classes are prefixed `ui-`.

**Dev page**
- `/dev/ui.html?screen=loading|name|menu|leaderboard|settings|howto|credits|hud|pause|gameover`.
- Options: `&mobile=1`, `&fresh=1` (HUD exactly as a new run starts), `&rank=out|first`, `&empty=1`, `&keep=1`, `&controls=1`, `&t=8`, `&bg=/shots/x.png` (a real scene behind the UI). `window.__ui` exposes the controller.
- Fake data lives only under the 'labibRush.dev.' prefix, which is cleared on each load.

### Perf
The UI is plain DOM with no WebGL, so it adds 0 draw calls and 0 triangles ([stats] calls 0, triangles 0 on every shot).

- **Per-frame cost:** tick() plus updateHud(hudState(run)), measured in the browser over 20,000 iterations that included pickups, deposits, score count-up and pop animations: 0.041 ms per frame.
- **Allocation:** tick() now allocates nothing per step (it reuses run.events). hudState() allocates nothing. Checking for reduced motion no longer creates a new media query per animation.
- **Frame rate:** 60 fps on the HUD at 1600x900, 667x375 and 844x390 touch, and 768x1024. Lower readings (26–50 on pause and game over, 7 at 4K) came from headless compositing of blurred or 3840-wide frames while other agents' browsers were running.
- **Blur:** on touch, pause and game over no longer blur the whole screen over the live canvas; only the panels are blurred. The HUD still blurs only three small panels.

### Known issues
- The respilled-pickup fix depends on the gameplay session: litter scattered by hit() must be picked up with pickup(run, kind, true). If gameplay forgets the flag, a hit pays its items back again. I chose this over paying item value at the bin (the reviewer's option a) because the spec's floating '+50' at pickup and the live score count-up need points to land when litter is grabbed.
- A first-run hint is marked seen when it appears. Pausing now freezes and restores it, but if the run restarts or ends while a hint is showing, that hint does not come back.
- On touch, pause and game over use a stronger tint instead of a full-screen blur (for phone performance), so the HUD stays visible, dimmed, behind the pause panel. Desktop keeps the blur.
- The touch/desktop switch follows core/input.ts: pen counts as touch, and W/A/S/D or the arrow keys only switch back to desktop during play, not in menus (where the arrow keys move between buttons).
- Players are matched by name case-insensitively after cleanup, both for the personal best and for the new labibRush.v1.best key. Saved leaderboard rows stay separate.
- During play, a phone held upright (600 px wide or less) shows the rotate overlay above everything, including the pause menu. The UI asks main for a pause when the phone turns upright; the player rotates back and taps Resume. Tablets are not blocked.
- UIController has no dispose(). The UI is meant to live for the whole page: it adds global keydown and pointer listeners plus one orientation listener, and never removes them.
- CREDITS in src/ui/credits.ts has to be kept in sync by hand with docs/credits/*.md. The 'Audio' group is hidden because the juice module ships no audio files.

### Contract changes requested


## juice

### API
src/fx/fx.ts:
  export interface FxSystem extends Fx {
    clear(): void;              // instantly removes every live particle (run restart)
    setQuality(q: Quality): void; // default burst counts follow Engine quality changes
  }
  export function createFx(ctx: BuildContext): FxSystem   // implements the Fx contract exactly (a superset)
src/fx/material.ts (internal):
  export type PoolKind = 'glow' | 'soft' | 'solid'
  export interface ParticleUniforms { uTime; uAtlas; uSunDir; uSun; uSky }   // uWind removed
  export function createParticleMaterial(kind: PoolKind, shared: ParticleUniforms): ShaderMaterial
src/fx/atlas.ts (internal): export const SHAPE, ATLAS_COLS, ATLAS_ROWS; export function createAtlas(): DataTexture
src/audio/audio.ts:
  export function createAudio(): AudioEngine   // unchanged contract
  export function triggerSfx(mix: Mixer, name: SfxName, t: number, pitch?: number, volume?: number, dest?: AudioNode): void
src/audio/mixer.ts: export interface Mixer {...}; export function createMixer(ctx: BaseAudioContext): Mixer
src/audio/music.ts: export class Music; export const BPM = 118, STEP
src/audio/ambience.ts: export class Ambience
src/audio/sfx.ts: export const SFX, WET, LEVEL, MIN_GAP

### Integration
AUDIO: unchanged from the previous report.
- Call `audio.unlock()` in onUserGesture. The click in that same gesture now plays its UI sound.
- Also, as before: setSettings, setMenuMusic, start/stopMusic, startAmbience, setMusicIntensity every frame, setPaused, setListener every frame, and the event→SFX mapping.
- The footstep level was raised 3.5 dB. Keep `play('footstep', { volume: sprint ? 1 : 0.7 })`.

FX SETUP
- `const fx = createFx(buildCtx)`. Its type is FxSystem.
- `scene.add(fx.root)` directly under the scene.
- Every played frame: `fx.update(dt, camera.position)`.
- On run restart or quit to menu: `fx.clear()`.
- After Engine.setQuality or autoDetectQuality: `fx.setQuality(engine.quality)`.
- Teardown: `fx.dispose()`.
- Wind: just keep updating ctx.uniforms.uWind. Each particle takes the wind at its birth, so later changes never move particles that are already flying or resting.
- An explicit opts.count is used as is and is NOT quality-scaled. Omit it to get quality-scaled defaults.

SUGGESTED BURSTS
- pickup:
  - `fx.burst(kind === 'golden' ? 'goldSparkle' : 'sparkle', itemPos, { scale: 1 + 0.04 * Math.min(chain - 1, 10) })`;
  - use the default gold colour, since the stars must stay saturated.
- caught: `burst('sparkle', litterbugFeet, { scale: 1.3 })`, default colour.
- deposit: `burst('deposit', binBasePosition, { scale: 0.9 + 0.035 * items })`.
  - Pass the bin base; the swirl targets the rim 1.045 m above it.
  - The gulp happens 0.5 s later, a good moment for bin.bump() and the timeAdded sound.
- trickShot: confetti plus sparkle at the bin. newBest: confetti at the player.
- hit:
  - `burst('hit', playerFeetAtImpact)` plus `burst('spill', playerFeet, { direction: knockbackDir })`;
  - dizzy stars come from the avatar once the labib module adds them.
- footstep dust: walking `burst('dust', feet, { count: 2, scale: 0.6, direction: velDir })`, sprinting `{ count: 3, scale: 0.8, direction: velDir }`.
- land: `burst('dust', feet, { count: 8, scale: Math.min(1.6, 0.6 + impact / 8) })`.
- powerup: `burst('powerup', itemBase, { color })`. Colours: tea 0x7dffc8, bambalouni 0xffb84d, mashmoum 0xfff6e0, chechia 0xff3b3b.
- Mint tea active: `burst('speedLines', playerFeet, { direction: horizontalVelocity })` about 30 times per second.
- leaves: an occasional burst at a canopy point near the camera.

DEV TOOLS
- dev/fx.html now defaults to the engine view. URL params: kind, freeze, period, stress, disposeTest, and new ones:
  - `engine=0` (harness view);
  - `shade=<x>` (canopy slab shading x < value);
  - `windStep=1` (wind jumps after 2 s);
  - `count` / `scale` (burst options).
- scripts/juice-fx.mjs takes `--view=gc|backlit`, `--extra=&param=…` and `--tag=`.

### Perf
FX, engine at 'high', 1600×900, headless Chromium on the shared iGPU. Other agents were loading the GPU, so absolute fps is low and noisy; the deltas are what matter.
- Measured back to back with the same camera:
  - no FX: 28 fps, 23 calls;
  - gameplay load (every kind every 0.5 s): 27 fps, 26 calls, 1615 triangles;
  - saturated stress (every kind every 50 ms, pools full at 1400/300/1300 = 3000 live): 25 fps, 26 calls, 6035 triangles.
- FX draw calls: at most 3, and 0 when idle, because empty pools are hidden.
- Triangles: at most 6000.
- New per-particle cost: one shadow-map texture fetch in the vertex shader for lit particles only (×4 vertices), plus one fog evaluation per fragment.
- CPU per frame is unchanged: one uniform write and the upload of dirty ring slots, with no allocations. clear() is O(1).
- GPU memory: 3000 × 136 B = 408 KB of instance data, plus the 512×256 atlas.
- Dispose test: geometries 12 → 12, textures 43 → 43.
- Audio: no downloads. The scheduler no longer allocates per step (layer targets are cached, the ambience kinds array is hoisted).

### Known issues
- Where I disagree with the critique: the dizzy stars were not re-anchored inside Fx at a predicted rest point. That point depends on gameplay's knockback strength and on colliders, so the prediction would drift. They are removed from burst('hit') and requested from the labib module instead (see contract_changes_requested). Until labib adds them, a hit shows only the impact flash, stars and dust.
- Particle shadows: one 2×2 hardware-PCF lookup at the particle centre, with no blending across cascade fade bands. A piece crossing a shadow edge switches in one step, which is fine at particle size. Only three's SunLight (the engine) is supported. Under the dev harness's DirectionalLight (?engine=0), particles are always sunlit.
- Lit-particle brightness (SUN_RADIANCE 2.2, SKY in fx.ts) is still tuned by eye to the engine's sun (7.5) and environment (0.85). In deep shade, dust takes an olive tint from the sky-only term. It is plausible, but retune SKY if the engine's IBL changes.
- The additive-glow fog factor is recovered by feeding a constant 1024 through the installed fog chunk. Its error is fogColour·f/1024, which is negligible, and it works with both three's chunk and the engine's height fog. With CULL_DIST 90 m the fog effect is at most about 10%.
- Star counts per burst are fixed (sparkle 5, goldSparkle 7, deposit 4, hit = n) and do not scale with quality. The soft pool's capacity of 300 covers normal play; under saturated stress its ring overwrites the oldest puffs and stars.
- BIN_RIM (1.045) is still a copy of props/bin.ts OPENING_Y, which props does not export.
- A custom opts.color on sparkle also colours its stars. A pale colour such as the previously suggested caught colour 0xfff0a0 gives weak stars on sand, so use the default gold (see integration_notes).
- Audio is still verified objectively only: levels, spectra, a hook-only render and a live smoke test. A human listening pass is recommended, especially for the formant crowd cheer, the 'uh-oh' voice and the new HOOK_A2 answer phrase.
- The click detector still flags intentional micro-transients: the litterThrown wrapper crinkle and the gameOver qanun pluck attacks. These were inspected at sample level in the first pass.
- Absolute fps numbers are depressed by other agents sharing the GPU during measurement. Idle was 18–28 fps at different moments. Use the idle, load and stress deltas.

### Contract changes requested
- labib module: in AvatarState 'stun', draw 3–4 small gold cartoon stars orbiting just above Labib's head, parented to the head bone so they travel with the knockback. They are no longer emitted by Fx.
- Optional: add `clear(): void` and `setQuality(q: Quality): void` to the Fx interface in src/core/types.ts. createFx already returns `FxSystem` (Fx plus these two), so main.ts can use them without any contract change.

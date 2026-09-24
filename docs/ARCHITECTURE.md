# Labib Rush — architecture & team rules

Game design spec: `/home/blackbox/labib-rush-prompt.md` (read it; it is the product brief).

## Stack
Vite 8 + TypeScript 7 (`tsc` is the native TS 7 compiler) + Three.js r186 (WebGL2) + `postprocessing` 6.39 +
`n8ao` 2 + `@dimforge/rapier3d-compat` 0.20. UI is plain HTML/CSS over the canvas. Tests: Vitest 5.
**Do not add dependencies.** If you truly need one, say so in your report instead of installing it.

## Conventions
- Units: meters, seconds, radians. Y up. The avenue runs along **X** (west −X, east +X); north −Z, south +Z.
- All map coordinates come from `src/core/layout.ts`. Tuning numbers from `src/core/config.ts`.
- Shared interfaces in `src/core/types.ts`. Implement them exactly. Need a change? Put it in your
  report under `contract_changes_requested` — do not edit shared files.
- Shared helpers you may import (don't edit): `src/core/physics.ts` (Rapier wrapper, collision
  groups `G`), `src/core/assets.ts` (cached loaders + progress), `src/core/events.ts` (Emitter),
  `src/core/config.ts` (`RULES`, `PLAYER`, `LIGHTING`, …), `src/core/fonts.ts` (`loadFonts()` — await before drawing canvas text; families `Cairo` and `"Baloo Bhaijaan 2"`, both with Arabic + Latin, already in `public/fonts/`).
- Road surface y = 0; sidewalks, promenade and plazas y = `CURB` (0.15).
- Static colliders: world builders call `ctx.physics.addBox/addCylinder/addTrimesh…` with group
  `G.STATIC` (walls, facades, kiosks, statues, trees) or `G.LOW_PROP` (benches, planters, café
  furniture, bollards — things the camera may pass through).
- Materials: PBR (`MeshStandardMaterial` / `MeshPhysicalMaterial`), reuse material instances,
  correct colour spaces (albedo sRGB, data maps linear). Textures via `ctx.assets.texture()`.
- Wind/time: `ctx.uniforms.uTime` / `uWind` (shared by trees, flags, flying bags) — hook them via
  `material.onBeforeCompile` or `ShaderMaterial` uniforms.
- Quality: `ctx.quality` ('low'|'medium'|'high'|'ultra') — scale density/texture size with it.
- Everything created must be disposable (`dispose()` frees geometries/materials/textures you own).

## Performance budget (whole game at "high", mid-range laptop iGPU ≈ Intel UHD 630)
- Target 60 fps. Draw calls: street ≤ 150, buildings ≤ 150, landmarks ≤ 80, everything else ≤ 120.
- Merge static geometry by material **per ~60 m chunk along X** (so frustum culling still works);
  `InstancedMesh` for repeated props; no per-frame allocations in hot loops.
- Shadows: only meaningful casters `castShadow = true`; ground/facades `receiveShadow`.
- Download budget (files in `public/`, compressed): street ≤ 12 MB, buildings ≤ 12 MB,
  landmarks ≤ 8 MB, labib ≤ 3 MB, props ≤ 4 MB, people ≤ 3 MB, fonts ≤ 0.6 MB, audio ≤ 3 MB.
  Prefer 1K textures (2K only for hero surfaces), JPG/WebP (`magick` is installed; `ffmpeg` too).

## Assets & licences
Only CC0, or CC-BY with attribution. Good sources: Poly Haven (`https://api.polyhaven.com` —
`/assets?t=textures`, `/files/<id>` gives direct download URLs), ambientCG, Quaternius, Kenney,
OpenGameArt (CC0 only). No ripped/copyrighted assets, no real brand logos.
Write every asset you add to **`docs/credits/<your-module>.md`** (name, author, licence, URL,
local path). Put files under `public/<kind>/<your-module>/…`.
Procedural geometry/textures (canvas, shaders) are welcome and need no credit.

## Previewing your work (you can SEE it)
A shared Vite dev server runs at **http://127.0.0.1:5180** (do not start another one).
- Make a preview page `dev/<module>.html` + `dev/<module>.ts` using `dev/harness.ts`
  (`createHarness()` gives renderer, scene with the game's HDRI sky + sun + shadows, orbit camera,
  a `BuildContext`, and `ready()`). URL params: `?cam=x,y,z&target=x,y,z&fov=50&q=high`.
- Screenshot: `node scripts/shot.mjs "http://127.0.0.1:5180/dev/<module>.html?cam=..&target=.." shots/<module>-<view>.png --ready --wait=1500`
  (prints console errors + `[stats] fps/calls/triangles`). Then **look at the PNG with the Read
  tool** and iterate until it genuinely looks good. Take several angles, incl. player eye level
  (~1.2 m) and a wide view. Headless Chromium uses the real Intel iGPU, so fps is meaningful.
- Run only one browser at a time and let the script exit (RAM is limited).

## Checking your code
- Typecheck just your files: `npx tsc --noEmit 2>&1 | grep -E "^(src/<your-dir>|dev/<module>)"`
  (other agents are editing other files at the same time — ignore their errors).
- Do not run `npm install`, `git commit`, `git checkout`, `git stash`, or anything that changes
  git state or files you don't own. Don't touch `src/main.ts` or `index.html`.

## File ownership (phase B)
| Module | Owns |
|---|---|
| core | `src/core/engine.ts`, `src/core/input.ts`, `src/player/controller.ts`, `src/player/cameraRig.ts`, `dev/core.*` |
| street | `src/world/street.ts`, `src/world/street/**`, `public/textures/street/**`, `dev/street.*` |
| buildings | `src/world/buildings.ts`, `src/world/buildings/**`, `public/textures/buildings/**`, `dev/buildings.*` |
| landmarks | `src/world/landmarks.ts`, `src/world/landmarks/**`, `public/textures/landmarks/**`, `dev/landmarks.*` |
| labib | `src/player/labib.ts`, `src/player/labib/**`, `public/models/labib/**`, `dev/labib.*` |
| props | `src/props/**`, `public/textures/props/**`, `public/models/props/**`, `dev/props.*` |
| people | `src/npc/people.ts`, `src/npc/people/**`, `public/textures/people/**`, `dev/people.*` |
| ui | `src/ui/**`, `src/gameplay/rules.ts`, `tests/**`, `dev/ui.*` (fonts are provided, read-only) |
| juice | `src/audio/**`, `src/fx/**`, `public/audio/**`, `dev/audio.*`, `dev/fx.*` |
Plus each module's `docs/credits/<module>.md`.

## Layering (DOM)
canvas z-index 0 · touch controls (`#touch`, core/input) 20 · HUD 30 · menus 50 · loading 100.
Touch controls occupy the bottom-left (joystick) and bottom-right (buttons) corners during play;
the HUD keeps those corners free. CSS classes are prefixed per module (`ui-`, `tc-`).

# UI module — credits

The UI module (screens, HUD, persistence, rules) ships **no third-party assets** (0 bytes in `public/`).

- Logo (fennec head), power-up / litter illustrations, line icons and the zellige star pattern are
  hand-authored inline SVG in `src/ui/icons.ts` (procedural, written for this project).
- Fonts "Cairo" and "Baloo Bhaijaan 2" (SIL OFL 1.1) are provided by the core module (see `core.md`).

## In-game Credits screen
`src/ui/credits.ts` exports `CREDITS`, rendered by the Credits screen, plus the fan-game disclaimer
("Unofficial fan game. Labib is the mascot of Tunisia's environmental campaign; not affiliated with
the Ministry."). It currently lists every third-party asset from `core.md`, `street.md`,
`buildings.md` and `landmarks.md` (Poly Haven HDRI + textures, Quaternius statue source models),
the two fonts, the code libraries (three.js MIT, postprocessing Zlib, N8AO ISC, Rapier
Apache-2.0, Draco decoder Apache-2.0, meshoptimizer decoder MIT) and Inigo Quilez's star distance
function (MIT, ported by the juice module). `labib.md`, `people.md`, `props.md` and `juice.md`
declare no third-party asset files (all procedural / synthesised), so they add no rows.
**Whenever a module adds an asset to its `docs/credits/<module>.md`, add a row to `CREDITS` too**
(audio goes in the `'Audio'` group, which is hidden while empty).

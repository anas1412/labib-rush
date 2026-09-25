# Landmarks — asset credits

All shipped assets are CC0 (public domain). Everything else in `src/world/landmarks/**` is
procedural (geometry, canvas-painted lettering, plaques, playbills, shop interiors, mosaic, clock
dials, lattice skin, flags, palm fronds, shrub and flower cards).

## Textures (`public/textures/landmarks/`)
Poly Haven, CC0 1.0 — https://polyhaven.com/license. 1K JPG maps (diffuse, OpenGL normal, ARM),
re-compressed; diffuse maps of the stone and plaster were desaturated/brightened so each material
can tint them (ochre, white, sand).

| Asset | Author | URL | Local files |
|---|---|---|---|
| Sandstone Blocks 08 | Rob Tuytel | https://polyhaven.com/a/sandstone_blocks_08 | `sandstone_blocks_08_{diff,nor,arm}.jpg` |
| Large Sandstone Blocks 01 | Rob Tuytel | https://polyhaven.com/a/large_sandstone_blocks_01 | `large_sandstone_blocks_01_{diff,nor,arm}.jpg` |
| Painted Plaster Wall | Amal Kumar | https://polyhaven.com/a/painted_plaster_wall | `painted_plaster_wall_{diff,nor,arm}.jpg` |
| Clay Roof Tiles 02 | Amal Kumar | https://polyhaven.com/a/clay_roof_tiles_02 | `clay_roof_tiles_02_{diff,nor,arm}.jpg` |
| Leafy Grass | Charlotte Baglioni | https://polyhaven.com/a/leafy_grass | `leafy_grass_{diff,nor,arm}.jpg` (512 px, hue-shifted greener) |

The forecourt slabs inside the landmark footprints reuse the **street module's plaza paving**
(`public/textures/street/plaza_*.webp`, credited in `docs/credits/street.md`) through the shared
asset cache, so the paving is continuous at the footprint edges; no extra files are shipped.

## Statue meshes (`public/models/landmarks/*.bin`)
Baked offline by `dev/landmarks.bake.mjs` (posed, CPU-skinned, deformed for bulk, Loop-subdivided
and joined with procedural drapery, skull-fitted turban, beard, chéchia, book, overcoat, saddle,
saddle cloth draped by ray casting, stirrups and reins; per-vertex cavity baked for the patina)
from these CC0 rigged models by Quaternius. `*_lod.bin` are the lighter far versions (THREE.LOD).

| Source model | Author | Licence | URL | Used for |
|---|---|---|---|---|
| Horse (animated) | Quaternius | CC0 1.0 | https://poly.pizza/m/qvTrSG9pZF | `equestrian*.bin` (Bourguiba's horse), `relief.bin` (Théâtre horses) |
| Man in Suit (animated) | Quaternius | CC0 1.0 | https://poly.pizza/m/mQnGoME1ez | `equestrian*.bin` (rider), `scholar*.bin` (Ibn Khaldoun head/hands), `angel.bin`, `relief.bin` (figures) |

The source GLBs are not shipped; re-bake with `node dev/landmarks.bake.mjs <dir-with-glbs>`
(`horse_brown.glb`, `man_suit.glb` downloaded from the URLs above).

## Reference photos (not shipped)
Proportions and details were checked against Wikimedia Commons photos of the Cathédrale
Saint-Vincent-de-Paul, Théâtre municipal de Tunis, Immeuble Le Colisée, the statues of Ibn
Khaldoun and Habib Bourguiba, the Clock Tower of Place du 14 Janvier and Bab el Bhar.

## Fonts
Lettering uses the shared self-hosted Cairo font (see `docs/credits/core.md`).

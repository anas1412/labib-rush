# Credits

> Unofficial fan game. Labib is the mascot of Tunisia's environmental campaign; not affiliated with the Ministry.

Labib (created in 1992 by Chedly Belkhamsa) belongs to Tunisia's environmental campaign. This game is
an unofficial fan interpretation.

Everything not listed below is procedural, made in code for this game: Labib, the people, props,
taxis, signs, trees, particles, music, sound effects and UI art. The per-module source notes live in
[`docs/credits/`](docs/credits/).

## Core (engine, sky, fonts)

| Asset | Author | Licence | URL | Local files |
|---|---|---|---|---|
| HDRI "Qwantani Late Afternoon (Pure Sky)" | Greg Zaal & Jarod Guest, Poly Haven | CC0 1.0 | https://polyhaven.com/a/qwantani_late_afternoon_puresky | `public/hdri/sky_1k.hdr`, `sky_2k.hdr` |
| Font "Cairo" | Mohamed Gaber & Accademia di Belle Arti di Urbino | SIL OFL 1.1 | https://fonts.google.com/specimen/Cairo | `public/fonts/cairo-*.woff2` |
| Font "Baloo Bhaijaan 2" | Ek Type | SIL OFL 1.1 | https://fonts.google.com/specimen/Baloo+Bhaijaan+2 | `public/fonts/baloo-bhaijaan-2-*.woff2` |

The colour-grade LUT, height fog and touch-control icons are procedural.

## Street

Poly Haven textures, 1K, re-encoded to WebP in `public/textures/street/`.

| Asset | Author | Licence | URL | Local files |
|---|---|---|---|---|
| Asphalt 04 | Sergej Majboroda (photo), Jenelle van Heerden (processing) | CC0 1.0 | https://polyhaven.com/a/asphalt_04 | `asphalt_*.webp` |
| Granite Tile 04 | Amal Kumar | CC0 1.0 | https://polyhaven.com/a/granite_tile_04 | `promenade_*.webp` |
| Rectangular Paving | Dimitrios Savva | CC0 1.0 | https://polyhaven.com/a/rectangular_paving | `sidewalk_*.webp` |
| Patterned Paving | Charlotte Baglioni | CC0 1.0 | https://polyhaven.com/a/patterned_paving | `plaza_*.webp` |
| Granite Tile | Charlotte Baglioni | CC0 1.0 | https://polyhaven.com/a/granite_tile | `granite_*.webp` |
| Japanese Camphor Bark | Charlotte Baglioni | CC0 1.0 | https://polyhaven.com/a/japanese_camphor_bark | `bark_*.webp` |
| Wood Table 001 | Dimitrios Savva (photo), Rico Cilliers (processing) | CC0 1.0 | https://polyhaven.com/a/wood_table_001 | `wood_*.webp` |

Ficus leaves, road paint, manholes, kiosks, café fabrics, flags and signs are procedural.

## Buildings

Poly Haven textures, 1K, repacked to WebP in `public/textures/buildings/`.

| Asset | Author | Licence | URL | Local files |
|---|---|---|---|---|
| Painted Plaster Wall | Amal Kumar | CC0 1.0 | https://polyhaven.com/a/painted_plaster_wall | `plaster_c.webp`, `plaster_n.webp` |
| White Stucco | Amal Kumar | CC0 1.0 | https://polyhaven.com/a/white_stucco | `stucco_c.webp`, `stucco_n.webp` |
| Sandstone Blocks 08 | Rob Tuytel | CC0 1.0 | https://polyhaven.com/a/sandstone_blocks_08 | `stone_c.webp`, `stone_n.webp` |
| Concrete Wall 008 | Charlotte Baglioni (photo), Dario Barresi (processing) | CC0 1.0 | https://polyhaven.com/a/concrete_wall_008 | `concrete_c.webp`, `concrete_n.webp` |
| Concrete Floor 02 | Rob Tuytel | CC0 1.0 | https://polyhaven.com/a/concrete_floor_02 | `roof_c.webp`, `roof_n.webp` |

Shutters, balconies, reliefs, shop signs and window interiors are procedural. Shop names are invented.

## Landmarks

Poly Haven textures, 1K JPG, in `public/textures/landmarks/`.

| Asset | Author | Licence | URL | Local files |
|---|---|---|---|---|
| Sandstone Blocks 08 | Rob Tuytel | CC0 1.0 | https://polyhaven.com/a/sandstone_blocks_08 | `sandstone_blocks_08_*.jpg` |
| Large Sandstone Blocks 01 | Rob Tuytel | CC0 1.0 | https://polyhaven.com/a/large_sandstone_blocks_01 | `large_sandstone_blocks_01_*.jpg` |
| Painted Plaster Wall | Amal Kumar | CC0 1.0 | https://polyhaven.com/a/painted_plaster_wall | `painted_plaster_wall_*.jpg` |
| Clay Roof Tiles 02 | Amal Kumar | CC0 1.0 | https://polyhaven.com/a/clay_roof_tiles_02 | `clay_roof_tiles_02_*.jpg` |
| Leafy Grass | Charlotte Baglioni | CC0 1.0 | https://polyhaven.com/a/leafy_grass | `leafy_grass_*.jpg` |

Statue meshes (`public/models/landmarks/*.bin`) were baked offline by `dev/landmarks.bake.mjs` from:

| Source model | Author | Licence | URL | Used for |
|---|---|---|---|---|
| Horse (animated) | Quaternius | CC0 1.0 | https://poly.pizza/m/qvTrSG9pZF | Bourguiba's horse, Théâtre reliefs |
| Man in Suit (animated) | Quaternius | CC0 1.0 | https://poly.pizza/m/mQnGoME1ez | Rider, Ibn Khaldoun, angel, reliefs |

## Labib, people, props, NPCs, UI

No third-party asset files. Labib, pedestrians, litter, bins, power-ups, taxis, birds, the UI logo,
icons and zellige pattern are generated in code. Labib's look was matched against public photos of
his statues (reference only, nothing shipped). Brand names on props are invented.

## Audio and FX (juice)

No audio files: every sound effect, the city ambience and the music (an original composition,
D Hijaz, 118 BPM, darbouka rhythms maqsum / saidi / malfuf) are synthesised with the Web Audio API.

| Code | Author | Licence | URL |
|---|---|---|---|
| 2D star distance function (sparkle particles, ported in `src/fx/atlas.ts`) | Inigo Quilez | MIT | https://iquilezles.org/articles/distfunctions2d/ |

## Libraries

| Library | Author | Licence | URL |
|---|---|---|---|
| three.js | mrdoob & contributors | MIT | https://threejs.org/ |
| postprocessing | Raoul van Rüschen | Zlib | https://github.com/pmndrs/postprocessing |
| N8AO | N8python | ISC | https://github.com/N8python/n8ao |
| Rapier physics (rapier3d-compat) | Dimforge | Apache-2.0 | https://rapier.rs |
| Draco decoder | Google | Apache-2.0 | https://github.com/google/draco |
| meshoptimizer decoder | Arseny Kapoulkine | MIT | https://github.com/zeux/meshoptimizer |

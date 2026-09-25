# Street module — asset credits

All photographic textures are from **Poly Haven** (https://polyhaven.com), licensed **CC0 1.0**
(public domain, no attribution required — credited here anyway). Downloaded at 1K
(`diff`, `nor_gl`, `arm` JPG), colour-graded and re-encoded to WebP with ImageMagick, stored in
`public/textures/street/`.

| Local files | Poly Haven asset | Author(s) | Licence | URL |
|---|---|---|---|---|
| `asphalt_{diff,nor,arm}.webp` | Asphalt 04 | Sergej Majboroda (photo), Jenelle van Heerden (processing) | CC0 | https://polyhaven.com/a/asphalt_04 |
| `promenade_{diff,nor,arm}.webp` | Granite Tile 04 | Amal Kumar | CC0 | https://polyhaven.com/a/granite_tile_04 |
| `sidewalk_{diff,nor,arm}.webp` | Rectangular Paving | Dimitrios Savva | CC0 | https://polyhaven.com/a/rectangular_paving |
| `plaza_{diff,nor,arm}.webp` | Patterned Paving | Charlotte Baglioni | CC0 | https://polyhaven.com/a/patterned_paving |
| `granite_{diff,nor,arm}.webp` | Granite Tile | Charlotte Baglioni | CC0 | https://polyhaven.com/a/granite_tile |
| `bark_{diff,nor,arm}.webp` | Japanese Camphor Bark | Charlotte Baglioni | CC0 | https://polyhaven.com/a/japanese_camphor_bark |
| `wood_{diff,nor,arm}.webp` | Wood Table 001 | Dimitrios Savva (photo), Rico Cilliers (processing) | CC0 | https://polyhaven.com/a/wood_table_001 |

Total on disk: ~3.6 MB.

## Procedural (no credit needed)
Generated at runtime on canvases / in shaders (`src/world/street/canvas.ts`, `kiosks.ts`, `cafes.ts`):
ficus leaf atlas + dense-leaf tile + shadow sun-fleck mask, road-paint wear, cast-iron manhole /
drain / tree-grate textures, lake ripple normal map, the Tunisian flag, street-name plates,
pedestrian-crossing and "Travaux / أشغال" signs, the construction-fence privacy tarp
("TRAVAUX / أشغال — Chantier, accès interdit / ممنوع الدخول"), welded fence mesh, planter
flower strips, magazine covers, newspapers, kiosk fascias, snack menu and bags, café names,
parasol fabrics, marble, rattan and chair weave.
All names and titles are generic words — no real brands, businesses or publications.
Text uses the project fonts Cairo (SIL OFL 1.1), see `docs/credits/core.md`.

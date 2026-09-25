# Credits — people (pedestrians, café patrons, litterbugs)

No external assets. Everything in `src/npc/people*` is generated at load time:

- **Geometry** — procedural lofts/shells (`src/npc/people/body.ts`, `geometry.ts`, `head.ts`).
- **Detail atlas** — painted on 2D canvases at startup (`src/npc/people/atlas.ts`): faces, hair
  strands, garment seams/stitching/pockets/folds, derived normal map. No downloaded textures, so
  the module adds 0 bytes to `public/`.
- **Animation** — procedural (`src/npc/people/anim.ts`).

Clothing palettes and garment choices (jebba + chéchia, safsari, hijab, flat caps, suits, jeans,
leather jackets) are original, informed by general knowledge of downtown Tunis street style.

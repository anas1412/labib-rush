# Props module — credits

All props (litter, recycling bin, power-ups, taxis) are **fully procedural**: geometry is generated in
code (`src/props/*.ts`) and every texture is painted at load time on a `<canvas>`. No image, model or
sound files are shipped by this module (download size: 0 bytes).

| Asset | Source | Licence |
|---|---|---|
| All prop geometry, canvas textures and shaders | Written for Labib Rush (`src/props/**`) | Project code |
| Label / sign lettering (Cairo, Baloo Bhaijaan 2) | Self-hosted Google Fonts provided by the core module (`public/fonts/`) | SIL Open Font License 1.1 |

Brand names on the props are invented and generic: "Gazouz / قازوز" (the Tunisian word for soda),
"Nabaa / نبع" ("spring"), "Chips / شيبس", "Merci / شكرا". The recycling mark is a simplified
drawing of the public-domain three-arrow symbol. No real logos, plates or badges are used.

Dev-only: `dev/props.ts` borrows the street module's promenade paving textures for the showroom
floor (credited in `docs/credits/street.md`).

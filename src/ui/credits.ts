// Credits shown on the in-game Credits screen. Every third-party asset listed in docs/credits/*.md
// must also appear here (name, author, licence, URL). Procedural assets need no entry.
export type CreditGroup = 'Sky & textures' | '3D models' | 'Audio' | 'Fonts' | 'Code';

export interface Credit {
  group: CreditGroup;
  what: string;
  author: string;
  license: string;
  url: string;
}

/** Display order of the groups (empty groups are skipped). */
export const CREDIT_GROUPS: readonly CreditGroup[] = ['Sky & textures', '3D models', 'Audio', 'Fonts', 'Code'];

export const DISCLAIMER =
  "Unofficial fan game. Labib is the mascot of Tunisia's environmental campaign; not affiliated with the Ministry.";

/** Shown under the list: everything else in the game is made in code. */
export const PROCEDURAL_NOTE = 'Everything not listed here (Labib, the people, props, signs, trees, particles, music, sound effects and UI art) is procedural, made in code for this game.';

const PH = 'Poly Haven';
const ph = (id: string) => `https://polyhaven.com/a/${id}`;

export const CREDITS: Credit[] = [
  // sky (docs/credits/core.md) and textures (docs/credits/street.md, buildings.md, landmarks.md)
  { group: 'Sky & textures', what: 'HDRI “Qwantani Late Afternoon (Pure Sky)”', author: `Greg Zaal & Jarod Guest, ${PH}`, license: 'CC0', url: ph('qwantani_late_afternoon_puresky') },
  { group: 'Sky & textures', what: 'Asphalt 04', author: `Sergej Majboroda & Jenelle van Heerden, ${PH}`, license: 'CC0', url: ph('asphalt_04') },
  { group: 'Sky & textures', what: 'Granite Tile 04', author: `Amal Kumar, ${PH}`, license: 'CC0', url: ph('granite_tile_04') },
  { group: 'Sky & textures', what: 'Granite Tile', author: `Charlotte Baglioni, ${PH}`, license: 'CC0', url: ph('granite_tile') },
  { group: 'Sky & textures', what: 'Rectangular Paving', author: `Dimitrios Savva, ${PH}`, license: 'CC0', url: ph('rectangular_paving') },
  { group: 'Sky & textures', what: 'Patterned Paving', author: `Charlotte Baglioni, ${PH}`, license: 'CC0', url: ph('patterned_paving') },
  { group: 'Sky & textures', what: 'Japanese Camphor Bark', author: `Charlotte Baglioni, ${PH}`, license: 'CC0', url: ph('japanese_camphor_bark') },
  { group: 'Sky & textures', what: 'Wood Table 001', author: `Dimitrios Savva & Rico Cilliers, ${PH}`, license: 'CC0', url: ph('wood_table_001') },
  { group: 'Sky & textures', what: 'Painted Plaster Wall', author: `Amal Kumar, ${PH}`, license: 'CC0', url: ph('painted_plaster_wall') },
  { group: 'Sky & textures', what: 'White Stucco', author: `Amal Kumar, ${PH}`, license: 'CC0', url: ph('white_stucco') },
  { group: 'Sky & textures', what: 'Sandstone Blocks 08', author: `Rob Tuytel, ${PH}`, license: 'CC0', url: ph('sandstone_blocks_08') },
  { group: 'Sky & textures', what: 'Large Sandstone Blocks 01', author: `Rob Tuytel, ${PH}`, license: 'CC0', url: ph('large_sandstone_blocks_01') },
  { group: 'Sky & textures', what: 'Concrete Wall 008', author: `Charlotte Baglioni & Dario Barresi, ${PH}`, license: 'CC0', url: ph('concrete_wall_008') },
  { group: 'Sky & textures', what: 'Concrete Floor 02', author: `Rob Tuytel, ${PH}`, license: 'CC0', url: ph('concrete_floor_02') },
  { group: 'Sky & textures', what: 'Clay Roof Tiles 02', author: `Amal Kumar, ${PH}`, license: 'CC0', url: ph('clay_roof_tiles_02') },
  { group: 'Sky & textures', what: 'Leafy Grass', author: `Charlotte Baglioni, ${PH}`, license: 'CC0', url: ph('leafy_grass') },

  // models (docs/credits/landmarks.md: baked into the statues)
  { group: '3D models', what: 'Horse (animated), in the equestrian statue and theatre reliefs', author: 'Quaternius', license: 'CC0', url: 'https://poly.pizza/m/qvTrSG9pZF' },
  { group: '3D models', what: 'Man in Suit (animated), in the statues', author: 'Quaternius', license: 'CC0', url: 'https://poly.pizza/m/mQnGoME1ez' },

  // fonts (docs/credits/core.md)
  { group: 'Fonts', what: 'Cairo', author: 'Mohamed Gaber & Accademia di Belle Arti di Urbino', license: 'SIL OFL 1.1', url: 'https://fonts.google.com/specimen/Cairo' },
  { group: 'Fonts', what: 'Baloo Bhaijaan 2', author: 'Ek Type', license: 'SIL OFL 1.1', url: 'https://fonts.google.com/specimen/Baloo+Bhaijaan+2' },

  // libraries (package.json)
  { group: 'Code', what: 'three.js', author: 'mrdoob & contributors', license: 'MIT', url: 'https://threejs.org/' },
  { group: 'Code', what: 'postprocessing', author: 'Raoul van Rüschen', license: 'Zlib', url: 'https://github.com/pmndrs/postprocessing' },
  { group: 'Code', what: 'N8AO', author: 'N8python', license: 'ISC', url: 'https://github.com/N8python/n8ao' },
  { group: 'Code', what: 'Rapier physics', author: 'Dimforge', license: 'Apache-2.0', url: 'https://rapier.rs' },
  { group: 'Code', what: 'Draco decoder', author: 'Google', license: 'Apache-2.0', url: 'https://github.com/google/draco' },
  { group: 'Code', what: 'meshoptimizer decoder', author: 'Arseny Kapoulkine', license: 'MIT', url: 'https://github.com/zeux/meshoptimizer' },
  // docs/credits/juice.md: ported into src/fx/atlas.ts
  { group: 'Code', what: '2D star distance function (sparkle particles)', author: 'Inigo Quilez', license: 'MIT', url: 'https://iquilezles.org/articles/distfunctions2d/' },
];

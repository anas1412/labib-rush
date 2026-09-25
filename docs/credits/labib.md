# Credits — labib (player character)

**No third-party assets.** Labib's mesh, rig, textures and animation are generated procedurally at
load time by code in `src/player/labib/**`. Nothing under `public/` is used.

- Geometry: signed-distance sculpt meshed with Surface Nets (`sdf.ts`) plus parametric surfaces
  (ears, lids, brows, mouth line, trims, strap, eyes, nose, chéchia). SDF primitive formulas follow
  Inigo Quilez's public articles (iquilezles.org, distance functions); the code is written for this project.
- Textures: eye/nose atlas and chest emblem drawn on a canvas at runtime (`materials.ts`).
- Fur: shell texturing and sheen are shader code in `materials.ts`.

## Design references (looked at, not shipped)
Used only to match the classic look (blue one-piece suit, green belt, round chest emblem, white
gloves, satchel, sandy fur, huge ears, black nose, thick brows, grin):
- Statue of Labib, El Mourouj (Wikimedia Commons, "El Mourouj Montazah.JPG") — https://commons.wikimedia.org/wiki/Category:Statues_of_Labib
- "Statuette de Labib, entrée de Bennane, Tunisie 2021" (Wikimedia Commons, same category)
- Labib statues photo, Destination Tunis — https://destination-tunis.fr/informations-utiles/labib-mascotte-environnement/
- 2022 relaunch coverage incl. a mural of the classic Labib, Kapitalis — https://kapitalis.com/tunisie/2022/06/21/tunisie-le-ministere-de-lenvironnement-invite-les-citoyens-a-choisir-la-nouvelle-mascotte-labib/
- Cartoon still, Pros de la Com — https://prosdelacom.com/article/2339/actualites/labib-045900

Labib (created 1992 by Chedly Belkhamsa) is the mascot of Tunisia's environmental campaign. This is
an unofficial fan interpretation, not affiliated with the Ministry.

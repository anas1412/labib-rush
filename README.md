# Labib Rush

A 3D browser game on Avenue Habib Bourguiba, Tunis. You play Labib (لبيب), the fennec fox mascot of
Tunisia's anti-litter campaign, racing the clock to clean up the avenue at golden hour: grab litter,
chase plastic bags in the wind, kick cans into bins, catch litterbugs in the act and dodge the yellow
taxis. Runs last 1.5 to 5 minutes and restart instantly.

**Play it: https://labib-rush.vercel.app**

## How to play

### Controls

| Action | Desktop | Touch |
|---|---|---|
| Move | WASD or arrow keys (ZQSD on AZERTY, see Settings) | Left joystick |
| Look | Mouse (click to capture the pointer) | Drag on the right side |
| Sprint | Shift | Sprint button, or push the joystick to the edge |
| Jump | Space | Jump button |
| Kick | F or left click | Kick button |
| Ear radar | Q (E on AZERTY) | Radar button |
| Pause | Esc or P | Pause button |

On phones, play in landscape.

### Rules

- The timer starts at 90 s. Each item dropped in a bin adds 1.5 s. The run ends at 0.
- Litter: can 10, bottle 15, chips bag 20, flying plastic bag 50 (jump for it), golden bottle 200.
- Combo: pick up again within 3 s to climb from ×1 to ×2, ×3 and ×5.
- Your bag holds 8 items. Dropping them in a bin pays items² × 5, so full bags pay best.
- Trick shot: kick a can or bottle into a bin for "GOOOAL!" and double points.
- Litterbugs: a warning icon shows over a pedestrian about to throw. Touch them within 3 s of the
  throw for "Caught!" and +100.
- Taxis honk before they reach you. A hit knocks you back, stuns you for 1 s, spills half the bag
  and breaks the combo. Spilled items can be picked up again.
- Ear radar highlights nearby litter through walls for 2 s (8 s cooldown).
- Every 30 s there is more litter, more litterbugs, more wind and more traffic.
- An arrow at the screen edge points to the nearest bin.

### Power-ups

| Power-up | Effect |
|---|---|
| Mint tea | +40% speed for 8 s |
| Bambalouni | Pulls nearby litter in like a magnet for 8 s |
| Mashmoum (jasmine) | +10 s on the timer |
| Chéchia | ×2 score for 10 s |

Your name, scores (top 50 kept, top 10 shown) and settings are stored in the browser only.

## Tech stack

- Vite, TypeScript, Three.js (WebGL2)
- `postprocessing` and N8AO (SSAO, bloom, SMAA, LUT grading)
- Rapier (`@dimforge/rapier3d-compat`) for physics and the character controller
- Plain HTML/CSS UI, Web Audio synthesis for all sound and music
- Vitest for the game rules, leaderboard and name validation

## Local development

```sh
npm i
npm run dev      # dev server
npm test         # unit tests
npm run build    # typecheck + production build in dist/
```

## Credits

All third-party assets are CC0 or open licences. See [CREDITS.md](CREDITS.md).

Unofficial fan game. Labib is the mascot of Tunisia's environmental campaign; not affiliated with the Ministry.

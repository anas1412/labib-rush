// Props module entry: gameplay models (litter, bins, power-ups, taxis). Everything is procedural
// (canvas textures + generated geometry), built once here; factory calls only create Object3Ds
// that share geometry and materials, so they allocate no GPU resources. dispose() frees every GPU
// resource the module created.
import type { BuildContext, LitterKind, PropFactory } from '../core/types';
import { loadFonts } from '../core/fonts';
import { createBins } from './bin';
import { createLitter, type LitterShape } from './litter';
import { createPowerups } from './powerups';
import { createTaxis } from './taxi';
import { Trash } from './util';

export type { LitterShape } from './litter';

/** PropFactory + the litter collider shapes (requested as a contract addition). */
export interface Props extends PropFactory {
  litterShape(kind: LitterKind): LitterShape;
}

/** Lets the loading screen repaint between the (synchronous, ~0.2–0.8 s) build steps. */
const yieldToBrowser = () => new Promise<void>((r) => setTimeout(r, 0));

export async function createProps(ctx: BuildContext): Promise<Props> {
  await loadFonts(); // canvas labels (Arabic + Latin) need the real fonts
  const trash = new Trash();
  const { renderer, quality, uniforms } = ctx;
  const litter = createLitter(renderer, quality, uniforms, trash);
  await yieldToBrowser();
  const bins = createBins(renderer, quality, uniforms, trash);
  await yieldToBrowser();
  const powerups = createPowerups(renderer, quality, trash);
  await yieldToBrowser();
  const taxis = createTaxis(renderer, quality, trash);
  return {
    litter: (kind) => litter.make(kind),
    litterRadius: (kind) => litter.shape(kind).radius,
    litterShape: (kind) => litter.shape(kind),
    bin: () => bins.make(),
    powerup: (kind) => powerups.make(kind),
    taxi: (variant = 0) => taxis.make(variant),
    dispose: () => trash.dispose(),
  };
}

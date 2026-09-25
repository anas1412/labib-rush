// Builds Labib's body off the main thread (pure math, no DOM); posts transferable typed arrays back.
import { buildBody } from './body';
import { buffersOf } from './builder';
import type { Quality } from '../../core/types';

self.onmessage = (e: MessageEvent<{ quality: Quality }>) => {
  (self as unknown as Worker).postMessage({ alive: true }); // heartbeat: the build is running (it can take seconds)
  const data = buildBody(e.data.quality);
  const sets = data.far ? [data.near, data.far] : [data.near];
  const transfer = [...sets.flatMap((s) => [s.fur, s.cloth, s.gloss]), ...(data.shell ? [data.shell] : [])].flatMap(buffersOf);
  (self as unknown as Worker).postMessage(data, transfer);
};

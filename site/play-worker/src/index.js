// play.drkreddy.com — public, hardened experiment surface.
//
// Wiring only. Security lives in core.js; each lab is data. Adding a second lab
// means importing it and adding it to this array — no change to the allowlist,
// the clamps, or the CORS policy.

import { buildRegistry, handle } from './core.js';
import cdn from './labs/cdn.js';

const registry = buildRegistry([cdn]);

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx, registry),

  // Keeps the Render free instance awake. Without it the first live visitor
  // after an idle spell waits ~22s for a cold start and concludes the CDN is
  // broken. /health is excluded from the origin's counters, so this cannot
  // pollute the numbers the experiments report.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetch(new URL('/health', env.ORIGIN_BASE).toString(), {
      cf: { cacheTtl: 0 },
    }).catch(() => {}));
  },
};

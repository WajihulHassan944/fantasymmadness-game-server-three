'use strict';
// Read-only, anonymous status probe of the production Growth Engine (GET only, no credentials).
const BASE = 'https://fantasymmadness-growth-isolated-tes.vercel.app';
const paths = ['/api/growth/health', '/api/growth/production/health', '/api/growth/preparation/health'];
(async () => {
  for (const p of paths) {
    try {
      const r = await fetch(BASE + p, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
      const t = await r.text();
      console.log(`=== GET ${p} -> ${r.status} at ${new Date().toISOString()}`);
      console.log(t.slice(0, 60000));
    } catch (e) { console.log(`=== GET ${p} -> error ${e.message}`); }
  }
})();

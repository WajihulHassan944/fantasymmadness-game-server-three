'use strict';
// Inside the isolated Growth Engine project ONLY (prj_Hpe9UjGrBBJOm3boxHsL9lHesWLl),
// the legacy game server must not be reachable: the project is publicly reachable so
// the website admin can embed the Growth Engine console, and it points at the isolated
// test database. Only /api/growth/* is served; every other path (legacy pages, legacy
// crons, sign-up, payments, uploads) answers 404 before any legacy middleware runs.
// The production backend never loads this gate (different project ID).
const ALLOWED = /^\/api\/growth(\/|$)/;
function isolatedGate(req, res, next) {
  const path = String(req.path || req.url || '/').split('?')[0];
  if (ALLOWED.test(path)) return next();
  res.status(404).set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).json({ ok: false, error: 'not_found', service: 'growth-engine-isolated', note: 'Only /api/growth is served by the isolated Growth Engine.' });
}
module.exports = { isolatedGate, ALLOWED };

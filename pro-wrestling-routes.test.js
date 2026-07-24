'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, 'server.js');
const legacyManifestPath = path.join(__dirname, 'legacy-route-manifest.json');
const source = fs.readFileSync(serverPath, 'utf8');
const legacyRoutes = JSON.parse(fs.readFileSync(legacyManifestPath, 'utf8'));

const extractRoutes = (text) => {
  const routes = [];
  const regex = /app\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = regex.exec(text)) !== null) routes.push(`${match[1].toUpperCase()} ${match[2]}`);
  return routes;
};

const currentRoutes = extractRoutes(source);
const originalRoutes = legacyRoutes;
const currentCounts = currentRoutes.reduce((map, route) => map.set(route, (map.get(route) || 0) + 1), new Map());
const originalCounts = originalRoutes.reduce((map, route) => map.set(route, (map.get(route) || 0) + 1), new Map());

for (const [route, count] of originalCounts.entries()) {
  assert(
    (currentCounts.get(route) || 0) >= count,
    `Existing route was removed or reduced: ${route}`,
  );
}

const requiredRoutes = [
  'GET /api/wrestling/health',
  'GET /api/wrestling/config',
  'GET /api/wrestling/wrestlers',
  'GET /api/wrestling/wrestlers/:idOrSlug',
  'GET /api/wrestling/matches',
  'GET /api/wrestling/matches/:matchId',
  'POST /api/wrestling/matches/:matchId/join',
  'GET /api/wrestling/matches/:matchId/my-entry',
  'POST /api/wrestling/matches/:matchId/prediction',
  'PUT /api/wrestling/matches/:matchId/prediction',
  'GET /api/wrestling/matches/:matchId/live',
  'GET /api/wrestling/matches/:matchId/leaderboard',
  'GET /api/wrestling/matches/:matchId/results',
  'GET /api/users/me/wrestling-history',
  'GET /api/users/me/wrestling-wallet-ledger',
  'GET /api/users/me/wrestling-notifications',
  'GET /api/admin/wrestling/wrestlers',
  'POST /api/admin/wrestling/wrestlers',
  'POST /api/admin/wrestling/matches',
  'PUT /api/admin/wrestling/matches/:id/status',
  'POST /api/admin/wrestling/matches/:id/start',
  'PUT /api/admin/wrestling/matches/:id/live-stats',
  'PUT /api/admin/wrestling/matches/:id/result',
  'POST /api/admin/wrestling/matches/:id/recalculate',
  'POST /api/admin/wrestling/matches/:id/finalize',
  'POST /api/admin/wrestling/matches/:id/cancel',
  'POST /api/admin/wrestling/matches/:id/refund',
  'GET /api/admin/wrestling/matches/:id/entries',
  'GET /api/admin/wrestling/matches/:id/predictions',
  'PUT /api/admin/wrestling/matches/:id/predictions/:userId',
  'GET /api/admin/wrestling/analytics',
  'GET /api/admin/wrestling/audit-logs',
  'GET /api/admin/wrestling/wallet-ledger',
  'POST /api/admin/wrestling/wallet-adjustment',
  'POST /api/admin/wrestling/migrate-existing-matches',
  'GET /api/admin/wrestling/system-check',
  'GET /api/affiliates/me/wrestling-summary',
  'GET /api/wrestling/cron/process',
];

for (const route of requiredRoutes) {
  assert(currentCounts.has(route), `Required Pro Wrestling route is missing: ${route}`);
}

const wrestlingRoutes = currentRoutes.filter((route) => route.includes('/wrestling'));
const duplicates = wrestlingRoutes.filter((route, index) => wrestlingRoutes.indexOf(route) !== index);
assert.deepStrictEqual(duplicates, [], `Duplicate Pro Wrestling route declarations found: ${duplicates.join(', ')}`);


const declarationFor = (method, route) => {
  const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`app\\.${method.toLowerCase()}\\(\\s*['"]${escapedRoute}['"][^\\n]*`);
  return source.match(regex)?.[0] || '';
};

for (const route of requiredRoutes.filter((item) => item.includes('/api/admin/wrestling/'))) {
  const [method, pathValue] = route.split(' ');
  assert(
    declarationFor(method, pathValue).includes('verifyAdminToken'),
    `Admin route is not protected by verifyAdminToken: ${route}`,
  );
}

for (const route of [
  'POST /api/wrestling/matches/:matchId/join',
  'GET /api/wrestling/matches/:matchId/my-entry',
  'POST /api/wrestling/matches/:matchId/prediction',
  'PUT /api/wrestling/matches/:matchId/prediction',
  'GET /api/users/me/wrestling-history',
  'GET /api/users/me/wrestling-wallet-ledger',
  'GET /api/users/me/wrestling-notifications',
]) {
  const [method, pathValue] = route.split(' ');
  assert(declarationFor(method, pathValue).includes('verifyToken'), `Player route is not protected: ${route}`);
}

assert(
  declarationFor('GET', '/api/wrestling/cron/process').includes('verifyWrestlingCronOrAdmin'),
  'Wrestling maintenance endpoint is not protected by cron/admin authentication.',
);

assert.strictEqual((source.match(/\/\/ PRO WRESTLING GAME MODE/g) || []).length, 1, 'Pro Wrestling implementation block must appear exactly once.');
assert(source.includes("predictionStatus: 'SUBMITTED'"), 'Submitted predictions must be explicitly locked.');
assert(!source.includes("predictionStatus: { $in: ['DRAFT', 'SUBMITTED'] }"), 'Draft predictions must not become score-eligible at lock time.');
assert(source.includes('runWrestlingTransaction'), 'Transactional wallet/settlement helper is missing.');
assert(source.includes("type: 'WRESTLING_ADMIN_ADJUSTMENT'"), 'Audited wrestling wallet adjustment is missing.');
assert(source.includes("gameMode: String"), 'Legacy Match game-mode metadata is missing.');

assert(source.includes('matchTimeRangePrediction'), 'Wrestling time-range prediction field is missing.');
assert(source.includes('officialMatchDurationSeconds'), 'Official wrestling match duration field is missing.');
assert(source.includes('LIVE / PROVISIONAL STANDINGS'), 'Provisional standings label is missing.');
assert(source.includes('provisionalTimeRangePoints'), 'Live provisional time-range scoring is missing.');

console.log(`Pro Wrestling route/regression tests passed (${wrestlingRoutes.length} wrestling endpoints; ${originalRoutes.length} legacy routes preserved).`);

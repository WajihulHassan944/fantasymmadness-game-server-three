'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { registerFightDataQualityRoutes, _private } = require('./fight-data-quality');

assert.strictEqual(typeof registerFightDataQualityRoutes, 'function');
assert.strictEqual(_private.DEFAULT_SCORING_CONFIG.points.KO, 500);
assert.strictEqual(_private.DEFAULT_SCORING_CONFIG.points.SP, 25);
assert.strictEqual(_private.DEFAULT_SCORING_CONFIG.points.RW, 100);
assert.strictEqual(_private.DEFAULT_SCORING_CONFIG.points.RL, 25);
assert.strictEqual(_private.normalizeName(' Gervonta  Davis!! '), 'gervonta davis');

const duplicateGroups = _private.groupDuplicateMatches([
  {
    _id: '1',
    matchCategory: 'boxing',
    matchCategoryTwo: '',
    matchName: 'PBC',
    matchFighterA: 'Gervonta Davis',
    matchFighterB: 'Lamont Roach',
    matchType: 'SHADOW',
    maxRounds: 12,
    matchStatus: 'Finished',
    fighterAImage: 'https://example.com/a.jpg',
    updatedAt: '2026-01-01T00:00:00.000Z',
    BoxingMatch: { fighterOneStats: [{ roundNumber: 1 }], fighterTwoStats: [] },
  },
  {
    _id: '2',
    matchCategory: 'boxing',
    matchCategoryTwo: '',
    matchName: 'PBC duplicate',
    matchFighterA: 'LAMONT ROACH',
    matchFighterB: 'GERVONTA DAVIS',
    matchType: 'LIVE',
    maxRounds: 12,
    matchStatus: 'Ongoing',
    fighterAImage: 'https://example.com/b.jpg',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
]);
assert.strictEqual(duplicateGroups.length, 1);
assert.strictEqual(duplicateGroups[0].count, 2);
assert.strictEqual(duplicateGroups[0].preserveSuggestion, '2');

const suggestions = _private.buildFighterSuggestions([
  { _id: '1', matchCategory: 'boxing', matchFighterA: 'Gervonta Davis', fighterAImage: 'https://img/a.jpg', matchFighterB: 'Ryan Garcia', fighterBImage: 'https://img/b.jpg' },
  { _id: '2', matchCategory: 'boxing', matchFighterA: 'Gervonta Davis', fighterAImage: 'https://img/a.jpg', matchFighterB: 'Lamont Roach', fighterBImage: 'https://img/c.jpg' },
]);
const gervonta = suggestions.find((item) => item.normalizedName === 'gervonta davis');
assert(gervonta, 'Gervonta suggestion should exist');
assert.strictEqual(gervonta.matchCount, 2);
assert.strictEqual(gervonta.primaryImageCandidate, 'https://img/a.jpg');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
assert(serverSource.includes("require('./fight-data-quality')"), 'server.js must load fight-data-quality routes.');
assert(serverSource.includes('fighterAId: { type: mongoose.Schema.Types.ObjectId'), 'Match schema must include fighterAId.');
assert(serverSource.includes('registerFightDataQualityRoutes({'), 'server.js must register fight data-quality routes.');

const routeSource = fs.readFileSync(path.join(__dirname, 'fight-data-quality.js'), 'utf8');
for (const route of [
  '/api/scoring-config',
  '/api/admin/fights/scoring-config',
  '/api/admin/fights/data-quality/duplicates',
  '/api/admin/fights/data-quality/duplicates/delete',
  '/api/admin/fights/data-quality/image-health',
  '/api/combat-fighters',
  '/api/admin/combat-fighters',
  '/api/admin/combat-fighters/suggest-from-matches',
  '/api/admin/fights/:matchId/link-fighters',
]) {
  assert(routeSource.includes(route), `Missing route: ${route}`);
}

console.log('Fight data-quality backend tests passed.');

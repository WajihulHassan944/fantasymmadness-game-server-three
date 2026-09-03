'use strict';

const assert = require('assert');
const { _test } = require('./seo-performance-phase2');

assert.strictEqual(_test.safePage('2'), 2);
assert.strictEqual(_test.safePage('-1'), 1);
assert.strictEqual(_test.safeLimit('500', 20), 100);
assert.strictEqual(_test.slugify('Fantasy Boxing: Fight Night!'), 'fantasy-boxing-fight-night');
assert.deepStrictEqual(_test.normalizeStringArray('mma, boxing, pro wrestling'), ['mma', 'boxing', 'pro wrestling']);
const fallback = _test.fallbackMetadata({ path: '/fantasy-boxing', siteUrl: 'https://example.com' });
assert.ok(fallback.title.includes('Fantasy Boxing'));
assert.strictEqual(fallback.canonicalUrl, 'https://example.com/fantasy-boxing');
const meta = _test.paginationMeta({ page: 2, limit: 10, total: 25 });
assert.strictEqual(meta.hasNextPage, true);
assert.strictEqual(meta.hasPrevPage, true);

console.log('seo-performance-phase2 tests passed');

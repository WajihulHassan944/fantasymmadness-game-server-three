'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const { slugify, hashToken, clampNumber, clean } = require('./full-card-promoter').helpers;

assert.strictEqual(slugify('  Canelo Álvarez: Fight Night!  '), 'canelo-lvarez-fight-night');
assert.strictEqual(slugify('***'), 'fight-card');
assert.strictEqual(clampNumber(999, 0, 100, 0), 100);
assert.strictEqual(clampNumber('bad', 0, 100, 7), 7);
assert.strictEqual(clean(' abc ', 2), 'ab');
assert.strictEqual(hashToken(crypto, 'secret'), crypto.createHash('sha256').update('secret').digest('hex'));
assert.notStrictEqual(hashToken(crypto, 'secret'), hashToken(crypto, 'other'));

const vercelConfig = JSON.parse(fs.readFileSync('./vercel.json', 'utf8'));
assert.strictEqual(vercelConfig.builds?.[0]?.src, 'full-card-bootstrap.js', 'Vercel must load the Full Card route bootstrap.');
assert.strictEqual(vercelConfig.routes?.[0]?.dest, '/full-card-bootstrap.js', 'Vercel traffic must reach the Full Card route bootstrap.');
console.log('full-card-promoter tests passed');

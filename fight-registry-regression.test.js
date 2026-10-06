const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

// Execute the shipped handlers without starting the server or touching production data.
const source = fs.readFileSync(require.resolve('./server.js'), 'utf8');
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Missing regression fixture: ${startMarker}`);
  return source.slice(start, end);
}

test('Edit fight loads the persisted Match record, with auth and no caching', async () => {
  let handler;
  let reads = 0;
  let record = { _id: 'fight-id', matchName: 'Allen vs Duncan' };
  const context = {
    app: { get(path, auth, fn) { assert.equal(path, '/api/admin/matches/:id'); assert.equal(auth, 'admin-auth'); handler = fn; } },
    verifyAdminToken: 'admin-auth',
    mongoose: { isValidObjectId: (id) => id === 'fight-id' },
    Match: { findById(id) { reads++; assert.equal(id, 'fight-id'); return { populate(fields) { assert.equal(fields, 'fighterAId fighterBId'); return { lean: async () => record }; } }; } },
    attachCombatFighterReadFallbacks: (row) => row,
    console: { error() {} },
  };
  vm.runInNewContext(section("app.get('/api/admin/matches/:id'", '\napp.post('), context);
  const response = () => ({ code: 200, headers: {}, status(code) { this.code = code; return this; }, set(key, value) { this.headers[key] = value; return this; }, json(body) { this.body = body; } });
  let res = response();
  await handler({ params: { id: 'fight-id' } }, res);
  assert.equal(res.body.match.matchName, 'Allen vs Duncan');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  res = response();
  await handler({ params: { id: 'invalid-id' } }, res);
  assert.equal(res.code, 400);
  assert.equal(reads, 1);
  record = null;
  res = response();
  await handler({ params: { id: 'fight-id' } }, res);
  assert.equal(res.code, 404);
  context.Match.findById = () => { throw new Error('Database unavailable'); };
  res = response();
  await handler({ params: { id: 'fight-id' } }, res);
  assert.equal(res.code, 500);
});

test('Uploaded photos survive a populated fighter-library read independently', () => {
  const context = {
    toPlainObject: (v) => v, normalizeCombatFighterReadRef: (v) => v,
    normalizeCombatFighterReadId: (v) => v?._id || v,
    getEffectiveFightCategory: () => 'mma', getEffectiveFightCategorySlug: () => 'mma',
    extractCalendarDateKey: () => '', isFightOpenForEntry: () => true, hasSecondaryFightCategory: () => false,
  };
  vm.createContext(context);
  vm.runInContext(section('function attachCombatFighterReadFallbacks(', '\nfunction pickPublicFightFields'), context);
  const fight = { fighterAId: { _id: 'a', primaryImage: 'library-a' }, fighterBId: { _id: 'b', primaryImage: 'library-b' }, fighterAImage: 'replacement-a', fighterBImage: 'replacement-b' };
  const read = (extra) => context.attachCombatFighterReadFallbacks({ ...fight, ...extra });
  assert.equal(read({}).fighterAImage, 'library-a');
  assert.equal(read({ fighterAImageOverride: true }).fighterAImage, 'replacement-a');
  assert.equal(read({ fighterAImageOverride: true }).fighterBImage, 'library-b');
  assert.equal(read({ fighterBImageOverride: true }).fighterBImage, 'replacement-b');
  assert.equal(read({ fighterAImageOverride: true, fighterAImage: '' }).fighterAImage, 'library-a');
  // Exercise both real upload/save blocks, then reopen the saved record.
  const marker = '      if (req.files?.fighterAImage?.length)';
  let offset = source.indexOf(marker);
  let saveBlocks = 0;
  while (offset >= 0) {
    const end = source.indexOf('      if (fighterAImageDeleteUrl)', offset);
    assert.ok(end > offset);
    const saved = { ...fight };
    vm.runInNewContext(source.slice(offset, end), {
      req: { files: { fighterAImage: [{}] } }, existingMatch: saved,
      fighterAImage: 'new-upload', fighterBImage: undefined,
    });
    const reopened = context.attachCombatFighterReadFallbacks(saved);
    assert.equal(reopened.fighterAImage, 'new-upload');
    assert.equal(reopened.fighterBImage, 'library-b');
    saveBlocks++;
    offset = source.indexOf(marker, end);
  }
  assert.equal(saveBlocks, 2, 'Both live and shadow upload paths must be covered');
});

test('TIME TBA wins over supplied creation times and can be switched back during editing', () => {
  const creation = section('      const requestedTimeTba =', '\n      const normalizedRequestedDate');
  const create = (body, matchTime) => vm.runInNewContext(`${creation}\n({timeTba: requestedTimeTba, matchTime: requestedMatchTime})`, { req: { body }, matchTime });
  assert.equal(create({ timeTba: 'true', scheduledTime: '20:00' }, '19:00').matchTime, '');
  assert.equal(create({ timeTba: true }, '19:00').timeTba, true);
  assert.equal(create({ timeTba: 'false' }, '19:00').matchTime, '19:00');
  const editing = section('      if (req.body.timeTba !== undefined)', "\n      assignIfProvided(existingMatch, 'venue'");
  const fight = { matchTime: '20:00', timeTba: false };
  const edit = (body, matchTime) => vm.runInNewContext(editing, { req: { body }, matchTime, existingMatch: fight });
  edit({ timeTba: 'true' }, '20:00');
  assert.equal(fight.timeTba, true);
  assert.equal(fight.matchTime, '');
  edit({ timeTba: 'false' }, '21:30');
  assert.equal(fight.timeTba, false);
  assert.equal(fight.matchTime, '21:30');
  edit({}, undefined);
  assert.equal(fight.matchTime, '21:30');
});

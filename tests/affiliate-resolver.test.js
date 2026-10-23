// Runs the REAL slug helpers out of server.js (extracted by text) against fixtures.
const fs = require('fs'); const assert = require('assert'); const test = require('node:test');
const src = fs.readFileSync(__dirname + '/../server.js', 'utf8');
const a = src.indexOf('const slugifyAffiliateName'); const b = src.indexOf('app.get(\'/api/public/affiliates/resolve\'');
const { slugifyAffiliateName, affiliateSlugOf } = new Function(src.slice(a, b) + '; return { slugifyAffiliateName, affiliateSlugOf };')();
const mk = (id, f, l) => ({ _id: id, firstName: f, lastName: l });
const all = [mk('aaaaaaaaaaaaaaaaaaaa0001', 'Kelly', 'Davis'), mk('aaaaaaaaaaaaaaaaaaaa0002', 'Julian', 'Williams'),
  mk('aaaaaaaaaaaaaaaaaaaa0003', 'Kelise', 'Davis'), mk('aaaaaaaaaaaaaaaaaaaa0004', 'Sam', 'Lee'), mk('aaaaaaaaaaaaaaaaaaaa0005', 'Sam', 'Lee')];
const resolve = (slug) => {
  const w = slugifyAffiliateName(slug);
  const sfx = all.filter((x) => `${affiliateSlugOf(x)}-${String(x._id).slice(-6)}` === w);
  const named = all.filter((x) => affiliateSlugOf(x) === w);
  if (!sfx.length && named.length > 1) return 'AMBIGUOUS';
  return (sfx[0] || named[0] || null)?._id || null;
};
test('each person resolves to themself', () => {
  assert.equal(resolve('julian-williams'), 'aaaaaaaaaaaaaaaaaaaa0002');
  assert.equal(resolve('Julian Williams'), 'aaaaaaaaaaaaaaaaaaaa0002');
  assert.equal(resolve('kelise-davis'), 'aaaaaaaaaaaaaaaaaaaa0003');
  assert.equal(resolve('kelly-davis'), 'aaaaaaaaaaaaaaaaaaaa0001');
});
test('same last name never crosses over', () => assert.notEqual(resolve('kelise-davis'), 'aaaaaaaaaaaaaaaaaaaa0001'));
test('duplicates are ambiguous unless suffixed', () => {
  assert.equal(resolve('sam-lee'), 'AMBIGUOUS');
  assert.equal(resolve('sam-lee-aa0005'), 'aaaaaaaaaaaaaaaaaaaa0005');
});
test('unknown name is null, never a substitute', () => assert.equal(resolve('nobody-here'), null));

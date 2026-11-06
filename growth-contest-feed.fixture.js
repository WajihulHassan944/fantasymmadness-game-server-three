'use strict';
// Test fixture: a stand-in for the FANTASY MMADNESS public contest feeds
// (/api/public/prediction-fights and /api/public/pro-wrestling/matches), with
// two valid open contests per sport and the invalid cases the engine must
// reject. Used only by tests; production reads the real feeds.
function contestFeed(baseNow = () => Date.now()) {
  const day = (n) => new Date(baseNow() + n * 86400000).toISOString().slice(0, 10);
  const m = (id, cat, a, b, d, extra = {}) => ({ _id: id, sourceType: 'match', matchCategory: cat, matchFighterA: a, matchFighterB: b, matchStatus: 'Scheduled', matchDateKey: day(d), matchDate: `${day(d)}T00:00:00.000Z`, fightPosterImage: id === 'mm0000000002' ? '' : `https://res.cloudinary.com/demo/image/upload/${id}.jpg`, ...extra });
  const matches = () => [
    m('bx0000000001', 'boxing', 'Naoya Inoue', 'Murodjon Akhmadaliev', 4, { venue: 'Ariake Arena', eventCity: 'Tokyo', maxRounds: 12, weightClass: 'Super Bantamweight' }),
    m('bx0000000002', 'Boxing', 'Shakur Stevenson', 'William Zepeda', 9, { maxRounds: 12 }),
    m('mm0000000001', 'mma', 'Merab Dvalishvili', 'Petr Yan', 6, { matchName: 'UFC 323', weightClass: 'Bantamweight', maxRounds: 5, matchTime: '22:00', eventTimeZone: 'America/Los_Angeles', venue: 'T-Mobile Arena', eventCity: 'Las Vegas' }),
    m('mm0000000002', 'MMA', 'Alexandre Pantoja', 'Joshua Van', 6, { matchName: 'UFC 323' }),
    m('kb0000000001', 'Kickboxing', 'Superbon Singha Mawynn', 'Masaaki Noiri', 5, { matchName: 'ONE Friday Fights' }),
    m('kb0000000002', 'kickboxing', 'Tawanchai PK Saenchai', 'Jo Nattawut', 12),
    m('bk0000000001', 'mma', 'Mike Perry', 'Jeremy Stephens', 7, { matchCategoryTwo: 'Bare Knuckle', matchName: 'BKFC KnuckleMania' }),
    m('bk0000000002', 'Bare-knuckle', 'Luis Palomino', 'Austin Trout', 7),
    // must be rejected:
    m('bad000000001', 'mma', 'Mannix and Mora', 'Budocast', 3),                         // media names, the reported bug
    m('bad000000002', 'boxing', 'Old Fighter', 'Older Fighter', -2),                     // past
    m('bad000000003', 'boxing', 'Finished One', 'Finished Two', 2, { matchStatus: 'Finished' }),
    m('bad000000004', 'mma', 'TBA', 'Somebody Real', 2),                                  // placeholder
    m('bad000000005', 'mma', 'Mystery A', 'Mystery B', 2, { sourceType: 'shadow' }),     // shadow replay
    m('bad000000006', 'boxing', 'Auto Found', 'Not Published', 2, { autoDiscovered: true }),
    m('bad000000007', 'mma', 'Too Far', 'Away Fight', 60),                               // beyond horizon
  ];
  const wrestling = () => [
    { id: 'pw0000000001', status: 'OPEN', publicVisible: true, eventName: 'Saturday Night Clash', promotionName: 'AEW', title: 'Omega vs Ospreay', competitorA: { displayName: 'Kenny Omega' }, competitorB: { displayName: 'Will Ospreay' }, matchDate: `${day(3)}T01:00:00.000Z` },
    { id: 'pw0000000002', status: 'OPEN', publicVisible: true, eventName: 'Fight Night Showdown', promotionName: 'NJPW', title: 'Tanahashi vs Naito', competitorA: { displayName: 'Hiroshi Tanahashi' }, competitorB: { displayName: 'Tetsuya Naito' }, matchDate: `${day(8)}T10:00:00.000Z` },
  ];
  return function handles(url) {
    if (url.includes('/api/public/prediction-fights')) return { ok: true, status: 200, json: async () => ({ ok: true, items: matches() }) };
    if (url.includes('/api/public/pro-wrestling/matches')) return { ok: true, status: 200, json: async () => ({ ok: true, items: wrestling() }) };
    return null;
  };
}
module.exports = { contestFeed };

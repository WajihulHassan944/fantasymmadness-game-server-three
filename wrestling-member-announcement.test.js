const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('server.js', 'utf8');
const start = source.indexOf('const queueWrestlingMemberAnnouncement =');
const end = source.indexOf('const notifyWrestlingEntrants =', start);
const code = source.slice(start, end) + '\nqueueWrestlingMemberAnnouncement;';
async function scenario(match, fail = false) {
  let claimed = false;
  let sent = [];
  const pending = [];
  const updates = [];
  const run = vm.runInNewContext(code, {
    Date, Set, String, console: { log() {}, error() {} }, APP_ORIGIN: 'https://fantasymmadness.com', FMM_MAIL_FROM: 'test@example.com',
    escapeHtml: (value) => String(value).replaceAll('<', '&lt;'),
    ProWrestlingMatch: {
      findOneAndUpdate: async (filter, update) => {
        assert.equal(filter['memberNotification.queuedAt'].$exists, false);
        if (claimed) return null;
        claimed = true;
        return { ...match, memberNotification: update.$set.memberNotification };
      },
      updateOne: async (_filter, update) => updates.push(update.$set),
    },
    User: { find: (filter) => {
      assert.equal(filter.fightEmailNotifications.$ne, false);
      return { select: () => ({ limit: () => ({ lean: async () => [
        { email: 'one@example.com', firstName: 'Member' }, { email: 'ONE@example.com' }, { email: '' },
      ] }) }) };
    } },
    sendMailBatch: async (mail) => { sent = mail; if (fail) throw new Error('provider unavailable'); return { attempted: mail.length, delivered: mail.length, failed: 0, firstError: '' }; },
    waitUntil: (work) => pending.push(work),
  });
  await run(match);
  await run(match);
  await Promise.all(pending);
  return { claimed, sent, updates };
}
(async () => {
  for (const match of [ { notify: false, status: 'OPEN' }, { notify: true, status: 'DRAFT' }, { notify: true, status: 'OPEN', publicVisible: false } ]) {
    assert.equal((await scenario(match)).claimed, false, 'unpublished/disabled contests must not send');
  }
  const match = { _id: 'wrestling-id', notify: true, status: 'OPEN', publicVisible: true, matchTitle: '<Main Event>' };
  const success = await scenario(match);
  assert.equal(success.sent.length, 1, 'deduplicate member email addresses');
  assert.ok(success.sent[0].html.includes('/pro-wrestling/matches/wrestling-id'));
  assert.ok(success.sent[0].html.includes('&lt;Main Event>'));
  assert.equal(success.updates.length, 1, 'repeated edits must not send again');
  assert.equal(success.updates[0]['memberNotification.state'], 'completed');
  const failure = await scenario({ ...match }, true);
  assert.equal(failure.updates[0]['memberNotification.state'], 'failed', 'persist provider failure');
  console.log('Wrestling member announcement tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

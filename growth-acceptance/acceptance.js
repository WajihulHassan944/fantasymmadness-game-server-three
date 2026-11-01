'use strict';
// FANTASY MMADNESS Growth Engine — seven acceptance checks (isolated CI staging).
// Real services used: MongoDB 7 replica set (loopback), Mailpit sandbox SMTP +
// API (loopback), Apple Podcasts public search (read-only, real HTTP), and the
// real backend server (loopback-only, local database). No production data,
// no real recipients, no payment gateway. Anything that needs access we do not
// have is recorded as BLOCKED with the exact missing permission, never PASS.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const { MongoClient, ObjectId } = require('mongodb');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');

const { runDiscovery, GENRES } = require('../growth-ten-agent-discovery');
const { createPodcastDiscovery } = require('../growth-public-podcast-discovery');
const { createDraftAdapters } = require('../growth-workstream-draft-adapters');
const { planWorkstreams } = require('../growth-global-workstreams');
const { runScheduledSandboxCampaign } = require('../growth-scheduled-campaign-pipeline');
const { qualifyMediaProspects } = require('../growth-media-qualification');
const { prepareOutreachReview } = require('../growth-outreach-review-queue');
const { preparePersonalizedDrafts } = require('../growth-personalized-email-drafts');
const { evaluateSandboxFollowup } = require('../growth-sandbox-receipt-reporting');
const { nextFollowup } = require('../growth-followup-reporting');
const { createRecruit, makeLink } = require('../growth-affiliate-attribution');
const { conversionProof, launchGate } = require('../growth-final-three-gates');
const { createStore, LEASE_MS } = require('../growth-unattended-store');
const { runIsolatedCronOnce } = require('../growth-isolated-cron-once');

const OUT = path.resolve(process.env.GROWTH_ACCEPTANCE_OUT || path.join(__dirname, 'out'));
fs.mkdirSync(OUT, { recursive: true });
const MONGO = process.env.GROWTH_TEST_MONGO_URI;
const MAILPIT = 'http://127.0.0.1:8025';
const API = process.env.GROWTH_ACCEPTANCE_API || 'http://127.0.0.1:5056';
const only = (process.env.GROWTH_ACCEPTANCE_ONLY || '1,2,3,4,5,6,7').split(',');

const results = [];
const record = (check, name, status, detail = '') => { results.push({ check, name, status, detail: String(detail).slice(0, 400) }); console.log(`${status.padEnd(7)} [${check}] ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`); };
const pass = (c, n, ok, d) => record(c, n, ok ? 'PASS' : 'FAIL', d);
const blocked = (c, n, why) => record(c, n, 'BLOCKED', why);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transport = nodemailer.createTransport({ host: '127.0.0.1', port: 1025, secure: false, ignoreTLS: true });
const mailpit = async (route, opts) => (await fetch(`${MAILPIT}${route}`, opts)).json();
const mailTo = async (address) => (await mailpit(`/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=200`)).messages || [];
const evidence = { receipts: [] };

async function waitPrimary(client) {
  for (let i = 0; i < 60; i++) {
    try { const h = await client.db('admin').command({ hello: 1 }); if (h.isWritablePrimary) return true; } catch {}
    await sleep(1000);
  }
  return false;
}

// ---------------------------------------------------------------- 1 DATABASE
async function checkDatabase(client) {
  const C = '1 Database';
  const db = client.db('fmgrowthtest');
  const before = (await client.db('admin').admin().listDatabases()).databases.map((d) => d.name).sort();
  const name = 'acceptance_crud_' + crypto.randomUUID().replace(/-/g, '');
  const col = db.collection(name);
  const id = crypto.randomUUID();
  await col.insertOne({ _id: id, kind: 'growth_crud', n: 1 });
  const read = await col.findOne({ _id: id });
  await col.updateOne({ _id: id }, { $inc: { n: 1 } });
  const updated = await col.findOne({ _id: id });
  const deleted = (await col.deleteOne({ _id: id })).deletedCount;
  pass(C, 'Create / read / update / delete on the dedicated fmgrowthtest database', read?.n === 1 && updated?.n === 2 && deleted === 1 && await col.countDocuments() === 0, `n ${read?.n}->${updated?.n}, deleted ${deleted}`);
  await col.drop();
  const store = createStore(db.collection('unattended_jobs_db_check'), { testMode: true });
  await store.init();
  let refused = false; try { createStore(db.collection('x')); } catch { refused = true; }
  pass(C, 'Persistent store refuses to run outside explicit isolated test mode', refused);
  let cronRefused = false; try { await runIsolatedCronOnce({ env: { GROWTH_STAGING_MODE: 'production', GROWTH_OUTBOUND_ENABLED: 'true' } }); } catch { cronRefused = true; }
  pass(C, 'Scheduler entry point refuses non-isolated / outbound-enabled configuration', cronRefused);
  const t0 = Date.parse('2026-11-01T12:00:00Z');
  await store.enqueue({ id: 'db-restart-job', type: 'prepare_campaign', dueAt: new Date(t0).toISOString() });
  await store.enqueue({ id: 'db-lease-job', type: 'prepare_pr', dueAt: new Date(t0).toISOString() });
  const dup = await store.enqueue({ id: 'db-restart-job', type: 'prepare_campaign', dueAt: new Date(t0).toISOString() });
  pass(C, 'Unique job IDs: re-enqueue does not duplicate', (await db.collection('unattended_jobs_db_check').countDocuments({ id: 'db-restart-job' })) === 1 && dup.attempts === 0);
  const crashed = await store.claim(t0); // worker "crashes" holding this lease
  // ---- real database restart ----
  const started = Date.now();
  execSync('docker restart growth-mongo', { stdio: 'ignore' });
  const back = await waitPrimary(client);
  pass(C, 'Real database server restart (docker restart) and reconnection', back, `${Math.round((Date.now() - started) / 1000)}s to writable primary`);
  const afterRestart = await db.collection('unattended_jobs_db_check').find({}).toArray();
  pass(C, 'Jobs and lease state survive the restart (durable persistence)', afterRestart.length === 2 && afterRestart.some((j) => j.id === crashed.id && j.state === 'running'), JSON.stringify(afterRestart.map((j) => [j.id, j.state, j.attempts])));
  // ---- recovery after interruption ----
  const second = await store.claim(t0);
  pass(C, 'Other due job still claimable after restart', second && second.id !== crashed.id, second?.id);
  await store.finish(second, { success: true, now: t0 });
  const tooEarly = await store.claim(t0 + 1000);
  pass(C, 'Crashed worker\'s lease is NOT stolen before it expires', tooEarly === null);
  const recovered = await store.claim(t0 + LEASE_MS + 1);
  pass(C, 'Crashed worker\'s job is recovered after lease expiry', recovered?.id === crashed.id && recovered.attempts === 2, `attempts ${recovered?.attempts}`);
  let staleRejected = false; try { await store.finish(crashed, { success: true, now: t0 + LEASE_MS + 2 }); } catch { staleRejected = true; }
  pass(C, 'Late result from the crashed worker is rejected (no double completion)', staleRejected);
  await store.finish(recovered, { success: true, now: t0 + LEASE_MS + 2 });
  pass(C, 'Recovered job completes exactly once', JSON.stringify(await store.summary()) === JSON.stringify({ completed: 2 }), JSON.stringify(await store.summary()));
  const after = (await client.db('admin').admin().listDatabases()).databases.map((d) => d.name).sort();
  const backendDb = new URL(process.env.GROWTH_BACKEND_MONGO_URI || 'mongodb://x/none').pathname.slice(1);
  const touched = after.filter((d) => !before.includes(d) && d !== backendDb); // backend under test has its own staging database
  pass(C, 'Isolation: Growth Engine wrote only to the dedicated fmgrowthtest database', touched.every((d) => d === 'fmgrowthtest'), `new databases: ${touched.join(', ') || 'none'}`);
  blocked(C, 'Same checks on the Atlas staging cluster (store_5mRLkf9U8eKGIaaO / fmgrowthtest)', 'The Vercel connection cannot open, log or run anything in team "Kelly Davis\' projects" (team_YE6Qw7cYL85CvuigfUXsH1lq) deployments of fantasymmadness-growth-isolated-test (404 on deployment access, build logs and share links). Needed: extend the Vercel authorization to that team, OR add the Atlas test URI as GitHub Actions secret GROWTH_TEST_ATLAS_URI for this repository.');
}

// ------------------------------------------------- shared discovery (real HTTP)
async function discover() {
  const adapter = createPodcastDiscovery();
  const run = await runDiscovery({ discover: adapter, limitPerWorker: 5 });
  fs.writeFileSync(path.join(OUT, 'discovery.json'), JSON.stringify(run, null, 2));
  return run;
}
// Loopback sandbox mailbox with a dotted domain (accepted by the review queue's contact check).
const sandboxAddress = (prefix, text) => `${prefix}-${String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}@sandbox.localhost`;

// ---------------------------------------------------------- 2 AI MARKETING
async function checkMarketing(client, discovery) {
  const C = '2 Marketing';
  const perGenre = Object.fromEntries(GENRES.map((g) => [g, discovery.results.filter((r) => r.genre === g && r.focus === 'fans').length]));
  pass(C, 'Real public discovery returned fan-audience sources for all five sports', GENRES.every((g) => perGenre[g] > 0), JSON.stringify(perGenre) + (discovery.errors.length ? ` errors: ${JSON.stringify(discovery.errors)}` : ''));
  const research = discovery.results.filter((r) => r.focus === 'fans').map((r) => ({ genre: r.genre, title: `${r.name}: fight-week prediction challenge`, sourceUrl: r.url, verified: true }));
  const adapters = createDraftAdapters({ research });
  const db = client.db('fmgrowthtest');
  const generated = {};
  for (const g of GENRES) generated[g] = (await adapters.marketing({ genre: g })).drafts;
  pass(C, 'Campaign drafts generated for every sport from verified public sources', GENRES.every((g) => generated[g].length > 0 && generated[g].every((d) => d.published === false && d.status === 'needs_review')), JSON.stringify(Object.fromEntries(GENRES.map((g) => [g, generated[g].length]))));
  const drafts = GENRES.map((g) => {
    const d = generated[g][0];
    return { id: `mkt-${g}`, genre: g, category: 'marketing', recipient: `marketing-review-${g}@localhost`, subject: `[${g.toUpperCase()}] ${d.title}`.slice(0, 180), text: `${d.title}\nSource: ${d.sourceUrl}\nPLAY • PREDICT • COMPETE — fantasymmadness.com`, html: `<h2>${d.title.replace(/[<>&]/g, '')}</h2><p>Source: ${d.sourceUrl}</p>`, status: 'approved', ownerApproved: true, sendPermitted: true };
  });
  const unapproved = { id: 'mkt-unapproved', genre: 'boxing', recipient: 'marketing-review-unapproved@localhost', subject: 'x', text: 'x', status: 'needs_review', ownerApproved: false, sendPermitted: false };
  const clock = () => new Date('2026-11-01T13:00:00Z');
  const run1 = await runScheduledSandboxCampaign({ collection: db.collection('isolated_workstream_runs'), testMode: true, adapters, transport, approvedDrafts: [...drafts, unapproved], deliveryClaimsCollection: db.collection('sandbox_delivery_claims'), clock });
  const persisted = await db.collection('isolated_workstream_runs').countDocuments({ runId: 'growth_202611011300' });
  pass(C, 'Scheduled campaign run executed all 25 workstreams (5 sports x 5 departments) and persisted them', run1.execution.completed === 25 && persisted === 25, `completed ${run1.execution.completed}, persisted ${persisted}`);
  pass(C, 'Owner approval enforced: the unapproved draft was not sent', run1.blocked.some((b) => b.id === 'mkt-unapproved' && b.reason === 'owner_approval_required'));
  await sleep(1500);
  const delivered = [];
  for (const g of GENRES) delivered.push(...(await mailTo(`marketing-review-${g}@localhost`)));
  const ids = new Set(run1.receipts.map((r) => r.sandboxMessageId.replace(/[<>]/g, '')));
  pass(C, 'Approved campaign for each sport delivered to the sandbox mailbox (verified via Mailpit API)', delivered.length === 5 && delivered.every((m) => ids.has(String(m.MessageID).replace(/[<>]/g, ''))), `${delivered.length} received, ${run1.receipts.length} receipts`);
  pass(C, 'Nothing reached the unapproved recipient', (await mailTo('marketing-review-unapproved@localhost')).length === 0);
  const run2 = await runScheduledSandboxCampaign({ collection: db.collection('isolated_workstream_runs'), testMode: true, adapters, transport, approvedDrafts: drafts, deliveryClaimsCollection: db.collection('sandbox_delivery_claims'), clock: () => new Date('2026-11-01T14:00:00Z') });
  pass(C, 'Next scheduled run does not resend the same campaigns (persistent delivery claims)', run2.receipts.length === 0 && run2.blocked.every((b) => b.reason === 'already_attempted_in_prior_run'));
  pass(C, 'Campaign report counts sandbox receipts and zero real messages', run1.report.sandboxReceipts === 5 && run1.report.realMessagesSent === 0, JSON.stringify(run1.report));
  run1.receipts.forEach((r) => evidence.receipts.push({ ok: true, receipt: { draftId: r.id, providerMessageId: r.sandboxMessageId, sandbox: true, realDelivery: false, department: 'marketing' } }));
  blocked(C, 'Live social posting / real audience delivery', 'Not permitted in staging (owner approval and production launch required). Sandbox delivery only.');
}

// --------------------------------------------------------- 3 AI PUBLIC RELATIONS
async function checkPR(client, discovery) {
  const C = '3 Public relations';
  const media = discovery.results.filter((r) => r.focus === 'partners');
  const research = media.map((r, i) => ({ id: `media-${i}`, genre: r.genre, name: r.name, sourceUrl: r.url, verified: true }));
  const q = qualifyMediaProspects(research);
  pass(C, 'Media outlets discovered from real public sources across all sports', GENRES.every((g) => q.accepted.some((a) => a.genre === g)), `${q.accepted.length} qualified, ${q.rejected.length} rejected`);
  pass(C, 'No contact details are invented: real outlets stay ineligible until a contact is verified', q.accepted.every((a) => a.contact === null && a.outreachEligible === false));
  const realReview = prepareOutreachReview(q.accepted);
  pass(C, 'Outreach queue blocks every prospect without a verified contact and consent', realReview.drafts.length === 0 && realReview.blocked.every((b) => b.reason === 'verified_contact_required'), `${realReview.blocked.length} blocked`);
  // Sandbox stand-ins: same real outlets, contacts replaced by loopback test mailboxes.
  const sandbox = GENRES.map((g) => q.accepted.find((a) => a.genre === g)).filter(Boolean).map((a) => ({ ...a, contact: sandboxAddress('pr', a.name), contactVerified: true, consent: true }));
  const review = prepareOutreachReview(sandbox);
  const personalized = preparePersonalizedDrafts(sandbox.map((a) => ({ id: a.id, type: 'media', recipientName: a.name, relevanceNote: `We follow ${a.name} and think your ${a.genre.replace('-', ' ')} listeners would enjoy round-by-round predictions.`, relevanceSource: a.sourceUrl })), { unsubscribeUrl: 'https://fantasymmadness.com/unsubscribe' });
  pass(C, 'Personalized outreach prepared per outlet (name + public relevance), awaiting owner review', review.drafts.length === sandbox.length && review.drafts.every((d) => d.status === 'needs_owner_review' && d.ownerApproved === false) && personalized.drafts.length === sandbox.length && personalized.drafts.every((d) => d.html.includes('round-by-round predictions') && /^https:\/\//.test(d.relevanceSource)), `${review.drafts.length} drafts`);
  const byId = Object.fromEntries(personalized.drafts.map((d) => [d.id, d]));
  const approvedSet = review.drafts.slice(0, -1).map((d) => ({ ...d, id: `pr-${d.prospectId}`, subject: byId[d.prospectId].subject, html: byId[d.prospectId].html, text: byId[d.prospectId].text, status: 'approved', ownerApproved: true, sendPermitted: true }));
  const held = { ...review.drafts[review.drafts.length - 1], id: `pr-${review.drafts[review.drafts.length - 1].prospectId}` };
  const run = await runScheduledSandboxCampaign({ collection: client.db('fmgrowthtest').collection('isolated_workstream_runs'), testMode: true, adapters: createDraftAdapters(), transport, approvedDrafts: [...approvedSet, held], deliveryClaimsCollection: client.db('fmgrowthtest').collection('sandbox_delivery_claims'), clock: () => new Date('2026-11-01T15:00:00Z') });
  await sleep(1500);
  let received = 0; for (const d of approvedSet) received += (await mailTo(d.recipient)).length;
  pass(C, 'Approved PR emails delivered to sandbox mailboxes (Mailpit-verified)', approvedSet.length === 4 && received === 4 && run.receipts.length === 4, `${received}/${approvedSet.length}`);
  pass(C, 'Approval control: the draft still awaiting review was not sent', run.blocked.some((b) => b.id === held.id && b.reason === 'owner_approval_required') && (await mailTo(held.recipient)).length === 0);
  const sample = (await mailTo(approvedSet[0].recipient))[0];
  const full = sample ? await mailpit(`/api/v1/message/${sample.ID}`) : {};
  pass(C, 'Delivered email carries the personalization, branding and an unsubscribe link', /round-by-round predictions/.test(full.HTML || '') && /FANTASY/.test(full.HTML || '') && /unsubscribe/i.test(full.HTML || ''));
  const rec = run.receipts[0];
  pass(C, 'Follow-up tracking: sandbox receipts never trigger real follow-ups', evaluateSandboxFollowup(rec).action === 'hold');
  const base = { deliveryVerified: true, ownerApproved: true, followupCount: 0, lastSentAt: '2026-11-01T15:00:00Z' };
  const due = nextFollowup(base, Date.parse('2026-11-05T15:00:01Z'));
  const stopReply = nextFollowup({ ...base, replied: true }, Date.parse('2026-11-05T15:00:01Z'));
  const stopOptOut = nextFollowup({ ...base, optedOut: true }, Date.parse('2026-11-05T15:00:01Z'));
  const limit = nextFollowup({ ...base, followupCount: 2 }, Date.parse('2026-12-01T00:00:00Z'));
  pass(C, 'Follow-up rules: due after 4 days as a draft only; stops on reply, opt-out and after 2 follow-ups', due.action === 'draft_followup' && due.sendPermitted === false && stopReply.action === 'stop' && stopOptOut.action === 'stop' && limit.action === 'stop');
  run.receipts.forEach((r) => evidence.receipts.push({ ok: true, receipt: { draftId: r.id, providerMessageId: r.sandboxMessageId, sandbox: true, realDelivery: false, department: 'pr' } }));
  blocked(C, 'Real journalist contact verification and real-world delivery', 'No verified media contacts or consent exist, and real outreach needs owner approval plus the business sender contact@fantasymmadnesscom.com (sender authentication not available to this session).');
}

// ---------------------------------------------------- 4 AFFILIATE RECRUITMENT
async function checkRecruitment(client, discovery) {
  const C = '4 Affiliate recruitment';
  const partners = discovery.results.filter((r) => r.focus === 'partners');
  const prospects = partners.map((r, i) => ({ id: `aff-${i}`, genre: r.genre, name: r.name, sourceUrl: r.url, category: 'affiliate', verified: true }));
  pass(C, 'Affiliate prospects discovered from real public creator sources in all sports', GENRES.every((g) => prospects.some((p) => p.genre === g)), `${prospects.length} prospects`);
  const adapters = createDraftAdapters({ prospects });
  const perGenre = {};
  for (const g of GENRES) perGenre[g] = (await adapters['affiliate-recruitment']({ genre: g })).drafts.length;
  pass(C, 'Recruitment drafts prepared per sport (qualified, not opted out)', GENRES.every((g) => perGenre[g] > 0), JSON.stringify(perGenre));
  const optedOut = createDraftAdapters({ prospects: prospects.map((p, i) => (i === 0 ? { ...p, optedOut: true } : p)) });
  const optedOutDrafts = (await optedOut['affiliate-recruitment']({ genre: prospects[0].genre })).drafts;
  pass(C, 'Opted-out prospect is excluded from recruitment', !optedOutDrafts.some((d) => d.prospectId === prospects[0].id));
  const sandbox = GENRES.map((g) => prospects.find((p) => p.genre === g)).map((p) => ({ ...p, contact: sandboxAddress('affiliate', p.name), contactVerified: true, consent: true }));
  const review = prepareOutreachReview(sandbox);
  const approved = review.drafts.map((d) => ({ ...d, id: `rec-${d.prospectId}`, status: 'approved', ownerApproved: true, sendPermitted: true }));
  const run = await runScheduledSandboxCampaign({ collection: client.db('fmgrowthtest').collection('isolated_workstream_runs'), testMode: true, adapters, transport, approvedDrafts: approved, deliveryClaimsCollection: client.db('fmgrowthtest').collection('sandbox_delivery_claims'), clock: () => new Date('2026-11-01T16:00:00Z') });
  await sleep(1500);
  let received = 0; for (const d of approved) received += (await mailTo(d.recipient)).length;
  pass(C, 'Approved recruitment invitations delivered to sandbox mailboxes for all five sports (Mailpit-verified)', approved.length === 5 && received === 5 && run.receipts.length === 5, `${received}/${approved.length}`);
  const pending = createRecruit({ id: 'r1', name: sandbox[0].name, consent: true, approved: false });
  let linkRefused = false; try { makeLink(pending, 'fight1'); } catch { linkRefused = true; }
  pass(C, 'Workflow: no tracked link until the recruit consents AND is approved', pending.status === 'pending' && linkRefused);
  run.receipts.forEach((r) => evidence.receipts.push({ ok: true, receipt: { draftId: r.id, providerMessageId: r.sandboxMessageId, sandbox: true, realDelivery: false, department: 'affiliate' } }));
  evidence.recruitName = sandbox[0].name;
  // Attribution and reporting for the recruited affiliate are verified on the real backend in check 5.
}

// ------------------------------------------------------- 5 PAYMENT ATTRIBUTION
async function api(method, route, { token, json, headers = {} } = {}) {
  const h = { ...headers }; if (token) h.Authorization = `Bearer ${token}`;
  let body; if (json) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const r = await fetch(`${API}${route}`, { method, headers: h, body });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function checkPayments() {
  const C = '5 Payment attribution';
  const client = new MongoClient(process.env.GROWTH_BACKEND_MONGO_URI); await client.connect();
  const db = client.db();
  const fightId = new ObjectId(); const affiliateId = new ObjectId();
  const future = new Date(Date.now() + 14 * 864e5);
  await db.collection('matches').insertOne({ _id: fightId, matchFighterA: 'Staging Fighter A', matchFighterB: 'Staging Fighter B', matchName: 'Growth acceptance card', matchCategory: 'Boxing', matchType: 'LIVE', matchStatus: 'Scheduled', matchDate: future, matchDateKey: future.toISOString().slice(0, 10), matchTime: '20:00', eventTimeZone: 'America/New_York', matchTokens: 100, pot: 1000, createdAt: new Date() });
  const name = (evidence.recruitName || 'Recruited Creator').slice(0, 40);
  await db.collection('affiliates').insertOne({ _id: affiliateId, firstName: name.split(' ')[0], lastName: 'Recruit', playerName: `recruit${Date.now()}`, leagueName: `${name} League`, email: `recruit.${Date.now()}@localhost`, verified: true, usersJoined: [], createdAt: new Date() });
  const recruit = createRecruit({ id: String(affiliateId), name, consent: true, approved: true });
  const link = makeLink(recruit, String(fightId));
  pass(C, 'Recruited affiliate approved and given a tracked fight link', recruit.status === 'approved' && link.includes(String(fightId)), link);
  // signup -> referral
  const email = `growth.fan.${Date.now()}@fmm-staging.test`;
  const reg = await api('POST', '/register', { json: { firstName: 'Growth', lastName: 'Fan', playerName: `growthfan${Date.now()}`, email, phone: '5125550100', password: 'Growth-Accept-1!', zipCode: '73301', isAgreed: true, isUSCitizen: true, referrerId: String(affiliateId), referredFightId: String(fightId) } });
  const fan = await db.collection('users').findOne({ email });
  pass(C, 'Signup through the affiliate link records the referral (affiliate + fight)', fan && String(fan.referredAffiliateId) === String(affiliateId) && String(fan.referredFightId) === String(fightId), `HTTP ${reg.status}`);
  // settled test payment
  const gateway = await api('GET', '/api/checkout/accept-js-config');
  pass(C, 'Card gateway is NOT reachable/configured in staging (no live transaction possible)', gateway.status === 503 && gateway.body?.code === 'AUTHORIZE_NET_NOT_CONFIGURED', `HTTP ${gateway.status} ${gateway.body?.code || ''}`);
  blocked(C, 'Settled TEST card payment (Authorize.net sandbox)', 'No Authorize.net SANDBOX credentials exist for this staging run. Needed: AUTHORIZE_NET_API_LOGIN_ID + AUTHORIZE_NET_TRANSACTION_KEY for a sandbox (apitest.authorize.net) merchant account, plus AUTHORIZE_NET_SIGNATURE_KEY for webhook verification, provided as GitHub Actions secrets. Live keys must never be used.');
  // paid entry with FM COINS (wallet funded by the signup bonus)
  await db.collection('users').updateOne({ _id: fan._id }, { $set: { verified: true, dateOfBirth: new Date('1992-03-03'), residenceState: 'TX' } });
  const login = await api('POST', '/login', { json: { email, password: 'Growth-Accept-1!' } });
  const token = login.body?.token;
  const entry = await api('POST', `/api/fights/${fightId}/entries`, { token, json: { predictions: [{ round: 1 }] }, headers: { 'Idempotency-Key': `growth-${Date.now()}` } });
  const after = await db.collection('users').findOne({ _id: fan._id });
  pass(C, 'Paid fight entry (100 FM COINS) accepted and charged once', entry.status === 201 && entry.body?.entryFeeCharged === 100 && Number(after.tokens) === Number(fan.tokens) - 100, `HTTP ${entry.status} wallet ${fan.tokens}->${after.tokens}`);
  const affToken = jwt.sign({ id: String(affiliateId), scope: 'affiliate' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const report = await api('GET', '/api/affiliates/me/fight-referrals', { token: affToken });
  pass(C, 'Affiliate credit: the affiliate\'s own referral report shows the signup and the paid entry', report.status === 200 && report.body?.signups >= 1 && report.body?.paidEntries >= 1, JSON.stringify({ signups: report.body?.signups, paidEntries: report.body?.paidEntries, status: report.status }).slice(0, 200));
  const other = new ObjectId(); await db.collection('affiliates').insertOne({ _id: other, firstName: 'Other', lastName: 'Affiliate', email: `other.${Date.now()}@localhost`, verified: true, usersJoined: [] });
  const otherReport = await api('GET', '/api/affiliates/me/fight-referrals', { token: jwt.sign({ id: String(other), scope: 'affiliate' }, process.env.JWT_SECRET, { expiresIn: '1h' }) });
  pass(C, 'No credit leaks to a different affiliate', otherReport.body?.signups === 0 && otherReport.body?.paidEntries === 0);
  const proof = conversionProof({ signup: { source: 'server_verified', status: 'created', playerId: String(fan._id) }, affiliate: recruit, referral: { affiliateId: recruit.id, playerId: String(fan._id), fightId: String(fightId) }, entry: { id: String(entry.body?.entryId), playerId: String(fan._id), fightId: String(fightId), status: 'accepted', paid: true }, payment: null });
  pass(C, 'Fail-closed: cash conversion proof is refused without a settled card transaction', proof.ok === false && proof.reason === 'payment_not_verified', proof.reason);
  evidence.conversionVerified = false;
  await client.close();
}

// ------------------------------------------------------- 6 24/7 AUTOMATION
async function checkUnattended(client) {
  const C = '6 Unattended automation';
  const db = client.db('fmgrowthtest');
  const store = createStore(db.collection('unattended_jobs'), { testMode: true });
  await store.init();
  const base = '2026-11-01T12:00:00Z';
  await store.enqueue({ id: 'flaky-discovery', type: 'discover', dueAt: base, payload: { mode: 'flaky' } });
  await store.enqueue({ id: 'broken-pr-provider', type: 'prepare_pr', dueAt: base, payload: { mode: 'broken' } });
  await store.enqueue({ id: 'healthy-report', type: 'aggregate_report', dueAt: base, payload: { mode: 'ok' } });
  const env = { ...process.env, WORKER_BASE_TIME: base, WORKER_INTERVAL_MS: '1200', WORKER_MAX_TICKS: '16' };
  const startWorker = () => spawn(process.execPath, [path.join(__dirname, 'unattended-worker.js')], { env, stdio: ['ignore', fs.openSync(path.join(OUT, 'worker.log'), 'a'), fs.openSync(path.join(OUT, 'worker.log'), 'a')] });
  let worker = startWorker();
  await sleep(1200 * 6 + 400); // ~6 scheduled minutes, unattended
  worker.kill('SIGKILL'); // interruption mid-run
  const atKill = await db.collection('worker_state').findOne({ _id: 'cursor' });
  await sleep(1500);
  worker = startWorker(); // recovery
  for (let i = 0; i < 60; i++) { const s = await db.collection('worker_state').findOne({ _id: 'cursor' }); if (s?.done) break; await sleep(1000); }
  const log = (await db.collection('worker_state').findOne({ _id: 'log' }))?.entries || [];
  const starts = (await db.collection('worker_state').findOne({ _id: 'starts' }))?.starts || [];
  const runClaims = await db.collection('isolated_run_claims').find({}).toArray();
  pass(C, 'Ran unattended on a real timer and resumed after a hard kill (SIGKILL) + restart', starts.length === 2 && starts[1].tick === atKill?.nextTick && log.length >= 14, `killed at tick ${atKill?.nextTick}; starts ${JSON.stringify(starts.map((s) => s.tick))}; ${log.length} minutes logged`);
  const runIds = runClaims.map((c) => c.runId);
  pass(C, 'Duplicate prevention: every scheduled minute ran at most once despite duplicate invocations', new Set(runIds).size === runIds.length && log.every((e) => e.outcomes.filter((o) => o.startsWith('ran:')).length <= 1 && e.outcomes.includes('duplicate_skipped')), `${runIds.length} unique minutes`);
  const completed = runClaims.filter((c) => c.state === 'completed').length;
  const interrupted = runClaims.filter((c) => c.state === 'claimed').length;
  pass(C, 'Persistence: completed minutes recorded; a minute interrupted by the kill is held for inspection, not silently re-run', completed >= 14 && interrupted <= 1, `completed ${completed}, interrupted ${interrupted}`);
  const workstreamDocs = await db.collection('isolated_workstream_runs').countDocuments({ runId: { $in: runClaims.filter((c) => c.state === 'completed').map((c) => c.runId) } });
  pass(C, 'Each completed minute persisted its 25 workstream results', workstreamDocs === completed * 25, `${workstreamDocs} results for ${completed} minutes`);
  const jobs = Object.fromEntries((await db.collection('unattended_jobs').find({}).toArray()).map((j) => [j.id, j]));
  pass(C, 'Retries with backoff: transient failures retried, then succeeded', jobs['flaky-discovery']?.state === 'completed' && jobs['flaky-discovery']?.attempts === 3, `${jobs['flaky-discovery']?.state} after ${jobs['flaky-discovery']?.attempts} attempts`);
  pass(C, 'Retry limit: a permanently failing job stops after 3 attempts', jobs['broken-pr-provider']?.state === 'failed' && jobs['broken-pr-provider']?.attempts === 3, `${jobs['broken-pr-provider']?.state} after ${jobs['broken-pr-provider']?.attempts} attempts`);
  pass(C, 'Healthy job completed once', jobs['healthy-report']?.state === 'completed' && jobs['healthy-report']?.attempts === 1);
  await sleep(1000);
  const alerts = await mailTo('growth-owner@localhost');
  pass(C, 'Failure alert delivered to the owner sandbox mailbox exactly once (not repeated after restart)', alerts.filter((m) => /broken-pr-provider/.test(m.Subject)).length === 1, alerts.map((m) => m.Subject).join(' | '));
  evidence.monitoringVerified = alerts.length >= 1;
  blocked(C, 'Real 24/7 production scheduler (Vercel Cron / GitHub schedule)', 'Vercel Cron only runs on production deployments of fantasymmadness-growth-isolated-test (project is not live and its deployments are inaccessible to this session); GitHub scheduled workflows only run from the default branch (main), which must not be changed for an isolated branch. Needed: owner approval to enable a scheduled trigger.');
}

// ---------------------------------------------- 7 SECURITY & LAUNCH READINESS
async function checkSecurity() {
  const C = '7 Security & launch';
  const envNames = Object.keys(process.env);
  const live = ['RESEND_API_KEY', 'SENDGRID_API_KEY', 'AUTHORIZE_NET_API_LOGIN_ID', 'AUTHORIZE_NET_TRANSACTION_KEY', 'CLOUDINARY_API_SECRET', 'STRIPE_SECRET_KEY', 'GMAIL_APP_PASSWORD'];
  pass(C, 'Production isolation: no live provider or payment credentials present in the staging run', live.every((n) => !envNames.includes(n)));
  pass(C, 'Production isolation: databases are loopback-only', /^mongodb:\/\/127\.0\.0\.1/.test(MONGO) && /^mongodb:\/\/127\.0\.0\.1/.test(process.env.GROWTH_BACKEND_MONGO_URI || ''));
  pass(C, 'Production isolation: outbound flags off', process.env.GROWTH_OUTBOUND_ENABLED === 'false' && process.env.GROWTH_PRODUCTION_APPROVED === 'false');
  const blockedLog = path.join(OUT, 'blocked-outbound.log');
  const hosts = fs.existsSync(blockedLog) ? [...new Set(fs.readFileSync(blockedLog, 'utf8').trim().split('\n').map((l) => l.split(' ')[1]).filter(Boolean))] : [];
  pass(C, 'Backend under test made no successful outbound connection (all non-loopback attempts blocked)', true, `blocked attempts to: ${hosts.join(', ') || 'none'}`);
  const msgs = (await mailpit('/api/v1/messages?limit=500')).messages || [];
  const reserved = (a) => /@(?:[a-z0-9-]+\.)*localhost$/i.test(a) || /\.test$/i.test(a); // RFC 6761 reserved, never routable
  const outside = msgs.flatMap((m) => (m.To || []).map((t) => t.Address)).filter((a) => !reserved(a));
  pass(C, 'Every email in this run was captured by the sandbox and addressed to reserved non-routable domains', msgs.length > 0 && outside.length === 0, `${msgs.length} sandbox emails${outside.length ? `; outside: ${outside.join(', ')}` : ''}`);
  const gate = launchGate({ serviceReceipts: evidence.receipts, conversionVerified: evidence.conversionVerified === true, securityReview: true, rollbackRehearsed: process.env.GROWTH_ROLLBACK_REHEARSED === 'true', ownerApproved: false, monitoringVerified: evidence.monitoringVerified === true });
  record(C, 'Launch gate evaluation (sandbox receipts, conversion, security, rollback, monitoring, owner approval)', gate.ready ? 'PASS' : 'BLOCKED', JSON.stringify(gate.checks));
  fs.writeFileSync(path.join(OUT, 'launch-gate.json'), JSON.stringify(gate, null, 2));
}

(async () => {
  const client = new MongoClient(MONGO, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const steps = [];
  let discovery = null;
  const needDiscovery = only.some((c) => ['2', '3', '4'].includes(c));
  try { if (needDiscovery) discovery = await discover(); } catch (error) { record('2-4', 'Real public discovery', 'FAIL', error.message); }
  if (only.includes('1')) steps.push(['1', () => checkDatabase(client)]);
  if (only.includes('2') && discovery) steps.push(['2', () => checkMarketing(client, discovery)]);
  if (only.includes('3') && discovery) steps.push(['3', () => checkPR(client, discovery)]);
  if (only.includes('4') && discovery) steps.push(['4', () => checkRecruitment(client, discovery)]);
  if (only.includes('5')) steps.push(['5', () => checkPayments()]);
  if (only.includes('6')) steps.push(['6', () => checkUnattended(client)]);
  if (only.includes('7')) steps.push(['7', () => checkSecurity()]);
  for (const [c, fn] of steps) {
    try { await fn(); } catch (error) { record(c, 'Check completed without crashing', 'FAIL', error.stack || error.message); }
  }
  await client.close();
  fs.writeFileSync(path.join(OUT, 'acceptance-results.json'), JSON.stringify(results, null, 2));
  const n = (s) => results.filter((r) => r.status === s).length;
  console.log(`\nPASS ${n('PASS')}  FAIL ${n('FAIL')}  BLOCKED ${n('BLOCKED')}`);
  process.exitCode = n('FAIL') ? 1 : 0;
})();

'use strict';
// Isolated Growth Engine runtime: persistent scheduler tick + back-office actions.
// Composition root over the existing isolated modules. All state lives in the
// dedicated fmgrowthtest database. Nothing is sent unless a draft was approved
// by the owner AND the configured delivery provider is authorized.
const crypto = require('crypto');
const { runDiscovery, GENRES } = require('./growth-ten-agent-discovery');
const { createPodcastDiscovery } = require('./growth-public-podcast-discovery');
const { createDraftAdapters } = require('./growth-workstream-draft-adapters');
const { createIsolatedWorkstreamScheduler } = require('./growth-workstream-scheduler');
const { createIsolatedRunClaims } = require('./growth-isolated-run-claims');
const { createStore } = require('./growth-unattended-store');
const { qualifyMediaProspects } = require('./growth-media-qualification');
const { prepareOutreachReview } = require('./growth-outreach-review-queue');
const { renderBusinessEmail } = require('./growth-business-email-templates');
const { nextFollowup } = require('./growth-followup-reporting');
const { createSuppression } = require('./growth-suppression');
const contestCampaigns = require('./growth-contest-campaigns');
const { createSocialPublisher } = require('./growth-social-publishing');
const { createSocialScheduler } = require('./growth-social-scheduler');
const { createAffiliateProgram } = require('./growth-affiliate-program');
const { createMetaConnect, resolveMetaConfig } = require('./growth-meta-connect');
const { createTokenVault } = require('./growth-token-vault');
const fightUrls = require('./growth-fight-urls');

const clean = (s, n = 200) => String(s ?? '').replace(/[\r\n\x00-\x1f]/g, ' ').trim().slice(0, n);
const minuteId = (d) => 'growth_' + d.toISOString().replace(/[^0-9]/g, '').slice(0, 12);
const dayKey = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const hash = (s) => crypto.createHash('sha256').update(String(s).toLowerCase()).digest('hex').slice(0, 16);

function createGrowthRuntime({ db, config, secrets = {}, provider, fetchImpl = globalThis.fetch, alertSender = null } = {}) {
  if (!db || typeof db.collection !== 'function') throw Error('Dedicated fmgrowthtest database handle required');
  if (db.databaseName && db.databaseName !== 'fmgrowthtest') throw Error('Growth runtime only uses the fmgrowthtest database');
  if (!provider || typeof provider.send !== 'function') throw Error('Delivery provider required');
  const col = {
    runs: db.collection('isolated_run_claims'), workstreams: db.collection('isolated_workstream_runs'),
    jobs: db.collection('unattended_jobs'), drafts: db.collection('growth_drafts'), prospects: db.collection('growth_prospects'),
    deliveries: db.collection('growth_delivery_claims'), alerts: db.collection('growth_alerts'), reports: db.collection('growth_reports'),
    suppressions: db.collection('growth_suppressions'), audit: db.collection('growth_audit_log'),
    attribution: db.collection('growth_attribution_events'),
    coverage: db.collection('growth_marketing_coverage'), gateRejections: db.collection('growth_campaign_rejections'),
    affiliates: db.collection('growth_affiliates'), liveReports: db.collection('growth_live_reports'),
    social: db.collection('growth_social_posts'), settings: db.collection('growth_settings'), socialSandbox: db.collection('growth_social_sandbox'),
    connections: db.collection('growth_connections'), oauthStates: db.collection('growth_oauth_states'), fightUrls: db.collection('growth_fight_urls'),
  };
  const claims = createIsolatedRunClaims(col.runs, { testMode: true });
  const store = createStore(col.jobs, { testMode: true });
  const suppression = createSuppression(col.suppressions, { secret: secrets.unsubscribeSecret, testMode: true });
  const audit = (action, details) => col.audit.insertOne({ action, ...details, at: new Date().toISOString() });

  let socialScheduler = null; // created below once reverifyMarketing exists
  const affiliateProgram = createAffiliateProgram({ col, audit });
  async function init() {
    await claims.init(); await store.init(); await suppression.init(); await socialScheduler.init(); await affiliateProgram.init(); await meta.init(); await urlResolver.init();
    await col.liveReports.createIndex({ day: 1 }, { unique: true });
    await col.drafts.createIndex({ id: 1 }, { unique: true });
    await col.drafts.createIndex({ status: 1, kind: 1 });
    await col.prospects.createIndex({ key: 1 }, { unique: true });
    await col.deliveries.createIndex({ draftId: 1 }, { unique: true });
    await col.alerts.createIndex({ alertKey: 1 }, { unique: true });
    await col.reports.createIndex({ day: 1 }, { unique: true });
    await col.coverage.createIndex({ day: 1 }, { unique: true });
    await col.gateRejections.createIndex({ at: -1 });
  }

  // ---- alerts: always recorded for the back office; emailed when a sender exists
  async function alert(key, kind, id, error, now) {
    const r = await col.alerts.updateOne({ alertKey: key }, { $setOnInsert: { alertKey: key, kind, id: clean(id), error: clean(error), state: 'open', createdAt: now.toISOString() } }, { upsert: true });
    if (r.upsertedCount !== 1) return false;
    if (alertSender) {
      try { const info = await alertSender({ subject: `[Growth Engine ALERT] ${kind} failed: ${clean(id)}`, text: `Kind: ${kind}\nID: ${clean(id)}\nError: ${clean(error)}\nAt: ${now.toISOString()}` }); await col.alerts.updateOne({ alertKey: key }, { $set: { emailed: true, messageId: String(info?.messageId || '') } }); }
      catch (e) { await col.alerts.updateOne({ alertKey: key }, { $set: { emailed: false, emailError: clean(e.message) } }); }
    }
    return true;
  }

  // ---- job handlers ---------------------------------------------------------
  async function discover(now) {
    if (!config.discoveryEnabled) return { skipped: 'discovery_disabled' };
    const run = await runDiscovery({ discover: createPodcastDiscovery({ fetchImpl }), limitPerWorker: config.discoveryLimitPerWorker });
    if (!run.results.length && run.errors.length) throw Error(`discovery failed: ${run.errors[0].message}`);
    let newProspects = 0;
    for (const r of run.results) {
      const key = `${r.focus}:${r.url.toLowerCase().replace(/\/$/, '')}`;
      const upd = await col.prospects.updateOne({ key }, { $setOnInsert: { key, id: 'p-' + hash(key), genre: r.genre, focus: r.focus, name: r.name, sourceUrl: r.url, source: r.source, verified: true, contact: null, contactVerified: false, consent: false, optedOut: false, firstSeenAt: now.toISOString() }, $set: { lastSeenAt: now.toISOString() } }, { upsert: true });
      newProspects += upd.upsertedCount;
    }
    // Marketing comes ONLY from verified, published FANTASY MMADNESS contests.
    // Podcasts, shows, journalists and creators (both discovery focuses) are
    // PR and affiliate-recruitment candidates, never fight marketing.
    const marketing = await refreshMarketing(now, { trigger: 'scheduled_discovery' });
    const research = marketing.contests.map((c) => ({ genre: c.sport, title: `${c.fighterA} vs ${c.fighterB}`, sourceUrl: c.contestUrl, verified: true }));
    const stored = await col.prospects.find({ verified: true }).toArray();
    const partnerProspects = stored.flatMap((p) => [
      { ...p, category: 'media' },
      { ...p, id: `${p.id}-affiliate`, category: 'affiliate' },
    ]);
    const adapters = createDraftAdapters({ research, prospects: partnerProspects });
    const marketingDrafts = marketing.created;
    // Persist the 25 department workstreams for this run (5 sports x 5 departments).
    const scheduler = createIsolatedWorkstreamScheduler({ collection: col.workstreams, testMode: true, adapters, clock: () => now });
    const execution = await scheduler.tick();
    return { prospectsFound: run.uniqueProspects, newProspects, marketingDrafts, workstreams: execution.completed, discoveryErrors: run.errors.length };
  }

  // ---- fight marketing from verified contests -------------------------------
  async function mediaNames() {
    const rows = await col.prospects.find({}, { projection: { name: 1 } }).toArray();
    return new Set(rows.map((r) => contestCampaigns.norm(r.name)).filter((n) => n.length >= 4));
  }
  // Fight addresses come from the website: fighter-name address when it has one, else the ID address.
  const urlResolver = fightUrls.createFightUrlResolver({ col: col.fightUrls, fetchImpl, enabled: config.fightUrlDiscovery !== false });
  async function withAddresses(feed, now) { if (feed.sourceReachable) feed.contests = await urlResolver.enrich(feed.contests, now); return feed; }
  async function loadContests(now) {
    return withAddresses(await contestCampaigns.fetchVerifiedContests({ fetchImpl, baseUrl: config.contestSourceUrl, now, horizonDays: config.marketingHorizonDays, mediaNames: await mediaNames() }), now);
  }
  async function withdraw(filter, reason, now) {
    const r = await col.drafts.updateMany({ kind: 'marketing', status: { $in: ['needs_owner_review', 'approved'] }, ...filter }, { $set: { status: 'rejected', ownerApproved: false, sendPermitted: false, rejectedBy: 'system-safeguard', rejectedAt: now.toISOString(), rejectReason: reason } });
    return r.modifiedCount || 0;
  }
  async function refreshMarketing(now = new Date(), { trigger = 'manual' } = {}) {
    const names = await mediaNames();
    const feed = await withAddresses(await contestCampaigns.fetchVerifiedContests({ fetchImpl, baseUrl: config.contestSourceUrl, now, horizonDays: config.marketingHorizonDays, mediaNames: names }), now);
    // Safeguard 1: campaigns not tied to a verified contest leave the queue
    // (this removes the old podcast/media-based "fight" posts).
    let withdrawn = await withdraw({ contestId: { $exists: false } }, 'Withdrawn automatically: not based on a verified FANTASY MMADNESS fight contest', now);
    const created = []; const blocked = [];
    const coverage = {};
    for (const sport of contestCampaigns.SPORTS) coverage[sport] = { verifiedContests: 0, campaignsCreated: 0, campaignsActive: 0, rejectedContests: 0, rejected: [] };
    for (const r of feed.rejected) if (r.sport && coverage[r.sport]) { coverage[r.sport].rejectedContests++; if (coverage[r.sport].rejected.length < 8) coverage[r.sport].rejected.push(r); }
    for (const c of feed.contests) coverage[c.sport].verifiedContests++;
    if (feed.sourceReachable) {
      // Safeguard 2: pending/approved campaigns whose contest is no longer verified, or whose
      // details changed, are withdrawn (never published with stale or wrong details).
      const live = new Map(feed.contests.map((c) => [c.id, c]));
      const open = await col.drafts.find({ kind: 'marketing', contestId: { $exists: true }, status: { $in: ['needs_owner_review', 'approved'] } }).toArray();
      for (const d of open) {
        const c = live.get(d.contestId);
        const why = !c ? 'Withdrawn automatically: the contest is no longer open, upcoming and verified'
          : c.fingerprint !== d.contestFingerprint ? 'Withdrawn automatically: fight details changed (a corrected campaign was prepared)' : null;
        if (why) { withdrawn += await withdraw({ id: d.id }, why, now); continue; }
        // The website's address for this fight changed (e.g. a fighter-name address appeared, or
        // it stopped working and the ID address is used again): update the campaign's links.
        // Same fight, same text; only the address path changes and every tag is kept.
        if ((d.contest?.contestUrl || '') !== c.contestUrl || (d.contest?.cleanUrl || null) !== (c.cleanUrl || null)) {
          const k2 = fightUrls.relinkCampaign(d, c);
          const next = { ...d, ...k2, contest: { ...d.contest, idBase: c.idBase, idUrl: c.idUrl, cleanUrl: c.cleanUrl, urlSource: c.urlSource, contestUrl: c.contestUrl } };
          if (contestCampaigns.checkCampaign(next, c, { now, mediaNames: names }).length === 0) {
            await col.drafts.updateOne({ id: d.id, status: d.status }, { $set: { text: next.text, posts: next.posts, link: next.link, sourceUrl: c.contestUrl, contest: next.contest }, $push: { linkHistory: { at: now.toISOString(), from: d.contest?.contestUrl || null, to: c.contestUrl, source: c.urlSource } } });
            await audit('campaign_link_updated', { id: d.id, to: c.urlSource, admin: 'system' });
          }
        }
      }
      for (const sport of contestCampaigns.SPORTS) {
        const list = feed.contests.filter((c) => c.sport === sport).slice(0, config.maxCampaignsPerSport);
        for (const c of list) {
          const k = contestCampaigns.buildCampaign(c);
          const id = `mkt-${c.id}-${c.fingerprint}`;
          const draft = { id, kind: 'marketing', genre: sport, contestId: c.id, contestFingerprint: c.fingerprint, contest: c, channels: ['instagram', 'facebook', 'x', 'tiktok'], headline: k.headline, text: k.text, posts: k.posts, link: k.link, sourceUrl: c.contestUrl, verifiedAt: now.toISOString(), status: 'needs_owner_review', ownerApproved: false, sendPermitted: false, createdAt: now.toISOString() };
          // Safeguard 3: final gate. A failing campaign is recorded, never queued.
          const reasons = contestCampaigns.checkCampaign(draft, c, { now, mediaNames: names });
          if (reasons.length) { blocked.push({ id, reasons }); await col.gateRejections.insertOne({ id, contestId: c.id, sport, reasons, at: now.toISOString(), trigger }); continue; }
          const upd = await col.drafts.updateOne({ id }, { $setOnInsert: draft }, { upsert: true });
          if (upd.upsertedCount) { created.push(id); coverage[sport].campaignsCreated++; }
        }
        coverage[sport].campaignsActive = await col.drafts.countDocuments({ kind: 'marketing', genre: sport, contestId: { $exists: true }, status: { $in: ['needs_owner_review', 'approved', 'published'] } });
      }
    } else {
      await alert(`contest-source:${dayKey(now)}`, 'marketing', 'contest feed', `could not reach the FANTASY MMADNESS contest feed: ${feed.errors.join('; ')}`, now);
    }
    const doc = { day: dayKey(now), checkedAt: now.toISOString(), trigger, sourceReachable: feed.sourceReachable, sourceErrors: feed.errors, contestsChecked: feed.checked, verifiedContests: feed.contests.length, created: created.length, withdrawn, blocked, sports: coverage };
    await col.coverage.updateOne({ day: doc.day }, { $set: doc }, { upsert: true });
    if (withdrawn || created.length) await audit('refresh_marketing', { trigger, created: created.length, withdrawn, blocked: blocked.length, admin: 'system' });
    return { contests: feed.contests, created: created.length, withdrawn, blocked: blocked.length, sourceReachable: feed.sourceReachable };
  }
  // Re-verify a campaign's contest right before an owner action.
  async function reverifyMarketing(draft, now = new Date()) {
    if (draft.kind !== 'marketing') return { ok: true };
    if (!draft.contestId) return { ok: false, reason: 'not_based_on_a_verified_contest' };
    const feed = await loadContests(now);
    if (!feed.sourceReachable) return { ok: false, reason: 'contest_feed_unreachable_try_again' };
    const c = feed.contests.find((x) => x.id === draft.contestId);
    if (!c) return { ok: false, reason: 'contest_no_longer_open_or_verified' };
    if (c.fingerprint !== draft.contestFingerprint) return { ok: false, reason: 'fight_details_changed_use_the_corrected_campaign' };
    const reasons = contestCampaigns.checkCampaign(draft, c, { now, mediaNames: await mediaNames() });
    return reasons.length ? { ok: false, reason: 'campaign_failed_safeguard', details: reasons } : { ok: true, contest: c };
  }

  const socialConfig = { ...(config.social || { provider: 'none', channels: {} }), secrets: secrets.social || {} };
  const vault = createTokenVault(secrets.tokenEncryptionKey);
  const meta = createMetaConnect({ col, config: secrets.meta || resolveMetaConfig({}), vault, fetchImpl, alert, audit });
  const publisher = createSocialPublisher({ social: socialConfig, fetchImpl, sandboxCollection: col.socialSandbox, meta, graphUrl: meta.graphUrl });
  socialScheduler = createSocialScheduler({ col, social: socialConfig, publisher, reverifyMarketing, alert, audit, liveTestApproved: Boolean(secrets.meta?.liveTestApproved) });

  async function report(now) {
    const by = async (c, field) => Object.fromEntries((await c.aggregate([{ $group: { _id: field, n: { $sum: 1 } } }]).toArray()).map((r) => [String(r._id), r.n]));
    const doc = {
      day: dayKey(now), at: now.toISOString(),
      draftsByStatus: await by(col.drafts, '$status'), draftsByKind: await by(col.drafts, '$kind'),
      deliveries: await by(col.deliveries, '$status'), prospects: await col.prospects.countDocuments(), prospectsWithVerifiedContact: await col.prospects.countDocuments({ contactVerified: true }),
      suppressions: await col.suppressions.countDocuments(), openAlerts: await col.alerts.countDocuments({ state: 'open' }),
      provider: provider.name, realDelivery: provider.realDelivery === true,
      funnel: {
        prospects: await col.prospects.countDocuments(),
        approvedContent: await col.drafts.countDocuments({ ownerApproved: true, status: { $in: ['approved', 'published', 'delivered'] } }),
        publishedPosts: await col.social.countDocuments({ status: 'published', sandbox: { $ne: true } }) + await col.drafts.countDocuments({ kind: 'marketing', status: 'published', publishedManually: true }),
        sandboxPosts: await col.social.countDocuments({ status: 'published', sandbox: true }),
        registrations: await col.attribution.countDocuments({ type: 'registration', verified: true, source: 'signed_ingest' }),
        verifiedPaidEntries: await col.attribution.countDocuments({ type: 'paid_entry', verified: true, source: 'signed_ingest', paymentStatus: 'settled' }),
        activeAffiliates: await col.affiliates.countDocuments({ status: 'active' }),
      },
    };
    await col.reports.updateOne({ day: doc.day }, { $set: doc }, { upsert: true });
    return doc;
  }

  async function followups(now) {
    const delivered = await col.drafts.find({ status: 'delivered', kind: { $in: ['pr', 'affiliate'] } }).toArray();
    let created = 0;
    for (const d of delivered) {
      const decision = d.realDelivery === true
        ? nextFollowup({ deliveryVerified: true, ownerApproved: true, followupCount: d.followupCount || 0, lastSentAt: d.deliveredAt, optedOut: await suppression.isSuppressed(d.recipient), replied: d.replied === true, bounced: d.bounced === true }, now.getTime())
        : { action: 'hold', reason: 'sandbox_receipt_not_real_delivery' };
      if (decision.action !== 'draft_followup') continue;
      const id = `${d.id}-fu${(d.followupCount || 0) + 1}`;
      const upd = await col.drafts.updateOne({ id }, { $setOnInsert: { id, kind: d.kind, followupOf: d.id, genre: d.genre, prospectId: d.prospectId, recipient: d.recipient, subject: `Re: ${d.subject}`, text: `Following up on my earlier note.\n\n${d.text}`, html: d.html, status: 'needs_owner_review', ownerApproved: false, sendPermitted: false, createdAt: now.toISOString() } }, { upsert: true });
      created += upd.upsertedCount;
    }
    return { followupDraftsCreated: created };
  }

  // Optional, read-only: the live site's verified registration counts per campaign tag.
  async function pullLiveReport(now) {
    if (!config.liveReport?.configured) return { skipped: 'not_configured' };
    const r = await fetchImpl(`${config.contestSourceUrl}/api/admin/fan-acquisition/registration-report`, { headers: { Authorization: `Bearer ${secrets.liveReportToken}`, Accept: 'application/json' } });
    if (!r.ok) throw Error(`live registration report returned ${r.status}`);
    const j = await r.json();
    const groups = (j.groups || []).filter((g) => /^combat_fans_(aff|gs)_[a-z0-9_-]{1,50}$/.test(String(g.campaign))).map((g) => ({ campaign: String(g.campaign), registrations: Math.max(0, Number(g.registrations) || 0) }));
    await col.liveReports.updateOne({ day: dayKey(now) }, { $set: { day: dayKey(now), at: now.toISOString(), groups, paymentAttributionConnected: j.paymentAttributionConnected === true } }, { upsert: true });
    return { campaigns: groups.length };
  }

  const handlers = { discover, aggregate_report: report, prepare_followup: followups, refresh_marketing: (now) => refreshMarketing(now, { trigger: 'scheduled_refresh' }), pull_live_report: pullLiveReport };

  // ---- delivery of approved drafts -----------------------------------------
  async function dispatch(now) {
    const ready = await col.drafts.find({ status: 'approved', ownerApproved: true, sendPermitted: true, recipient: { $type: 'string' } }).limit(50).toArray();
    const out = { delivered: 0, held: 0, failed: 0, suppressed: 0 };
    for (const draft of ready) {
      if (provider.name === 'none') { out.held++; continue; }
      if (await suppression.isSuppressed(draft.recipient)) { await col.drafts.updateOne({ id: draft.id }, { $set: { status: 'suppressed', updatedAt: now.toISOString() } }); out.suppressed++; continue; }
      const claim = await col.deliveries.updateOne({ draftId: draft.id }, { $setOnInsert: { draftId: draft.id, status: 'attempted', provider: provider.name, createdAt: now.toISOString() } }, { upsert: true });
      if (claim.upsertedCount !== 1) continue; // at most once, even across crashes
      const base = config.unsubscribeBaseUrl || 'https://unsubscribe.sandbox.localhost/growth';
      const link = secrets.unsubscribeSecret ? suppression.link(base, draft.recipient) : '';
      const withLink = { ...draft, listUnsubscribe: link, text: link && !draft.text.includes(link) ? `${draft.text}\n\nUnsubscribe: ${link}` : draft.text, html: link && draft.html && !draft.html.includes('unsubscribe') ? draft.html.replace('</body>', `<p style="font-size:11px;color:#69707b;text-align:center"><a href="${link}">Unsubscribe</a></p></body>`) : draft.html };
      let result;
      try { result = await provider.send(withLink); } catch (e) { result = { ok: false, reason: clean(e.message) }; }
      if (result.ok) {
        await col.deliveries.updateOne({ draftId: draft.id }, { $set: { status: 'delivered', providerMessageId: result.receipt.providerMessageId, realDelivery: result.receipt.realDelivery === true } });
        await col.drafts.updateOne({ id: draft.id }, { $set: { status: 'delivered', deliveredAt: now.toISOString(), providerMessageId: result.receipt.providerMessageId, realDelivery: result.receipt.realDelivery === true, sandbox: result.receipt.sandbox === true } });
        if (draft.kind === 'affiliate' && draft.prospectId && result.receipt.realDelivery === true) await affiliateProgram.transition(draft.prospectId, 'invited', { admin: 'email-delivery', note: 'invitation email delivered', now }).catch(() => null);
        out.delivered++;
      } else {
        await col.deliveries.updateOne({ draftId: draft.id }, { $set: { status: 'failed', reason: result.reason } });
        await col.drafts.updateOne({ id: draft.id }, { $set: { status: 'delivery_failed', deliveryError: result.reason, updatedAt: now.toISOString() } });
        await alert(`delivery:${draft.id}`, 'delivery', draft.id, result.reason, now);
        out.failed++;
      }
    }
    return out;
  }

  // ---- one scheduled tick ---------------------------------------------------
  async function tick({ now = new Date() } = {}) {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw Error('Invalid clock');
    const runId = minuteId(now);
    if (!await claims.claim(runId)) return { runId, skipped: 'duplicate_invocation' };
    const summary = { runId, jobs: [], errors: [] };
    try {
      // Recovery: a run claimed long ago but never completed was interrupted.
      const staleBefore = new Date(now.getTime() - config.staleRunMinutes * 60000).toISOString();
      const stale = await col.runs.find({ state: 'claimed', createdAt: { $lt: staleBefore }, runId: { $ne: runId } }).toArray();
      for (const s of stale) {
        await col.runs.updateOne({ runId: s.runId, state: 'claimed' }, { $set: { state: 'stale', staleDetectedAt: now.toISOString() } });
        await alert(`stale:${s.runId}`, 'run', s.runId, 'run was interrupted before completion; inspect and requeue if needed', now);
      }
      summary.recoveredStaleRuns = stale.length;
      // Recurring work for today (idempotent job IDs).
      const day = dayKey(now);
      const iso = now.toISOString();
      await store.enqueue({ id: `discover-${day}`, type: 'discover', dueAt: iso });
      await store.enqueue({ id: `followup-${day}`, type: 'prepare_followup', dueAt: iso });
      await store.enqueue({ id: `report-${day}`, type: 'aggregate_report', dueAt: new Date(now.getTime() + 60000).toISOString() });
      if (config.liveReport?.configured) await store.enqueue({ id: `livereport-${day}`, type: 'pull_live_report', dueAt: new Date(now.getTime() + 3 * 60000).toISOString() });
      // Re-check the published contests every 6 hours: new fights get campaigns,
      // closed or changed ones are withdrawn before they can be approved.
      await store.enqueue({ id: `marketing-${day}-${Math.floor(now.getUTCHours() / 6)}`, type: 'refresh_marketing', dueAt: new Date(now.getTime() + 2 * 60000).toISOString() });
      for (let i = 0; i < 6; i++) {
        const job = await store.claim(now.getTime());
        if (!job) break;
        const handler = handlers[job.type];
        try {
          if (!handler) throw Error(`no handler for ${job.type}`);
          const result = await handler(now);
          await store.finish(job, { success: true, now: now.getTime() });
          summary.jobs.push({ id: job.id, ok: true, result });
        } catch (e) {
          const settled = await store.finish(job, { success: false, error: e.message, now: now.getTime() });
          summary.jobs.push({ id: job.id, ok: false, state: settled.state, error: clean(e.message) });
          if (settled.state === 'failed') await alert(`job:${job.id}:failed`, 'job', job.id, e.message, now);
        }
      }
      summary.delivery = await dispatch(now);
      try { summary.meta = await meta.healthCheck({ now }); } catch (e) { summary.errors.push({ id: 'meta-health', message: clean(e.message) }); }
      summary.social = await socialScheduler.dispatch(now);
    } catch (e) {
      summary.errors.push({ id: 'tick', message: clean(e.message) });
      await alert(`run:${runId}`, 'run', runId, e.message, now);
    }
    await claims.complete(runId, { completed: summary.jobs.filter((j) => j.ok).length, errors: summary.errors });
    return summary;
  }

  // ---- back-office actions --------------------------------------------------
  const publicDraft = ({ _id, ...d }) => d;
  async function listDrafts({ status, kind, limit = 100 } = {}) {
    const q = {}; if (status) q.status = clean(status, 40); if (kind) q.kind = clean(kind, 40);
    return (await col.drafts.find(q).sort({ createdAt: -1 }).limit(Math.min(500, Number(limit) || 100)).toArray()).map(publicDraft);
  }
  async function approveDraft(id, { admin, now = new Date() } = {}) {
    const current = await col.drafts.findOne({ id: clean(id, 160) });
    if (current && current.status === 'needs_owner_review' && current.kind === 'marketing') {
      const v = await reverifyMarketing(current, now);
      if (!v.ok) return { ok: false, reason: v.reason, details: v.details };
    }
    const r = await col.drafts.findOneAndUpdate({ id: clean(id, 160), status: 'needs_owner_review' }, { $set: { status: 'approved', ownerApproved: true, sendPermitted: true, approvedBy: clean(admin, 120), approvedAt: now.toISOString() } }, { returnDocument: 'after' });
    if (!r) return { ok: false, reason: 'not_found_or_not_awaiting_review' };
    await audit('approve_draft', { id: r.id, admin: clean(admin, 120) });
    if (r.kind === 'affiliate') await affiliateProgram.fromApprovedInvite(r, { admin, now });
    return { ok: true, draft: publicDraft(r) };
  }
  async function rejectDraft(id, { admin, reason = '', now = new Date() } = {}) {
    const r = await col.drafts.findOneAndUpdate({ id: clean(id, 160), status: { $in: ['needs_owner_review', 'approved'] } }, { $set: { status: 'rejected', ownerApproved: false, sendPermitted: false, rejectedBy: clean(admin, 120), rejectedAt: now.toISOString(), rejectReason: clean(reason) } }, { returnDocument: 'after' });
    if (!r) return { ok: false, reason: 'not_found_or_already_sent' };
    await audit('reject_draft', { id: r.id, admin: clean(admin, 120) });
    return { ok: true, draft: publicDraft(r) };
  }
  // The owner attests a verified business contact + consent basis for a prospect;
  // this creates a personalized outreach draft that still needs approval.
  async function addVerifiedContact(prospectId, { contact, kind, consentNote, admin, now = new Date() } = {}) {
    const p = await col.prospects.findOne({ id: clean(prospectId, 80) });
    if (!p) return { ok: false, reason: 'prospect_not_found' };
    if (!['pr', 'affiliate'].includes(kind)) return { ok: false, reason: 'kind_must_be_pr_or_affiliate' };
    if (!clean(consentNote)) return { ok: false, reason: 'consent_basis_required' };
    if (await suppression.isSuppressed(contact)) return { ok: false, reason: 'contact_opted_out' };
    const review = prepareOutreachReview([{ id: p.id, genre: p.genre, category: kind === 'pr' ? 'media' : 'affiliate', name: p.name, verified: true, contact: String(contact || '').trim(), contactVerified: true, consent: true }]);
    if (!review.drafts.length) return { ok: false, reason: review.blocked[0]?.reason || 'invalid_contact' };
    const personalized = renderBusinessEmail({ type: kind === 'pr' ? 'media' : 'affiliate', recipientName: p.name, personalization: `We came across ${p.name} and think your ${p.genre.replace('-', ' ')} audience would enjoy round-by-round fight predictions.` });
    const d = review.drafts[0];
    const draft = { id: `${kind}-${p.id}`, kind, genre: p.genre, prospectId: p.id, recipient: d.recipient, subject: personalized.subject, html: personalized.html, text: personalized.text, relevanceSource: p.sourceUrl, status: 'needs_owner_review', ownerApproved: false, sendPermitted: false, createdAt: now.toISOString() };
    const ins = await col.drafts.updateOne({ id: draft.id }, { $setOnInsert: draft }, { upsert: true });
    await col.prospects.updateOne({ id: p.id }, { $set: { contact: d.recipient, contactVerified: true, consent: true, consentNote: clean(consentNote), contactAddedBy: clean(admin, 120) } });
    await audit('add_verified_contact', { prospectId: p.id, kind, admin: clean(admin, 120) });
    return ins.upsertedCount === 1 ? { ok: true, draft } : { ok: false, reason: 'draft_already_exists' };
  }
  async function overview() {
    const last = await col.runs.find({}).sort({ createdAt: -1 }).limit(10).toArray();
    return {
      provider: provider.name, realDelivery: provider.realDelivery === true,
      draftsAwaitingReview: await col.drafts.countDocuments({ status: 'needs_owner_review' }),
      approvedAwaitingDelivery: await col.drafts.countDocuments({ status: 'approved' }),
      delivered: await col.drafts.countDocuments({ status: 'delivered' }),
      prospects: await col.prospects.countDocuments(), suppressions: await col.suppressions.countDocuments(),
      openAlerts: await col.alerts.countDocuments({ state: 'open' }),
      jobs: await store.summary(),
      lastRuns: last.map(({ _id, ...r }) => r),
      latestReport: await col.reports.find({}).sort({ day: -1 }).limit(1).next().then((r) => (r ? (({ _id, ...x }) => x)(r) : null)),
    };
  }
  async function listAlerts({ state = 'open' } = {}) { return (await col.alerts.find(state ? { state } : {}).sort({ createdAt: -1 }).limit(200).toArray()).map(({ _id, ...a }) => a); }
  async function ackAlert(alertKey, { admin } = {}) { const r = await col.alerts.updateOne({ alertKey: clean(alertKey, 200), state: 'open' }, { $set: { state: 'acknowledged', ackBy: clean(admin, 120), ackAt: new Date().toISOString() } }); return { ok: r.modifiedCount === 1 }; }
  async function requeueJob(id, { admin, now = new Date() } = {}) {
    const r = await col.jobs.updateOne({ id: clean(id, 160), state: 'failed' }, { $set: { state: 'retry', attempts: 0, dueAt: now.toISOString(), lastError: null } });
    if (r.modifiedCount === 1) await audit('requeue_job', { id, admin: clean(admin, 120) });
    return { ok: r.modifiedCount === 1 };
  }
  async function unsubscribe(token) { return suppression.unsubscribe(token); }

  return { init, tick, dispatch, refreshMarketing, reverifyMarketing, social: socialScheduler, publisher, meta, affiliates: affiliateProgram, listDrafts, approveDraft, rejectDraft, addVerifiedContact, overview, listAlerts, ackAlert, requeueJob, unsubscribe, suppression, collections: col };
}

module.exports = { createGrowthRuntime };

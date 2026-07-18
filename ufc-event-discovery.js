'use strict';

/**
 * Google News -> UFC upcoming event discovery.
 *
 * This module intentionally stays additive: it reuses the existing Match model,
 * the existing rss-parser instance, and the existing backend -> Swarm hook.
 */

const GOOGLE_NEWS_UFC_RSS_FEED_URL = 'https://news.google.com/rss/search?q=UFC%20OR%20%22UFC%20Fight%20Night%22&hl=en-US&gl=US&ceid=US:en';
const DEFAULT_DISCOVERY_CRON = '17 */6 * * *';
const GOOGLE_NEWS_PROVIDER = 'google_news_rss';
const OFFICIAL_UFC_PROVIDER = 'official_ufc';

const MONTHS = Object.freeze({
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
});

const EVENT_INTENT_PATTERNS = Object.freeze([
  /\bannounc(?:e|es|ed|ing|ement)\b/i,
  /\bmain event\b/i,
  /\bfight card\b/i,
  /\bcard announcement\b/i,
  /\bset for\b/i,
  /\btargeted for\b/i,
  /\bbooked for\b/i,
  /\bscheduled for\b/i,
  /\bheaded to\b/i,
  /\breturns? to\b/i,
  /\bdate(?: and|,)? location\b/i,
  /\bvenue\b/i,
]);

const LOW_VALUE_ARTICLE_PATTERNS = Object.freeze([
  /\brankings?\b/i,
  /\binterview\b/i,
  /\binjur(?:y|ies|ed)\b/i,
  /\broster\b/i,
  /\breleased?\b/i,
  /\bsigns? with\b/i,
  /\bopinion\b/i,
  /\bmailbag\b/i,
  /\bpodcast\b/i,
  /\bodds\b/i,
  /\bbetting\b/i,
  /\bpicks?\b/i,
  /\bprediction(?:s)?\b/i,
  /\brecap\b/i,
  /\bresults?\b/i,
  /\bpost[-\s]?fight\b/i,
]);

function registerUfcEventDiscovery(options = {}) {
  const {
    app,
    cron,
    parser,
    fetch,
    Match,
    Notification,
    verifyAdminToken,
    triggerUpcomingEventAutomationForMatch,
    clearPublicResponseCache,
    logger = console,
  } = options;

  if (!app || !parser || !Match) {
    throw new Error('registerUfcEventDiscovery requires app, parser, and Match.');
  }

  let isRunning = false;
  let lastRun = null;
  let lastError = null;
  let scheduledTask = null;

  const runRefresh = async (requestOptions = {}) => {
    if (isRunning) {
      return {
        ok: false,
        skipped: true,
        reason: 'ufc-event-discovery-already-running',
        lastRun,
        lastError,
      };
    }

    isRunning = true;
    try {
      const result = await refreshUpcomingUfcEvents({
        parser,
        fetch,
        Match,
        Notification,
        triggerUpcomingEventAutomationForMatch,
        clearPublicResponseCache,
        logger,
        ...requestOptions,
      });
      lastRun = result;
      lastError = null;
      return result;
    } catch (error) {
      lastError = summarizeError(error);
      logger.error?.('UFC event discovery refresh failed:', error);
      throw error;
    } finally {
      isRunning = false;
    }
  };

  const cronEnabled = parseBoolean(process.env.UFC_EVENT_DISCOVERY_CRON_ENABLED, true);
  const cronExpression = cleanString(process.env.UFC_EVENT_DISCOVERY_CRON || DEFAULT_DISCOVERY_CRON);
  const cronTimezone = resolveCronTimezone([
    process.env.UFC_EVENT_DISCOVERY_TIMEZONE,
    process.env.TZ,
    'America/New_York',
  ], logger);

  if (cronEnabled && cron && typeof cron.schedule === 'function') {
    scheduledTask = cron.schedule(cronExpression, () => {
      runRefresh({ reason: 'scheduled-cron' }).catch((error) => {
        logger.error?.('Scheduled UFC event discovery failed:', error.message || error);
      });
    }, {
      timezone: cronTimezone,
    });
  }

  if (parseBoolean(process.env.UFC_EVENT_DISCOVERY_RUN_ON_START, false)) {
    setTimeout(() => {
      runRefresh({ reason: 'server-startup' }).catch((error) => {
        logger.error?.('Startup UFC event discovery failed:', error.message || error);
      });
    }, Number(process.env.UFC_EVENT_DISCOVERY_STARTUP_DELAY_MS || 15000));
  }

  const verifyCronOrAdmin = (req, res, next) => {
    const configuredSecret = cleanString(process.env.UFC_EVENT_DISCOVERY_CRON_SECRET || process.env.CRON_SECRET);
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const headerSecret = cleanString(req.headers['x-cron-secret'] || req.headers['x-ufc-event-discovery-secret']);
    if (configuredSecret && (bearer === configuredSecret || headerSecret === configuredSecret || req.query.secret === configuredSecret)) {
      req.admin = { id: null, cron: true, source: 'ufc-event-discovery-cron' };
      return next();
    }
    if (typeof verifyAdminToken === 'function') return verifyAdminToken(req, res, next);
    return res.status(401).json({ ok: false, message: 'Admin authentication is required.' });
  };

  app.get('/api/admin/ufc-event-discovery/status', verifyCronOrAdmin, (req, res) => {
    res.json({
      ok: true,
      provider: GOOGLE_NEWS_PROVIDER,
      feedUrl: getDiscoveryFeedUrl(),
      cronEnabled,
      cronExpression,
      cronTimezone,
      isRunning,
      lastRun,
      lastError,
    });
  });

  app.post('/api/admin/ufc-event-discovery/refresh', verifyAdminToken || verifyCronOrAdmin, async (req, res) => {
    try {
      const result = await runRefresh({
        reason: 'admin-manual-refresh',
        forceSwarm: req.body?.forceSwarm,
        dryRun: req.body?.dryRun,
        limit: req.body?.limit,
      });
      res.status(result.skipped ? 202 : 200).json(result);
    } catch (error) {
      res.status(500).json({ ok: false, message: 'UFC event discovery refresh failed.', error: summarizeError(error) });
    }
  });

  app.get('/api/cron/ufc-event-discovery', verifyCronOrAdmin, async (req, res) => {
    try {
      const result = await runRefresh({ reason: 'cron-http-endpoint', limit: req.query.limit });
      res.status(result.skipped ? 202 : 200).json(result);
    } catch (error) {
      res.status(500).json({ ok: false, message: 'UFC event discovery cron refresh failed.', error: summarizeError(error) });
    }
  });

  return {
    runRefresh,
    getStatus: () => ({ isRunning, lastRun, lastError, scheduledTask: Boolean(scheduledTask) }),
  };
}

async function refreshUpcomingUfcEvents(options = {}) {
  const {
    parser,
    fetch,
    Match,
    Notification,
    triggerUpcomingEventAutomationForMatch,
    clearPublicResponseCache,
    logger = console,
    reason = 'manual',
    dryRun = false,
  } = options;

  if (!parser || typeof parser.parseURL !== 'function') {
    throw new Error('A configured rss-parser instance is required.');
  }
  if (!Match) throw new Error('Match model is required.');

  const feedUrl = getDiscoveryFeedUrl();
  const feed = await parser.parseURL(feedUrl);
  const rawItems = Array.isArray(feed?.items) ? feed.items : [];
  const limit = clampNumber(Number(options.limit || process.env.UFC_EVENT_DISCOVERY_MAX_ITEMS || 35), 1, 100);
  const items = rawItems.slice(0, limit);
  const now = new Date();
  const candidates = [];
  const created = [];
  const updated = [];
  const skipped = [];
  const errors = [];
  let cacheInvalidated = false;

  for (const item of items) {
    let candidate = parseUfcEventCandidateFromRssItem(item, { now });
    if (!candidate) {
      skipped.push({ reason: 'not-a-supported-ufc-event-article', title: cleanString(item?.title) });
      continue;
    }

    try {
      candidate = await maybeEnrichCandidateWithOfficialUfcPage(candidate, { fetch, logger });
      candidates.push(candidate);

      const sufficiency = hasSufficientEventData(candidate, { now });
      if (!sufficiency.ok) {
        skipped.push({ reason: sufficiency.reason, title: candidate.title, eventName: candidate.eventName, confidence: candidate.confidence });
        continue;
      }

      if (dryRun === true || String(dryRun).toLowerCase() === 'true') {
        skipped.push({ reason: 'dry-run', title: candidate.title, eventName: candidate.eventName, confidence: candidate.confidence, candidate });
        continue;
      }

      const result = await upsertDiscoveredUfcEvent({
        candidate,
        Match,
        Notification,
        triggerUpcomingEventAutomationForMatch,
        logger,
        forceSwarm: options.forceSwarm,
        reason,
      });

      if (result.action === 'created') created.push(result);
      else if (result.action === 'updated') updated.push(result);
      else skipped.push(result);
      if (result.action === 'created' || result.action === 'updated') cacheInvalidated = true;
    } catch (error) {
      errors.push({ title: cleanString(item?.title), error: summarizeError(error) });
    }
  }

  if (cacheInvalidated && typeof clearPublicResponseCache === 'function') clearPublicResponseCache();

  return {
    ok: errors.length === 0,
    provider: GOOGLE_NEWS_PROVIDER,
    feedUrl,
    reason,
    fetchedItems: rawItems.length,
    inspectedItems: items.length,
    candidateCount: candidates.length,
    createdCount: created.length,
    updatedCount: updated.length,
    skippedCount: skipped.length,
    errorCount: errors.length,
    created,
    updated,
    skipped,
    errors,
    generatedAt: new Date().toISOString(),
  };
}

function getDiscoveryFeedUrl() {
  return cleanString(process.env.UFC_EVENT_DISCOVERY_RSS_URL || process.env.UFC_NEWS_RSS_URL) || GOOGLE_NEWS_UFC_RSS_FEED_URL;
}

function parseUfcEventCandidateFromRssItem(item = {}, options = {}) {
  const title = stripGoogleNewsSourceSuffix(cleanText(item.title || ''));
  const description = cleanText(item.contentSnippet || item.content || item.summary || item.description || '');
  const combined = `${title}. ${description}`.replace(/\s+/g, ' ').trim();
  const articleUrl = cleanString(item.link || item.guid || '');
  const source = getRssItemSource(item, articleUrl);

  if (!combined) return null;

  const eventNumber = extractUfcEventNumber(combined);
  const isFightNight = /\b(?:UFC\s+)?Fight\s+Night\b/i.test(combined);
  const isNoche = /\bNoche\s+UFC\b/i.test(combined);
  const hasFightCardSignal = /\bfight\s+card\b/i.test(combined);
  const hasMainEventSignal = /\bmain\s+event\b/i.test(combined);
  const hasAnnouncementSignal = EVENT_INTENT_PATTERNS.some((pattern) => pattern.test(combined));
  const lowValueSignal = LOW_VALUE_ARTICLE_PATTERNS.some((pattern) => pattern.test(combined));

  if (!eventNumber && !isFightNight && !isNoche && !hasFightCardSignal && !hasMainEventSignal) return null;
  if (lowValueSignal && !eventNumber && !isFightNight && !isNoche && !hasAnnouncementSignal) {
    return null;
  }

  const fighterPair = extractFighterPair(combined);
  const eventName = buildEventName({ title, combined, eventNumber, isFightNight, isNoche, fighterPair });
  if (!eventName) return null;

  const dateResult = extractEventDate(combined, options);
  const timeResult = extractEventTime(combined);
  const location = extractVenueAndCity(combined);
  const officialEventUrl = extractOfficialUfcEventUrl(combined) || (isOfficialUfcUrl(articleUrl) ? articleUrl : '');
  const eventType = isNoche ? 'noche_ufc' : (eventNumber ? 'numbered' : (isFightNight ? 'fight_night' : 'ufc_event'));

  const candidate = {
    title,
    description,
    eventName,
    eventNumber,
    eventType,
    eventDate: dateResult?.date || null,
    eventDateConfidence: dateResult?.confidence || 0,
    matchTime: timeResult?.matchTime || '',
    fighters: fighterPair ? [fighterPair.fighterA, fighterPair.fighterB] : [],
    fighterA: fighterPair?.fighterA || '',
    fighterB: fighterPair?.fighterB || '',
    venue: location.venue || '',
    city: location.city || '',
    articleSource: source,
    articleUrl,
    officialEventUrl,
    provider: GOOGLE_NEWS_PROVIDER,
    publishedAt: parseDateLike(item.isoDate || item.pubDate || item.published || item.updated) || null,
    confidence: 0,
    discoveryKey: '',
    raw: {
      guid: item.guid,
      pubDate: item.pubDate,
      isoDate: item.isoDate,
      source: item.source,
    },
  };

  candidate.confidence = scoreCandidate(candidate, { eventNumber, isFightNight, isNoche, hasFightCardSignal, hasMainEventSignal, hasAnnouncementSignal, lowValueSignal });
  candidate.discoveryKey = buildDiscoveryKey(candidate);

  return candidate.confidence > 0 ? candidate : null;
}

function scoreCandidate(candidate, signals = {}) {
  let score = 0;
  if (signals.eventNumber) score += 35;
  if (signals.isFightNight) score += 35;
  if (signals.isNoche) score += 35;
  if (signals.hasFightCardSignal) score += 10;
  if (signals.hasMainEventSignal) score += 15;
  if (signals.hasAnnouncementSignal) score += 15;
  if (candidate.eventDate) score += 25;
  if (candidate.fighterA && candidate.fighterB) score += 20;
  if (candidate.venue || candidate.city) score += 10;
  if (candidate.officialEventUrl || /\bufc\.com\b/i.test(candidate.articleSource || '')) score += 20;
  if (signals.lowValueSignal && !signals.hasAnnouncementSignal) score -= 25;
  if (!candidate.eventName) score -= 50;
  return clampNumber(score, 0, 100);
}

function hasSufficientEventData(candidate = {}, options = {}) {
  const minimumConfidence = clampNumber(Number(process.env.UFC_EVENT_DISCOVERY_MIN_CONFIDENCE || 55), 1, 100);
  const requireDate = parseBoolean(process.env.UFC_EVENT_DISCOVERY_REQUIRE_DATE, true);
  const allowPastDays = clampNumber(Number(process.env.UFC_EVENT_DISCOVERY_ALLOW_PAST_DAYS || 3), 0, 365);

  if (!candidate.eventName) return { ok: false, reason: 'missing-event-name' };
  if (!candidate.discoveryKey) return { ok: false, reason: 'missing-deduplication-key' };
  if (candidate.confidence < minimumConfidence) return { ok: false, reason: `low-confidence-${candidate.confidence}` };
  if (requireDate && !candidate.eventDate) return { ok: false, reason: 'missing-event-date' };

  if (candidate.eventDate) {
    const now = options.now || new Date();
    const earliest = new Date(now.getTime() - allowPastDays * 24 * 60 * 60 * 1000);
    if (candidate.eventDate.getTime() < earliest.getTime()) return { ok: false, reason: 'event-date-is-too-far-in-past' };
  }

  return { ok: true };
}

async function maybeEnrichCandidateWithOfficialUfcPage(candidate = {}, options = {}) {
  const enabled = parseBoolean(process.env.UFC_EVENT_OFFICIAL_ENRICHMENT_ENABLED, true);
  if (!enabled) return candidate;
  const fetchFn = options.fetch;
  if (typeof fetchFn !== 'function') return candidate;

  const officialUrl = cleanString(candidate.officialEventUrl) || (isOfficialUfcUrl(candidate.articleUrl) ? candidate.articleUrl : '');
  if (!officialUrl || !/^https?:\/\//i.test(officialUrl)) return candidate;

  try {
    const enriched = await fetchOfficialUfcEventDetails(officialUrl, { fetch: fetchFn });
    if (!enriched || !Object.keys(enriched).length) return candidate;

    const next = { ...candidate };
    if (enriched.eventName && (!next.eventName || enriched.sourceConfidence >= 80)) next.eventName = enriched.eventName;
    if (enriched.eventDate) {
      next.eventDate = enriched.eventDate;
      next.eventDateConfidence = Math.max(next.eventDateConfidence || 0, 90);
    }
    if (enriched.venue) next.venue = enriched.venue;
    if (enriched.city) next.city = enriched.city;
    if (enriched.officialEventUrl) next.officialEventUrl = enriched.officialEventUrl;
    next.provider = `${GOOGLE_NEWS_PROVIDER}+${OFFICIAL_UFC_PROVIDER}`;
    next.officialEnrichment = enriched;
    next.confidence = clampNumber(Math.max(next.confidence || 0, scoreCandidate(next, {
      eventNumber: next.eventNumber,
      isFightNight: next.eventType === 'fight_night',
      isNoche: next.eventType === 'noche_ufc',
      hasAnnouncementSignal: true,
    }) + 10), 0, 100);
    next.discoveryKey = buildDiscoveryKey(next);
    return next;
  } catch (error) {
    options.logger?.warn?.('Official UFC enrichment failed:', error.message || error);
    return candidate;
  }
}

async function fetchOfficialUfcEventDetails(url, options = {}) {
  const fetchFn = options.fetch;
  if (typeof fetchFn !== 'function') return null;
  const response = await fetchFn(url, {
    timeout: clampNumber(Number(process.env.UFC_EVENT_DISCOVERY_FETCH_TIMEOUT_MS || 6500), 1000, 30000),
    headers: {
      'user-agent': process.env.UFC_EVENT_DISCOVERY_USER_AGENT || 'FantasyMMAdnessBot/1.0 (+https://fantasymmadness.com)',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!response || !response.ok) return null;
  const html = await response.text();
  if (!html) return null;
  return parseOfficialUfcEventHtml(html, url);
}

function parseOfficialUfcEventHtml(html = '', url = '') {
  const result = { officialEventUrl: url, sourceConfidence: 75 };
  const scripts = [...String(html).matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const script of scripts) {
    const raw = decodeHtmlEntities(stripHtml(script[1] || '')).trim();
    const parsed = safeJsonParse(raw);
    const nodes = flattenJsonLdNodes(parsed);
    const eventNode = nodes.find((node) => {
      const type = Array.isArray(node?.['@type']) ? node['@type'].join(' ') : String(node?.['@type'] || '');
      return /Event|SportsEvent/i.test(type);
    });
    if (!eventNode) continue;
    if (eventNode.name) result.eventName = cleanText(eventNode.name);
    const startDate = parseDateLike(eventNode.startDate);
    if (startDate) result.eventDate = startDate;
    const location = eventNode.location || {};
    if (location.name) result.venue = cleanText(location.name);
    const address = location.address || {};
    if (address.addressLocality || address.addressRegion) {
      result.city = [address.addressLocality, address.addressRegion].map(cleanString).filter(Boolean).join(', ');
    }
    result.sourceConfidence = 90;
    break;
  }

  if (!result.eventName) {
    const titleMatch = String(html).match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) result.eventName = stripGoogleNewsSourceSuffix(cleanText(titleMatch[1]));
  }
  if (!result.eventDate) {
    const dateMatch = String(html).match(/<meta[^>]+(?:property|name)=["'](?:event:start_time|startDate|date)["'][^>]+content=["']([^"']+)["']/i);
    const date = dateMatch ? parseDateLike(dateMatch[1]) : null;
    if (date) result.eventDate = date;
  }
  return Object.keys(result).length > 2 ? result : null;
}

async function upsertDiscoveredUfcEvent(options = {}) {
  const {
    candidate,
    Match,
    Notification,
    triggerUpcomingEventAutomationForMatch,
    logger = console,
    forceSwarm = false,
    reason = 'auto-discovery',
  } = options;

  if (!candidate || !Match) throw new Error('candidate and Match are required.');

  const existing = await findExistingMatchForCandidate(candidate, Match);
  const now = new Date();

  if (existing) {
    const beforeUpdatedAt = existing.updatedAt;
    applyCandidateToExistingMatch(existing, candidate, now);
    await existing.save();
    let automation = null;
    if (parseBoolean(forceSwarm, false)) {
      automation = await triggerAutoDiscoveredEventSwarm(triggerUpcomingEventAutomationForMatch, existing, candidate, {
        action: 'auto-ufc-event-updated',
        reason,
      });
    }
    return {
      action: 'updated',
      matchId: String(existing._id),
      eventName: existing.matchName,
      discoveryKey: candidate.discoveryKey,
      previouslyUpdatedAt: beforeUpdatedAt,
      automation,
    };
  }

  const doc = new Match(buildNewMatchPayloadFromCandidate(candidate, now));
  const saved = await doc.save();

  if (Notification) {
    try {
      await new Notification({ title: `Auto UFC Event Added: ${saved.matchName}` }).save();
    } catch (error) {
      logger.warn?.('Auto UFC event notification failed:', error.message || error);
    }
  }

  const automation = await triggerAutoDiscoveredEventSwarm(triggerUpcomingEventAutomationForMatch, saved, candidate, {
    action: 'auto-ufc-event-created',
    reason,
  });

  return {
    action: 'created',
    matchId: String(saved._id),
    eventName: saved.matchName,
    discoveryKey: candidate.discoveryKey,
    automation,
  };
}

async function triggerAutoDiscoveredEventSwarm(triggerFn, match, candidate, context = {}) {
  if (typeof triggerFn !== 'function') return null;
  return triggerFn(match, {
    trigger: 'upcoming_event',
    route: '/api/cron/ufc-event-discovery',
    action: context.action || 'auto-ufc-event-created',
    reason: 'auto-discovered-upcoming-ufc-event',
    warning: 'Auto-discovered UFC event was saved but upcoming-event automation failed.',
    metadata: {
      discoveryProvider: candidate.provider || GOOGLE_NEWS_PROVIDER,
      discoveryKey: candidate.discoveryKey,
      discoveryConfidence: candidate.confidence,
      articleSource: candidate.articleSource,
      articleUrl: candidate.articleUrl,
      officialEventUrl: candidate.officialEventUrl,
      discoveryReason: context.reason,
      source: 'google-news-ufc-event-discovery',
    },
    input: {
      eventName: candidate.eventName,
      eventNumber: candidate.eventNumber,
      eventType: candidate.eventType,
      articleSource: candidate.articleSource,
      articleUrl: candidate.articleUrl,
      officialEventUrl: candidate.officialEventUrl,
      discoveryConfidence: candidate.confidence,
      discoveryProvider: candidate.provider || GOOGLE_NEWS_PROVIDER,
      venue: candidate.venue,
      city: candidate.city,
    },
  });
}

function buildNewMatchPayloadFromCandidate(candidate = {}, now = new Date()) {
  return {
    matchCategory: 'mma',
    matchCategoryTwo: 'MMA',
    matchName: candidate.eventName,
    matchFighterA: candidate.fighterA || '',
    matchFighterB: candidate.fighterB || '',
    matchDescription: buildMatchDescription(candidate),
    matchDate: candidate.eventDate || undefined,
    matchTime: candidate.matchTime || '',
    venue: candidate.venue || candidate.city || '',
    matchType: 'LIVE',
    matchStatus: 'Scheduled',
    matchShadowStatus: 'active',
    matchShadowOpenStatus: 'open',
    matchReward: 'NotRewarded',
    maxRounds: candidate.eventType === 'numbered' || candidate.fighterA ? 5 : undefined,
    matchTokens: 0,
    pot: 0,
    profit: 0,
    homepagePromoted: false,
    homepagePromotionCalendarSource: candidate.provider || GOOGLE_NEWS_PROVIDER,
    homepagePromotionExternalSourceUrl: candidate.articleUrl || candidate.officialEventUrl || '',
    autoDiscovered: true,
    autoDiscoveryProvider: candidate.provider || GOOGLE_NEWS_PROVIDER,
    autoDiscoveryKey: candidate.discoveryKey,
    autoDiscoveryConfidence: candidate.confidence,
    autoDiscoverySource: candidate.articleSource,
    autoDiscoverySourceUrl: candidate.articleUrl,
    autoDiscoveryPayload: candidate,
    autoDiscoveryLastSeenAt: now,
    officialEventUrl: candidate.officialEventUrl || '',
    ufcEventNumber: candidate.eventNumber || undefined,
    ufcEventType: candidate.eventType || '',
    eventCity: candidate.city || '',
  };
}

function applyCandidateToExistingMatch(match, candidate = {}, now = new Date()) {
  const existingWasAutoDiscovered = Boolean(match.autoDiscovered);
  const shouldOverwriteCurated = existingWasAutoDiscovered;

  if (shouldOverwriteCurated || !cleanString(match.matchName)) match.matchName = candidate.eventName || match.matchName;
  if (candidate.fighterA && (shouldOverwriteCurated || !cleanString(match.matchFighterA))) match.matchFighterA = candidate.fighterA;
  if (candidate.fighterB && (shouldOverwriteCurated || !cleanString(match.matchFighterB))) match.matchFighterB = candidate.fighterB;
  if (candidate.eventDate && (shouldOverwriteCurated || !match.matchDate)) match.matchDate = candidate.eventDate;
  if (candidate.matchTime && (shouldOverwriteCurated || !cleanString(match.matchTime))) match.matchTime = candidate.matchTime;
  if ((candidate.venue || candidate.city) && (shouldOverwriteCurated || !cleanString(match.venue))) match.venue = candidate.venue || candidate.city;
  if (candidate.city) match.eventCity = candidate.city;
  if (candidate.officialEventUrl) match.officialEventUrl = candidate.officialEventUrl;
  if (candidate.eventNumber) match.ufcEventNumber = candidate.eventNumber;
  if (candidate.eventType) match.ufcEventType = candidate.eventType;

  if (!cleanString(match.matchCategory)) match.matchCategory = 'mma';
  if (!cleanString(match.matchCategoryTwo)) match.matchCategoryTwo = 'MMA';
  if (!cleanString(match.matchType)) match.matchType = 'LIVE';
  if (!cleanString(match.matchStatus) || String(match.matchStatus).toLowerCase() === 'draft') match.matchStatus = 'Scheduled';
  if (!cleanString(match.matchShadowOpenStatus)) match.matchShadowOpenStatus = 'open';
  if (!cleanString(match.matchDescription) || shouldOverwriteCurated) match.matchDescription = buildMatchDescription(candidate);

  match.autoDiscovered = match.autoDiscovered || false;
  match.autoDiscoveryProvider = candidate.provider || GOOGLE_NEWS_PROVIDER;
  match.autoDiscoveryKey = match.autoDiscoveryKey || candidate.discoveryKey;
  match.autoDiscoveryConfidence = Math.max(Number(match.autoDiscoveryConfidence || 0), Number(candidate.confidence || 0));
  match.autoDiscoverySource = candidate.articleSource || match.autoDiscoverySource;
  match.autoDiscoverySourceUrl = candidate.articleUrl || match.autoDiscoverySourceUrl;
  match.autoDiscoveryPayload = candidate;
  match.autoDiscoveryLastSeenAt = now;
  if (!match.homepagePromotionCalendarSource) match.homepagePromotionCalendarSource = candidate.provider || GOOGLE_NEWS_PROVIDER;
  if (!match.homepagePromotionExternalSourceUrl) match.homepagePromotionExternalSourceUrl = candidate.articleUrl || candidate.officialEventUrl || '';
  return match;
}

function buildMatchDescription(candidate = {}) {
  const parts = [];
  if (candidate.eventName) parts.push(candidate.eventName);
  if (candidate.fighterA && candidate.fighterB) parts.push(`${candidate.fighterA} vs ${candidate.fighterB}`);
  if (candidate.venue || candidate.city) parts.push([candidate.venue, candidate.city].filter(Boolean).join(', '));
  if (candidate.articleSource) parts.push(`Source: ${candidate.articleSource}`);
  return parts.join(' • ');
}

async function findExistingMatchForCandidate(candidate = {}, Match) {
  const filters = [];
  if (candidate.discoveryKey) filters.push({ autoDiscoveryKey: candidate.discoveryKey });
  if (candidate.eventNumber) {
    filters.push({ ufcEventNumber: candidate.eventNumber });
    filters.push({ matchName: new RegExp(`\\bUFC\\s*${escapeRegExp(String(candidate.eventNumber))}\\b`, 'i') });
  }

  const dateWindow = candidate.eventDate ? buildUtcDateWindow(candidate.eventDate, 2) : null;
  if (dateWindow && candidate.eventName) {
    filters.push({
      matchDate: { $gte: dateWindow.start, $lte: dateWindow.end },
      matchName: buildEventNameRegex(candidate.eventName),
    });
  }
  if (dateWindow && candidate.fighterA && candidate.fighterB) {
    filters.push({
      matchDate: { $gte: dateWindow.start, $lte: dateWindow.end },
      $or: [
        { matchFighterA: buildNameRegex(candidate.fighterA), matchFighterB: buildNameRegex(candidate.fighterB) },
        { matchFighterA: buildNameRegex(candidate.fighterB), matchFighterB: buildNameRegex(candidate.fighterA) },
      ],
    });
  }

  for (const filter of filters) {
    const existing = await Match.findOne(filter).sort({ autoDiscovered: -1, updatedAt: -1, createdAt: -1 });
    if (existing) return existing;
  }
  return null;
}

function buildUtcDateWindow(date, days = 2) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  const start = new Date(value.getTime() - days * 24 * 60 * 60 * 1000);
  const end = new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
  return { start, end };
}

function buildEventNameRegex(eventName = '') {
  const normalized = cleanString(eventName).replace(/\s+/g, ' ');
  const number = extractUfcEventNumber(normalized);
  if (number) return new RegExp(`\\bUFC\\s*${escapeRegExp(String(number))}\\b`, 'i');
  if (/noche\s+ufc/i.test(normalized)) return /\bNoche\s+UFC\b/i;
  if (/fight\s+night/i.test(normalized)) return /\bFight\s+Night\b/i;
  return new RegExp(escapeRegExp(normalized.slice(0, 80)), 'i');
}

function buildNameRegex(name = '') {
  const clean = cleanString(name).replace(/[^A-Za-z0-9\s'.-]+/g, '').replace(/\s+/g, ' ').trim();
  return clean ? new RegExp(escapeRegExp(clean), 'i') : /$a/;
}

function buildDiscoveryKey(candidate = {}) {
  if (candidate.eventNumber) return `ufc:${candidate.eventNumber}`;
  const dateKey = candidate.eventDate ? candidate.eventDate.toISOString().slice(0, 10) : 'date-tba';
  if (candidate.eventType === 'noche_ufc') return `noche-ufc:${dateKey}`;
  if (candidate.eventType === 'fight_night') {
    const fighterKey = candidate.fighterA && candidate.fighterB
      ? `${slugify(candidate.fighterA)}-vs-${slugify(candidate.fighterB)}`
      : slugify(candidate.eventName || 'fight-night');
    return `ufc-fight-night:${fighterKey}:${dateKey}`;
  }
  return `ufc-event:${slugify(candidate.eventName || candidate.title)}:${dateKey}`;
}

function extractUfcEventNumber(text = '') {
  const match = String(text).match(/\bUFC\s*(\d{3})\b/i);
  return match ? Number(match[1]) : null;
}

function buildEventName({ title = '', combined = '', eventNumber, isFightNight, isNoche, fighterPair }) {
  const sourceText = title || combined;
  const pairSuffix = fighterPair ? `${fighterPair.fighterA} vs ${fighterPair.fighterB}` : '';

  if (eventNumber) {
    const explicit = sourceText.match(new RegExp(`\\bUFC\\s*${eventNumber}\\s*[:\\-–]\\s*([^|.;]+)`, 'i'));
    if (explicit) {
      const tail = cleanEventTail(explicit[1]);
      if (tail && /\bvs\.?\b|\bversus\b/i.test(tail)) return `UFC ${eventNumber}: ${tail}`;
    }
    return pairSuffix ? `UFC ${eventNumber}: ${pairSuffix}` : `UFC ${eventNumber}`;
  }

  if (isNoche) {
    const explicit = sourceText.match(/\bNoche\s+UFC\s*[:\-–]\s*([^|.;]+)/i);
    if (explicit) {
      const tail = cleanEventTail(explicit[1]);
      if (tail) return `Noche UFC: ${tail}`;
    }
    return pairSuffix ? `Noche UFC: ${pairSuffix}` : 'Noche UFC';
  }

  if (isFightNight) {
    const explicit = sourceText.match(/\b(?:UFC\s+)?Fight\s+Night\s*[:\-–]\s*([^|.;]+)/i);
    if (explicit) {
      const tail = cleanEventTail(explicit[1]);
      if (tail) return `UFC Fight Night: ${tail}`;
    }
    return pairSuffix ? `UFC Fight Night: ${pairSuffix}` : 'UFC Fight Night';
  }

  if (pairSuffix && /\bmain\s+event\b/i.test(combined)) return `UFC Main Event: ${pairSuffix}`;
  return '';
}

function cleanEventTail(value = '') {
  return cleanText(value)
    .replace(/\s+-\s+[^-]{2,50}$/g, '')
    .replace(/\b(?:announced|official|set|targeted|booked|scheduled)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\-–:|\s]+|[\-–:|\s]+$/g, '')
    .slice(0, 90);
}

function extractFighterPair(text = '') {
  const clean = cleanText(text);
  const patterns = [
    /\bmain\s+event\s+(?:between\s+)?([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'`.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'`.-]+){0,3})\s+(?:vs\.?|versus|v\.)\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'`.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'`.-]+){0,3})/i,
    /[:\-–]\s*([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'`.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'`.-]+){0,3})\s+(?:vs\.?|versus|v\.)\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'`.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'`.-]+){0,3})/i,
    /\b([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'`.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'`.-]+){0,3})\s+(?:vs\.?|versus|v\.)\s+([A-Z][A-Za-zÀ-ÖØ-öø-ÿ'`.-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'`.-]+){0,3})\b/i,
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (!match) continue;
    const fighterA = normalizeFighterName(match[1]);
    const fighterB = normalizeFighterName(match[2]);
    if (isPlausibleFighterName(fighterA) && isPlausibleFighterName(fighterB)) {
      return { fighterA, fighterB };
    }
  }
  return null;
}

function normalizeFighterName(value = '') {
  return cleanText(value)
    .replace(/\b(?:set|targeted|booked|scheduled|for|on|at|in|fight\s+card|card\s+announcement|announcement|headline|headlines)\b.*$/i, '')
    .replace(/\b(?:UFC|Fight|Night|Main|Event|Dana|White|announces?|announced|official)\b/gi, '')
    .replace(/^[^A-Za-zÀ-ÖØ-öø-ÿ]+|[^A-Za-zÀ-ÖØ-öø-ÿ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}


function isPlausibleFighterName(value = '') {
  const clean = cleanString(value);
  if (clean.length < 3 || clean.length > 60) return false;
  if (/\b(?:UFC|Fight Night|main event|card|title|date|venue|announces?)\b/i.test(clean)) return false;
  return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(clean);
}

function extractEventDate(text = '', options = {}) {
  const clean = cleanText(text);
  const now = options.now instanceof Date ? options.now : new Date();
  const patterns = [
    /\b(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)?,?\s*((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i,
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\.?)(?:,?\s+(\d{4}))?/i,
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (!match) continue;
    let month;
    let day;
    let year;
    if (/^\d/.test(match[1])) {
      day = Number(match[1]);
      month = monthIndex(match[2]);
      year = match[3] ? Number(match[3]) : now.getUTCFullYear();
    } else {
      const dateParts = match[1].replace('.', '').split(/\s+/);
      month = monthIndex(dateParts[0]);
      day = Number(dateParts[1]);
      year = match[2] ? Number(match[2]) : now.getUTCFullYear();
    }
    if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) continue;
    let date = new Date(Date.UTC(year, month, day, 12, 0, 0));
    // If a year is omitted and the detected date is stale, assume the next year.
    if (!match[2] && !match[3] && date.getTime() < now.getTime() - 30 * 24 * 60 * 60 * 1000) {
      date = new Date(Date.UTC(year + 1, month, day, 12, 0, 0));
    }
    return { date, confidence: match[2] || match[3] ? 90 : 70 };
  }

  const iso = clean.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const date = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12, 0, 0));
    if (!Number.isNaN(date.getTime())) return { date, confidence: 95 };
  }

  return null;
}

function extractEventTime(text = '') {
  const match = cleanText(text).match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.m\.|p\.m\.|am|pm)\s*(?:ET|EST|EDT|PT|PST|PDT)?\b/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = match[3].toLowerCase();
  if (meridiem.startsWith('p') && hours < 12) hours += 12;
  if (meridiem.startsWith('a') && hours === 12) hours = 0;
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return { matchTime: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}` };
}

function extractVenueAndCity(text = '') {
  const clean = cleanText(text).replace(/\s+/g, ' ');
  const patterns = [
    /\b(?:at|from)\s+([A-Z][A-Za-z0-9&'.\-\s]{2,80}?)\s+in\s+([A-Z][A-Za-z'.\-\s]{2,60})(?:[.,;]|$)/,
    /\b(?:inside)\s+([A-Z][A-Za-z0-9&'.\-\s]{2,80}?)\s+in\s+([A-Z][A-Za-z'.\-\s]{2,60})(?:[.,;]|$)/,
    /\bin\s+([A-Z][A-Za-z'.\-\s]{2,60})(?:[.,;]|$)/,
  ];
  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (!match) continue;
    if (match.length >= 3) {
      return { venue: cleanLocationPart(match[1]), city: cleanLocationPart(match[2]) };
    }
    return { venue: '', city: cleanLocationPart(match[1]) };
  }
  return { venue: '', city: '' };
}

function cleanLocationPart(value = '') {
  return cleanText(value)
    .replace(/\b(?:on|for|with|as|when|where|watch)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[,\s.]+|[,\s.]+$/g, '')
    .slice(0, 100);
}

function extractOfficialUfcEventUrl(text = '') {
  const match = String(text).match(/https?:\/\/(?:www\.)?ufc\.com\/event\/[^\s)"'<>]+/i);
  return match ? match[0] : '';
}

function isOfficialUfcUrl(value = '') {
  try {
    const url = new URL(value);
    return /(^|\.)ufc\.com$/i.test(url.hostname) && /\/event\//i.test(url.pathname);
  } catch (error) {
    return false;
  }
}

function getRssItemSource(item = {}, articleUrl = '') {
  const source = item.source;
  if (typeof source === 'string') return cleanString(source);
  if (source && typeof source === 'object') {
    return cleanString(source._ || source.title || source.name || source.url || source.$?.url);
  }
  if (item.creator) return cleanString(item.creator);
  try {
    return new URL(articleUrl).hostname.replace(/^www\./i, '');
  } catch (error) {
    return '';
  }
}

function formatRssItemsAsNewsArticles(items = []) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const articleUrl = cleanString(item.link || item.guid || '');
    return {
      title: stripGoogleNewsSourceSuffix(cleanText(item.title || '')),
      description: cleanText(item.contentSnippet || item.content || item.description || ''),
      link: articleUrl,
      pubDate: item.isoDate || item.pubDate || item.published || item.updated || null,
      image: item.enclosure?.url || item.media?.content?.url || null,
      creator: item.creator || null,
      articleSource: getRssItemSource(item, articleUrl),
      source: 'google-news-rss',
    };
  });
}

function stripGoogleNewsSourceSuffix(title = '') {
  const clean = cleanText(title);
  // Google News commonly emits: "Headline - Publisher". Remove only a short final publisher suffix.
  return clean.replace(/\s+-\s+[^-]{2,60}$/u, '').trim();
}

function monthIndex(value = '') {
  return MONTHS[String(value).toLowerCase().replace(/\./g, '')];
}

function parseDateLike(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function flattenJsonLdNodes(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenJsonLdNodes);
  if (typeof value === 'object') {
    const graph = Array.isArray(value['@graph']) ? value['@graph'].flatMap(flattenJsonLdNodes) : [];
    return [value, ...graph];
  }
  return [];
}

function safeJsonParse(value) {
  try { return JSON.parse(value); } catch (error) { return null; }
}

function slugify(value = '') {
  return cleanString(value)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function cleanText(value = '') {
  return decodeHtmlEntities(stripHtml(String(value || '')))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtml(value = '') {
  return String(value || '').replace(/<[^>]*>/g, ' ');
}

function decodeHtmlEntities(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function cleanString(value) {
  return String(value ?? '').trim();
}

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeCronTimezone(value) {
  let timezone = cleanString(value).replace(/^['"]|['"]$/g, '').trim();
  if (!timezone) return '';

  // Some serverless/Linux environments expose POSIX-style timezone values such
  // as `:UTC`. `node-cron` validates via Intl.DateTimeFormat, which requires
  // standard IANA names like `UTC` or `America/New_York`.
  timezone = timezone.replace(/^:+/, '').trim();
  if (!timezone) return '';
  if (timezone.toUpperCase() === 'UTC') return 'UTC';

  return timezone;
}

function isValidCronTimezone(timezone) {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch (error) {
    return false;
  }
}

function resolveCronTimezone(values = [], logger = console) {
  for (const value of values) {
    const timezone = normalizeCronTimezone(value);
    if (!timezone) continue;
    if (isValidCronTimezone(timezone)) return timezone;

    const rawValue = cleanString(value);
    if (rawValue) {
      logger.warn?.(`Ignoring invalid UFC event discovery timezone "${rawValue}"; falling back to a safe timezone.`);
    }
  }

  return 'UTC';
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(Math.max(number, min), max);
}

function summarizeError(error) {
  return {
    message: error?.message || String(error),
    code: error?.code,
    status: error?.status || error?.statusCode,
  };
}

module.exports = {
  GOOGLE_NEWS_UFC_RSS_FEED_URL,
  registerUfcEventDiscovery,
  _private: {
    GOOGLE_NEWS_PROVIDER,
    OFFICIAL_UFC_PROVIDER,
    buildDiscoveryKey,
    buildEventName,
    buildMatchDescription,
    buildNewMatchPayloadFromCandidate,
    extractEventDate,
    extractEventTime,
    extractFighterPair,
    extractUfcEventNumber,
    extractVenueAndCity,
    formatRssItemsAsNewsArticles,
    getDiscoveryFeedUrl,
    hasSufficientEventData,
    normalizeCronTimezone,
    parseOfficialUfcEventHtml,
    parseUfcEventCandidateFromRssItem,
    resolveCronTimezone,
    scoreCandidate,
    stripGoogleNewsSourceSuffix,
  },
};

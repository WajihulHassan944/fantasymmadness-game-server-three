'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { GOOGLE_NEWS_UFC_RSS_FEED_URL, registerUfcEventDiscovery, _private } = require('./ufc-event-discovery');

assert.strictEqual(typeof registerUfcEventDiscovery, 'function');
assert(GOOGLE_NEWS_UFC_RSS_FEED_URL.includes('news.google.com/rss/search'), 'UFC discovery must use Google News RSS.');
assert(GOOGLE_NEWS_UFC_RSS_FEED_URL.includes('UFC%20OR%20%22UFC%20Fight%20Night%22'), 'Google News feed must stay UFC-focused.');

const fightNight = _private.parseUfcEventCandidateFromRssItem({
  title: 'UFC Fight Night: Du Plessis vs Usman set for July 11 in Las Vegas - MMA Fighting',
  contentSnippet: 'The UFC Fight Night card is scheduled for July 11, 2027 at T-Mobile Arena in Las Vegas.',
  link: 'https://news.google.com/articles/fight-night-test',
  source: { _: 'MMA Fighting' },
  isoDate: '2026-12-01T12:00:00Z',
}, { now: new Date('2026-12-01T00:00:00Z') });

assert(fightNight, 'Fight Night event should be detected.');
assert.strictEqual(fightNight.eventType, 'fight_night');
assert.strictEqual(fightNight.eventName, 'UFC Fight Night: Du Plessis vs Usman');
assert.strictEqual(fightNight.fighterA, 'Du Plessis');
assert.strictEqual(fightNight.fighterB, 'Usman');
assert.strictEqual(fightNight.eventDate.toISOString().slice(0, 10), '2027-07-11');
assert(fightNight.discoveryKey.startsWith('ufc-fight-night:'));
assert(_private.hasSufficientEventData(fightNight, { now: new Date('2026-12-01T00:00:00Z') }).ok);

const numbered = _private.parseUfcEventCandidateFromRssItem({
  title: 'Dana White announces UFC 330 main event: Holloway vs Topuria set for November 15 - ESPN',
  contentSnippet: 'The fight card is booked for November 15, 2027 at Madison Square Garden in New York.',
  link: 'https://example.com/ufc-330-main-event',
  source: { _: 'ESPN' },
}, { now: new Date('2027-01-01T00:00:00Z') });

assert(numbered, 'Numbered UFC event should be detected.');
assert.strictEqual(numbered.eventNumber, 330);
assert.strictEqual(numbered.eventType, 'numbered');
assert.strictEqual(numbered.discoveryKey, 'ufc:330');
assert.strictEqual(numbered.fighterA, 'Holloway');
assert.strictEqual(numbered.fighterB, 'Topuria');
assert.strictEqual(numbered.venue, 'Madison Square Garden');
assert.strictEqual(numbered.city, 'New York');

const noche = _private.parseUfcEventCandidateFromRssItem({
  title: 'Noche UFC: Moreno vs Royval fight card announcement for September 14 - UFC.com',
  contentSnippet: 'Noche UFC is scheduled for September 14, 2027 at Sphere in Las Vegas. https://www.ufc.com/event/noche-ufc-test',
  link: 'https://www.ufc.com/event/noche-ufc-test',
  source: { _: 'UFC.com' },
}, { now: new Date('2027-01-01T00:00:00Z') });
assert(noche, 'Noche UFC event should be detected.');
assert.strictEqual(noche.eventType, 'noche_ufc');
assert.strictEqual(noche.officialEventUrl, 'https://www.ufc.com/event/noche-ufc-test');

const ignored = _private.parseUfcEventCandidateFromRssItem({
  title: 'Latest UFC rankings update after recent injuries - Example',
  contentSnippet: 'No event announcement, fight card date, venue, or main event details.',
});
assert.strictEqual(ignored, null, 'Ranking/injury-only items should be ignored.');

const news = _private.formatRssItemsAsNewsArticles([{ title: 'UFC 330 confirmed - ESPN', link: 'https://example.com/a', source: { _: 'ESPN' } }]);
assert.strictEqual(news[0].title, 'UFC 330 confirmed');
assert.strictEqual(news[0].source, 'google-news-rss');
assert.strictEqual(news[0].articleSource, 'ESPN');

const official = _private.parseOfficialUfcEventHtml(`
<html><head><script type="application/ld+json">{
  "@context":"https://schema.org",
  "@type":"SportsEvent",
  "name":"UFC 330: Holloway vs Topuria",
  "startDate":"2027-11-15T22:00:00-05:00",
  "location":{"@type":"Place","name":"Madison Square Garden","address":{"addressLocality":"New York","addressRegion":"NY"}}
}</script></head></html>
`, 'https://www.ufc.com/event/ufc-330');
assert.strictEqual(official.eventName, 'UFC 330: Holloway vs Topuria');
assert.strictEqual(official.venue, 'Madison Square Garden');
assert.strictEqual(official.city, 'New York, NY');

const payload = _private.buildNewMatchPayloadFromCandidate(numbered, new Date('2027-01-01T00:00:00Z'));
assert.strictEqual(payload.matchCategory, 'mma');
assert.strictEqual(payload.matchCategoryTwo, 'MMA');
assert.strictEqual(payload.matchType, 'LIVE');
assert.strictEqual(payload.matchStatus, 'Scheduled');
assert.strictEqual(payload.autoDiscovered, true);
assert.strictEqual(payload.ufcEventNumber, 330);

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const expiredAggregatorHost = ['rss', 'app'].join('.');
const expiredFeedId = ['_6ePd', 'Uiq5QyfSygcS'].join('');
assert(!serverSource.toLowerCase().includes(expiredAggregatorHost), 'server.js must not use the expired aggregator host.');
assert(!serverSource.includes(expiredFeedId), 'Expired feed id must be removed.');
assert(serverSource.includes("require('./ufc-event-discovery')"), 'server.js must load UFC event discovery.');
assert(serverSource.includes('registerUfcEventDiscovery({'), 'server.js must register UFC event discovery.');
assert(serverSource.includes('triggerUpcomingEventAutomationForMatch'), 'server.js must reuse the upcoming-event Swarm hook.');
assert(serverSource.includes('autoDiscoveryKey: String'), 'Match schema must store auto discovery dedupe keys.');

const swarmSource = fs.readFileSync(path.join(__dirname, 'swarm-phase2.js'), 'utf8');
assert(swarmSource.includes("auto_discovered_event: 'upcoming_event'"), 'Swarm trigger aliases should support auto-discovered events.');
assert(swarmSource.includes("google_news_upcoming_event: 'upcoming_event'"), 'Swarm trigger aliases should support Google News events.');

console.log('UFC event discovery backend tests passed.');

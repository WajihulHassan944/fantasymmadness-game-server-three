# Backend Phase: Google News UFC Event Discovery

This backend update removes the expired UFC/MMA news feed integration and replaces it with a UFC-focused Google News RSS feed:

```text
https://news.google.com/rss/search?q=UFC%20OR%20%22UFC%20Fight%20Night%22&hl=en-US&gl=US&ceid=US:en
```

## What changed

- Added `ufc-event-discovery.js` for scheduled Google News RSS ingestion.
- Added automatic detection for:
  - UFC numbered events
  - UFC Fight Night events
  - Noche UFC
  - UFC/fight-card/main-event announcement articles
- Extracts event name, event number, event date, time, fighters, venue, city, source, article URL, and official UFC event URL when available.
- Adds best-effort official UFC event-page enrichment when an official UFC event URL is present.
- Creates or updates `Match` records for upcoming UFC calendar entries.
- Uses dedupe keys and matching by UFC event number, title, fighters, and date window.
- Triggers the existing upcoming-event Swarm automation hook when a new auto-discovered event is created.
- Reuses the existing calendar API; no frontend contract change is required.

## New routes

- `GET /api/admin/ufc-event-discovery/status`
- `POST /api/admin/ufc-event-discovery/refresh`
- `GET /api/cron/ufc-event-discovery`

## New env example

See `.env.ufc-event-discovery.example`.

## Validation

Run:

```bash
npm test
```

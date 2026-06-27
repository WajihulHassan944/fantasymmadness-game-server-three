# Phase 2 Swarm Automation Backend Expansion

This backend package keeps the existing server structure intact and extends `swarm-phase2.js` as the automation gateway between the website and the IONOS swarm.

## Added backend capabilities

- Expanded job-type support for all Phase 1 swarm automation jobs.
- Admin-readable automation catalog and job-type APIs.
- Admin automation settings proxy to the IONOS swarm.
- Automation dashboard/cache endpoint.
- Automation event trigger API.
- Backend event log collection: `swarm_backend_automation_events`.
- Manual run API for any single automation.
- Blog approval follow-up automations.
- Existing-blog update support for old-blog-refresh artifacts.
- Safe backend hooks for:
  - combat match added/upcoming event
  - combat fight activated/published
  - combat fight finished/result updated
  - pro-wrestling match opened/published
  - pro-wrestling result updated
  - pro-wrestling contest finalized
  - wrestler added
  - blog created/updated

## New admin/backend endpoints

```http
GET    /api/admin/swarm/job-types
GET    /api/admin/swarm/catalog
GET    /api/admin/swarm/settings
PATCH  /api/admin/swarm/settings
PUT    /api/admin/swarm/settings
GET    /api/admin/swarm/dashboard
GET    /api/admin/swarm/events
POST   /api/admin/swarm/events/trigger
POST   /api/admin/swarm/events/:trigger
POST   /api/admin/swarm/automations/:jobType/run
```

## Generic trigger example

```json
{
  "trigger": "fight_published",
  "vertical": "combat",
  "sourceEntity": {
    "type": "combat_match",
    "id": "MATCH_ID",
    "label": "UFC Fight"
  },
  "input": {
    "matchId": "MATCH_ID",
    "title": "UFC Fight",
    "fighterA": "Fighter A",
    "fighterB": "Fighter B"
  }
}
```

## Safety behavior

The backend still does not allow the swarm to directly write users, wallets, contests, predictions, payouts, or settlements. Automations create jobs/artifacts in the swarm and publish only through existing backend approval routes.

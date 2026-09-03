# Backend Phase — July 10,000 Signup Growth System + Safe Fight Data Tools

This update is additive. Existing frontend routes, backend route contracts, fight creation, scoring, wallet, prediction, and affiliate flows are not removed or renamed.

## July Growth System backend support

Added backend support for the safe swarm campaign pack:

- `july_10000_signup_growth_system`

Added/recognized job types for the expanded growth pack:

- `analytics.july-10000-signup-growth-plan`
- `data.event-calendar-daily-update`
- `content.fight-card-daily-package`
- `content.blog-seo-daily-articles`
- `social.instagram-growth-posts`
- `social.facebook-growth-posts`
- `social.x-growth-posts`
- `social.youtube-growth-video-draft`
- `social.short-form-video-pack`
- `notification.community-retention-daily`
- `media.branded-post-image-prompt`

The backend injects this required YouTube CTA into growth jobs:

```text
Make your picks on Fantasy MMadness before the event starts.
```

The backend also passes logo overlay guidance from `BRAND_LOGO_URL`, `BRAND_LOGO_CORNER`, and `BRAND_LOGO_OPACITY`.

## New admin swarm routes

```http
GET  /api/admin/swarm/growth/july-10000/config
GET  /api/admin/swarm/growth/july-10000/dashboard
POST /api/admin/swarm/growth/july-10000/run
POST /api/admin/swarm/schedules/daily/july-growth
POST /api/admin/swarm/campaigns/july-growth
```

All routes require `verifyAdminToken`.

## Safe data-quality support for frontend/admin next phase

Added fight data-quality helper routes:

```http
GET  /api/scoring-config
GET  /api/admin/fights/scoring-config
GET  /api/admin/fights/data-quality/duplicates
POST /api/admin/fights/data-quality/duplicates/delete
GET  /api/admin/fights/data-quality/image-health
```

The delete endpoint defaults to `dryRun: true`; admin must explicitly send `dryRun: false` with selected IDs.

Added a non-breaking combat fighter library similar to pro-wrestling fighter management:

```http
GET   /api/combat-fighters
GET   /api/admin/combat-fighters
POST  /api/admin/combat-fighters
PATCH /api/admin/combat-fighters/:id
POST  /api/admin/combat-fighters/suggest-from-matches
POST  /api/admin/fights/:matchId/link-fighters
```

Existing match fields remain the fallback:

- `matchFighterA`
- `matchFighterB`
- `fighterAImage`
- `fighterBImage`

New optional match references were added only for future safe migration:

- `fighterAId`
- `fighterBId`

## Env additions

See `.env.july-growth-backend.example` and the appended section in `.env.swarm-phase2.example`.

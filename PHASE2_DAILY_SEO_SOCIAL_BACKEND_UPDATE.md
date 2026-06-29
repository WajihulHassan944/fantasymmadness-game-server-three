# Phase 2 Backend Update — Daily SEO, Social, Calendar, and Growth Automation

This update is additive and preserves the existing backend structure.

## Added backend support

- Added backend support for new swarm job types:
  - `social.instagram-post-draft`
  - `social.facebook-post-draft`
  - `social.multi-platform-daily-posts`
  - `data.fight-calendar-refresh`
  - `content.user-dashboard-opportunities`
  - `analytics.user-growth-1000-plan`
- Added daily automation trigger coverage for:
  - SEO audits
  - missing/low-quality page checks
  - broken-link checks
  - meta checks
  - keyword opportunities
  - fight calendar refresh plans
  - user dashboard fight opportunities
  - X/Instagram/Facebook social draft generation
- Added weekly automation trigger coverage for:
  - traffic opportunity reports
  - content/social calendars
  - competitor gap reports
  - traffic growth dashboard
  - 1000-new-users growth plan
- Added first-class backend proxy routes for swarm automation definitions, settings, logs, and dashboard.
- Added manual schedule run endpoints:
  - `POST /api/admin/swarm/schedules/daily/run`
  - `POST /api/admin/swarm/schedules/weekly/run`
  - `POST /api/admin/swarm/schedules/daily/seo`
  - `POST /api/admin/swarm/schedules/daily/social`
  - `POST /api/admin/swarm/schedules/daily/calendar-refresh`
- Added backend config response fields for social platform readiness:
  - `socialDefaultPlatforms`
  - `dailySocialDraftCount`
  - `metaSocialConfigured`
  - `twitterConfigured`
- Added support for the latest Phase 1 swarm automation endpoints:
  - `/internal/v1/automations`
  - `/internal/v1/automations/dashboard`
  - `/internal/v1/automations/logs`
  - `/internal/v1/automations/settings/bulk`
  - `/internal/v1/automations/:key/settings`
  - `/internal/v1/automations/:key/reset`

## Safety

- Social publishing remains controlled by existing env flags.
- This phase submits reviewable jobs/artifacts; it does not force live social posting.
- Existing routes and models are preserved.

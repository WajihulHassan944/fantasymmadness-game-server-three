# Phase 2 Swarm Backend Integration

This backend update keeps the existing Express/MongoDB code intact and adds a controlled gateway to the Phase 1 IONOS swarm.

## What was added

- `swarm-phase2.js`: isolated gateway module for swarm jobs, artifacts, reviews, publishing, and webhooks.
- `swarm-phase2.test.js`: regression coverage for the new gateway wiring.
- `.env.swarm-phase2.example`: required backend environment variables.
- `server.js` now preserves `req.rawBody` for HMAC webhook validation.
- `server.js` registers the gateway just before the existing `app.listen()`.

## New admin routes

```http
GET    /api/admin/swarm/config
GET    /api/admin/swarm/health
GET    /api/admin/swarm/agents
POST   /api/admin/swarm/jobs
GET    /api/admin/swarm/jobs
GET    /api/admin/swarm/jobs/:jobId
POST   /api/admin/swarm/jobs/:jobId/cancel
POST   /api/admin/swarm/jobs/:jobId/retry
GET    /api/admin/swarm/artifacts
GET    /api/admin/swarm/artifacts/:artifactId
POST   /api/admin/swarm/artifacts/:artifactId/approve
POST   /api/admin/swarm/artifacts/:artifactId/reject
POST   /api/admin/swarm/artifacts/:artifactId/regenerate
```

All admin routes use the existing `verifyAdminToken` middleware.

## New internal webhook routes

```http
POST /api/internal/swarm/webhooks/job-completed
POST /api/internal/swarm/webhooks/job-failed
```

These verify HMAC signatures by default.

## What the swarm can achieve through this backend now

1. Admin submits MMA or pro-wrestling automation jobs from the backend.
2. Backend forwards jobs securely to the IONOS swarm.
3. IONOS workers generate content, SEO reports, social drafts, data candidates, wrestling analysis, and scorecard suggestions.
4. Backend receives signed completion/failure callbacks.
5. Backend caches jobs/artifacts in prefixed collections.
6. Admin can approve/reject/regenerate artifacts.
7. Approved content artifacts can be published into the existing `Blog` model.
8. The swarm still cannot directly modify contests, wallets, predictions, payouts, users, or settlement data.

## Backend env required on Vercel

Copy values from `.env.swarm-phase2.example` into Vercel environment variables.

Minimum required after IONOS swarm is deployed:

```env
SWARM_ENABLED=true
SWARM_BASE_URL=http://YOUR_IONOS_SERVER_IP:8080
SWARM_API_KEY=same_as_ionos_swarm
BACKEND_HMAC_KEY_ID=backend-v1
BACKEND_HMAC_SECRET=same_value_configured_in_ionos_as_BACKEND_HMAC_SECRET
```

## IONOS swarm env required for callbacks

```env
BACKEND_CALLBACK_ENABLED=true
BACKEND_BASE_URL=https://YOUR_BACKEND_VERCEL_DOMAIN
BACKEND_HMAC_KEY_ID=backend-v1
BACKEND_HMAC_SECRET=same_as_backend
```

## Simple test request after deployment

```bash
curl -H "Authorization: Bearer ADMIN_JWT" \
  https://YOUR_BACKEND_DOMAIN/api/admin/swarm/health
```

Create a job:

```bash
curl -X POST https://YOUR_BACKEND_DOMAIN/api/admin/swarm/jobs \
  -H "Authorization: Bearer ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "vertical":"combat",
    "jobType":"content.article",
    "input":{"topic":"Fantasy MMA weekly preview"}
  }'
```

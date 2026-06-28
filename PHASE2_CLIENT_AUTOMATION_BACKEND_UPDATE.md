# Phase 2 backend update — campaign automation and client UX support

This update keeps the existing backend structure intact and expands only the swarm gateway layer.

## Added

- Campaign/all-agents backend support for the expanded IONOS swarm.
- Boxing campaign support through `sport: "boxing"` while keeping the backend vertical as `combat`.
- Campaign proxy/cache endpoints:
  - `GET /api/admin/swarm/campaigns/packs`
  - `POST /api/admin/swarm/campaigns`
  - `GET /api/admin/swarm/campaigns`
  - `GET /api/admin/swarm/campaigns/:campaignId`
  - `POST /api/admin/swarm/campaigns/fight`
  - `POST /api/admin/swarm/campaigns/fight/full`
  - `POST /api/admin/swarm/campaigns/fight/tonight`
  - `POST /api/admin/swarm/campaigns/boxing`
- Event trigger support for campaign mode when the admin selects all agents/all the above.
- Backend campaign cache collection: `swarm_backend_campaigns`.
- Campaign-aware job/artifact filtering by `campaignId` and `sport`.
- SEO artifact approval/application path:
  - SEO artifacts are stored as managed swarm outputs.
  - Blog SEO metadata can be applied to the existing Blog model after admin approval.
  - Non-blog SEO items remain application plans for frontend/backend review.
- Admin token responses now return `401` with `code` and `shouldLogin: true` so the frontend can redirect to login cleanly.

## Safety

- Swarm still cannot directly modify wallets, payouts, predictions, settlements, or user balances.
- Social posting remains gated by env/config flags.
- Campaigns create reviewable jobs/artifacts first unless automation flags are intentionally enabled.

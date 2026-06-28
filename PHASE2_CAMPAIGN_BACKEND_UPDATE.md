# Phase 2 Campaign Backend Update

This backend update connects the existing admin website to the expanded IONOS swarm campaign system.

## Added backend capabilities

- Supports swarm campaign packs for full-fight, tonight-fight, Boxing, fight-result, pro-wrestling, blog-promotion, contest-promotion, and custom campaigns.
- Supports `sport: "boxing"` while keeping backend vertical as `combat`.
- Adds grouped campaign endpoints so one admin action can run multiple agents together.
- Adds backend normalization for `all agents`, `all the above`, section multi-select, and campaign mode.
- Keeps sensitive website data protected: swarm still does not directly update wallets, payouts, predictions, settlements, or user balances.

## Added endpoints

```http
GET  /api/admin/swarm/campaigns/packs
GET  /api/admin/swarm/campaigns
GET  /api/admin/swarm/campaigns/:campaignId
POST /api/admin/swarm/campaigns
POST /api/admin/swarm/campaigns/fight
```

## Example campaign request

```json
{
  "campaignType": "boxing_fight_campaign",
  "title": "Boxing Fight Tonight",
  "sport": "boxing",
  "includeAll": true,
  "mode": "APPROVAL_REQUIRED",
  "sourceEntity": {
    "type": "combat_match",
    "id": "MATCH_ID",
    "label": "Boxing Fight Tonight"
  },
  "input": {
    "fightId": "MATCH_ID",
    "title": "Boxing Fight Tonight",
    "matchDate": "2026-06-28"
  }
}
```

## Deployment

No new required env variables. Keep existing swarm backend env values.

Optional:

```env
SWARM_AUTOMATION_EVENT_HOOKS_ENABLED=true
```


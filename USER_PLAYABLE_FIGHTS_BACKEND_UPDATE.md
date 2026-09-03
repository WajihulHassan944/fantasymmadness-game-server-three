# User Playable Fights Backend Update

## Purpose
Ensure public/user-side pages have prediction-ready fight data available without exposing draft fights.

## Added/Updated
- Added user-playable fight eligibility helpers for Match and Shadow records.
- Added support for `/match?status=playable`, `/match?playable=true`, `/match?intent=active-contests`.
- Added `GET /api/public/prediction-fights` for user dashboard/upcoming fight prediction cards.
- Added `/api/public/prediction-fights` support inside the SEO/public API module.
- User-playable feed reads both Match and Shadow records.
- Draft fights remain hidden unless admin explicitly uses `includeDrafts=true`.
- Closed/finished/completed fights are excluded from prediction-ready feed.

## Frontend next phase
Frontend can use `/api/public/prediction-fights?limit=20` for dashboard/upcoming fights where users should be able to submit predictions.

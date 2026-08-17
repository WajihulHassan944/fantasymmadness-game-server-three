# Fantasy MMadness design v12 backend support (v18)

This release keeps the established eMerchant Authority / Authorize.Net payment integration and adds the server-backed behaviors required by the v12 application handoff.

## Added and verified

- Authenticated profile updates and safe account fields used by the new profile/cart UI.
- Daily streak claim, 50 FM streak save (25 FM for active FM+), and 75 FM skip-the-wait operations with server-side wallet validation.
- 30-day FM+ entitlement status and expiry support; recurring/monthly UI remains gated until a supported recurring billing workflow exists.
- Dead-week detection and automatic Shadow fight publication from real archived fights. Fighter identities remain private until the user submits or the reveal state permits them.
- Rookie, Regular, Expert, and Global leaderboard calculation from official scored results only. Submitting a card does not manufacture ranking points.
- Rolling performance history for tier movement: Rookie before five scored contests, Expert after ten scored contests when the player is in the top performance band, Regular otherwise.
- Retention state included in the homepage summary, plus an optional protected cron route for scheduled maintenance.
- First-purchase eligibility is exposed safely so the frontend only displays a bonus when the account is actually eligible.

## Deployment

Retain the existing Authorize.Net credentials and production environment configuration. `CRON_SECRET` is recommended when scheduling `/api/cron/retention`. Deploy this backend before the matching frontend v59 so all v12 response fields are available immediately.

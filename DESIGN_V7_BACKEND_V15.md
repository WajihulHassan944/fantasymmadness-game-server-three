# Fantasy MMAdness design v7 support — backend v15

## New/updated APIs

- `GET /api/users/me/fight-entries` returns only the verified player's submitted entries, real pick, predictions, live points, and fight data.
- Public prediction rows include a per-fight scouting report and live aggregate pick split while keeping individual scorecards private.
- `POST /api/admin/fights/:id/ai-scouting-report` generates and caches a report from the registered fight and submitted cards. Model output is numeric-validated; unavailable/invalid output falls back to a deterministic database-grounded report.
- `PATCH /api/admin/fights/:id/homepage-placement` manages `featured-this-week` and `featured-fight` independently. Upcoming Events remains automatic from future registered dates.
- Public fight fields now expose the two placement flags, surface-specific images, division/weight class, and cached AI report.
- Public home summary and leaderboard use a short stale-while-revalidate response cache for faster repeat navigation.

## Checkout and FM+

- Existing server-priced/idempotent coin checkout remains intact.
- Added server-priced FM+ monthly and one-time 30-day pass orders, account creation after confirmed payment, 500-FM welcome credit for new accounts, 1,000-FM plan credit, entitlement expiry, and idempotent webhook settlement.
- v17 routes new payments through Authorize.Net Accept Hosted. Monthly auto-renew remains disabled until recurring billing is activated and separately implemented; the 30-day pass works now.
- Expired FM+ entitlements are removed when the player profile is loaded.

## Data integrity

- Fight dates continue to use the date-only key/noon-UTC normalization that prevents a registered Aug 15 fight displaying as Aug 14.
- Entry fees, prize pools, and initial predictions are never supplied by the design prototype.
- Backend and regression test suites pass, including date, cart pricing, FM+, AI-report validation, wrestling routes, fight quality, and event discovery.

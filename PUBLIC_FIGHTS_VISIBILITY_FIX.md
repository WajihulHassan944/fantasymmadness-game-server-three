# Public Fights Visibility Fix

This update fixes the public fight visibility regression where public pages could receive empty fight lists after draft hiding was introduced.

## Fixed

- Public APIs now hide only fights explicitly marked as Draft.
- Existing published/active/finished/legacy fights are no longer excluded by optional legacy flags.
- `/match` now handles `all`, empty, and case-insensitive filters safely.
- `/api/public/fights` now handles sport/category/status filters case-insensitively.
- Admin can still load draft fights with `includeDrafts=true`.

## Validation

- `node --check server.js`
- `node --check seo-performance-phase2.js`
- `node --check swarm-phase2.js`
- `npm test`

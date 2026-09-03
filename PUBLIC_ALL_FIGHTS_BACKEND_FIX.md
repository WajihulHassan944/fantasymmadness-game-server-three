# Public all-fights visibility fix

This additive backend update restores public fight visibility while still keeping explicit Draft fights hidden.

## What changed

- `/api/public/fights` now combines public records from both `Match` and `Shadow` collections.
- `/api/public/fights` supports all combat sports on the public side: MMA, Boxing, Kickboxing, and Bareknuckle.
- Public status filters now understand both `matchStatus` and `matchShadowOpenStatus`.
- Legacy `/match` route now has a Shadow fallback if Match collection returns no public fights.
- Public filtering hides only explicit Draft fights, not legacy records with missing/newer fields.
- Admin can still fetch draft/internal fights with `includeDrafts=true`.

## Reason

Some public/user/affiliate pages can go blank when the fight cards are stored as Shadow/promotional fights rather than normal Match records. This patch keeps public pages populated while still respecting Draft visibility.

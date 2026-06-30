# Match Admin Shadow Fallback Fix

- Restored backward-compatible `/match` behavior.
- `/match?includeDrafts=true` now falls back to Shadow records when normal Match records are empty.
- Admin fight screens using legacy `/match` can see draft/shadow fights again when needed.
- Public `/match` still hides explicit Draft records.
- Legacy `/match` and `/shadow` routes remain preserved.

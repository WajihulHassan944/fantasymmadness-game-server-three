# Phase 2 Backend Update - Client Review Fixes

This update is additive only. No existing route or model was removed.

## Added / Improved

- Fresh fight ordering for `/match` so newly-created/recently-updated fights are returned first for the frontend.
- Added optional `/match` filters: `status`, `category`, `shadowStatus`, and `openStatus`.
- Added admin-friendly video update aliases for regular fights and shadow fights:
  - `PUT/POST /api/admin/matches/:id/video`
  - `PUT/POST /api/admin/shadow/:id/video`
- Added admin-friendly scoring update aliases for regular fights and shadow fights:
  - `PUT/POST /api/admin/matches/:id/scoring`
  - `PUT/POST /api/admin/shadow/:id/scoring`
- Added `GET /api/shadow/:id` so frontend can load a single shadow fight cleanly before editing.
- Improved `/editMatch` and `/editShadow` so video URLs, scoring JSON, status fields, and numeric zero values can be updated safely.
- Improved `/match/addRoundResults/:id` and `/shadow/addShadowRoundResults/:id` so total punches (`TP`) are treated as a manual field only.
- Total punches are no longer derived from `HP + BP` by backend helper logic.
- Existing scoring fields are preserved when an update only sends one changed field.

## Notes

- Frontend still needs to expose the improved edit/scoring UI in Phase 3.
- Password visibility, number input cursor UX, upcoming fight carousel, and homepage display improvements are frontend-only and should be handled in Phase 3.

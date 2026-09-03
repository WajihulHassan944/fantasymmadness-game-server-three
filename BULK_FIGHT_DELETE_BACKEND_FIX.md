# Bulk fight deletion + Match/Shadow delete fix

This update is additive and preserves all existing routes.

## Fixed

- `DELETE /api/matches/:id` now deletes from `Match` first and falls back to `Shadow` when the fight is stored as a shadow/promotional/draft fight.
- The previous `Match not found` issue is fixed for draft/shadow records shown in the admin fight registry.
- Associated prediction scores are deleted for the removed fight id.
- Existing optional wallet refund behavior for regular Match records is preserved with `updateWallet=true`.
- Cloudinary image cleanup and notifications are preserved.

## Added

- `POST /api/admin/fights/bulk-delete`
- `DELETE /api/admin/fights/bulk-delete`
- `POST /api/matches/bulk-delete`
- `DELETE /api/matches/bulk-delete`

Payload examples:

```json
{ "ids": ["MATCH_OR_SHADOW_ID"] }
```

```json
{ "items": [{ "id": "MATCH_ID", "sourceType": "match" }, { "id": "SHADOW_ID", "sourceType": "shadow" }] }
```


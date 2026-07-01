# Phase: Combat Fighter Library Backend Update

This phase is backend-only. Frontend/admin UI wiring will happen separately.

## What changed

- Added admin-ready combat fighter library support for normal fights, similar to the pro-wrestling fighter library.
- Added optional `fighterAId` / `fighterBId` references to both `Match` and `Shadow` schemas while keeping old string/image fields as fallback.
- Added backend support for creating fights from fighter selections instead of uploading fighter images every time.
- Added backend support for editing fights with selected fighter references.
- Added safe automated fighter import from existing fights.
- Added admin-separated fight feeds so LIVE fights and shadow library records can be requested separately.

## New/updated backend APIs

### Fighter library

- `GET /api/combat-fighters`
- `GET /api/admin/combat-fighters`
- `GET /api/admin/combat-fighters/:id`
- `POST /api/admin/combat-fighters`
- `PATCH /api/admin/combat-fighters/:id`
- `DELETE /api/admin/combat-fighters/:id`
- `POST /api/admin/combat-fighters/:id/restore`
- `POST /api/admin/combat-fighters/suggest-from-matches`
- `POST /api/admin/combat-fighters/import-from-fights`

### Fight linking

- `POST /api/admin/fights/:matchId/link-fighters`

### Admin fight feeds

- `GET /api/admin/fights`
- `GET /api/admin/fights/live`
- `GET /api/admin/shadow-fights/library`

## Safe migration behavior

`POST /api/admin/combat-fighters/import-from-fights` builds unique fighters from existing Match and Shadow fight records.

For each unique fighter name/category pair, it checks candidate fighter image URLs from all fights. If a fighter has multiple image URLs and only one works, the working URL is selected for the fighter library.

The endpoint defaults to `dryRun=true`, so it does not mutate data until called with `dryRun=false`.

Recommended request for actual migration:

```json
{
  "dryRun": false,
  "checkImages": true,
  "includeShadows": true,
  "linkMatches": true,
  "overwriteImages": false,
  "syncMatchImages": false
}
```

## Safety notes

- Old match fields remain intact: `matchFighterA`, `matchFighterB`, `fighterAImage`, `fighterBImage`.
- New fighter references are additive only.
- Public/frontend pages can use fighter-library image first and fallback to old fight image fields.
- Deleting a fighter is a soft delete/inactivation, not destructive deletion of fight data.
- Fight deletion does not delete shared fighter-library images.
- Existing backend routes were not removed or renamed.

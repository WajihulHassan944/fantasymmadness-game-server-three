# Phase: Combat Fighter Link Cleanup Backend Update

## Goal
Move combat fight records toward the fighter-library data model after fighters have been imported.

The fighter library is now the source of truth for fighter names and fighter images. Fight records can keep only:

- `fighterAId`
- `fighterBId`

Legacy fight-side fighter fields can be removed safely once a side has a valid fighter-library reference.

## New Admin Cleanup Endpoints

### Dry run / execute cleanup

```http
POST /api/admin/combat-fighters/cleanup-fight-fighter-fields
POST /api/admin/combat-fighters/normalize-fight-links
```

Default behavior is `dryRun=true`.

Example dry run:

```json
{
  "dryRun": true,
  "batchSize": 50,
  "includeMatches": true,
  "includeShadows": true,
  "resolveMissingRefs": true
}
```

Example execution:

```json
{
  "dryRun": false,
  "batchSize": 50,
  "includeMatches": true,
  "includeShadows": true,
  "resolveMissingRefs": true,
  "removeLegacyNames": true,
  "removeLegacyImages": true,
  "removeLegacyDeleteUrls": true
}
```

## What the cleanup does

For each Match and Shadow record in the batch:

1. If `fighterAId` / `fighterBId` already exists, it is kept.
2. If the ID is missing, the backend resolves the fighter using:
   - normalized fighter name
   - fight category
   - active combat fighter library records
3. Once a side has a valid fighter reference, backend removes duplicated side data:
   - `matchFighterA` / `matchFighterB`
   - `fighterAImage` / `fighterBImage`
   - `fighterAImageDeleteUrl` / `fighterBImageDeleteUrl`
4. If a side cannot be resolved to a fighter-library record, its legacy fields are not removed.

## Public/API read compatibility

Public fight reads now populate fighter refs and hydrate legacy field names in API responses:

- `/match`
- `/shadow`
- `/matchByName`
- `/api/matches/:id`
- `/api/shadow/:id`
- `/api/public/prediction-fights`
- `/api/public/home-summary`
- `/api/public/leaderboard`

This means existing frontend fight cards can still read `matchFighterA`, `matchFighterB`, `fighterAImage`, and `fighterBImage`, but these values are now derived from the fighter library when available.

## Public fighter-list APIs

Public fighter pages should use the fighter-library list directly:

```http
GET /api/combat-fighters?page=1&limit=50&search=&category=boxing
GET /api/public/combat-fighters?page=1&limit=50&search=&category=boxing
GET /api/public/fighters?page=1&limit=50&search=&category=boxing
```

Pagination now includes:

- `hasNextPage`
- `nextPage`
- `hasPrevPage`
- `prevPage`

This supports infinite-scroll fighter selectors/pages on the frontend.

## New fight creation/edit behavior

When a fight is created or edited with fighter-library refs, backend clears duplicate fight-side fighter data and stores the refs only.

The promotion background remains fight-specific and is not affected.

## Safety

- Cleanup is batched.
- Dry-run is default.
- Legacy fields are removed only when a valid fighter ref exists for that side.
- Unresolved sides are reported and preserved.

# Fighter Import Timeout Fix

## Issue

`POST /api/admin/combat-fighters/import-from-fights` was timing out on Vercel because the endpoint attempted to import all unique fighters and verify many remote image URLs inside a single serverless request.

Vercel production limit observed:

- Function limit: 10 seconds
- Endpoint: `/api/admin/combat-fighters/import-from-fights`
- Failure: `504 FUNCTION_INVOCATION_TIMEOUT`

## Fix

The import endpoint is now batched and Vercel-safe by default.

### Default behavior

- `dryRun=true` processes a planning batch without remote image checks by default.
- `dryRun=false` processes a small batch of fighters per request.
- Remote image checks use short timeouts.
- Remote image checks are concurrency-limited.
- Existing match fields are preserved as fallback.

### Continue import

Call the same endpoint repeatedly using the returned `batch.nextOffset` until `batch.hasMore` is false.

Example request:

```json
{
  "dryRun": false,
  "offset": 0,
  "batchSize": 8,
  "includeShadows": true,
  "checkImages": true,
  "linkMatches": true
}
```

Example response field:

```json
{
  "batch": {
    "offset": 0,
    "batchSize": 8,
    "processedFighters": 8,
    "totalFighters": 120,
    "nextOffset": 8,
    "hasMore": true
  }
}
```

Next request:

```json
{
  "dryRun": false,
  "offset": 8,
  "batchSize": 8,
  "includeShadows": true,
  "checkImages": true,
  "linkMatches": true
}
```

## Safety

- No old route was removed.
- No existing match name/image fields are deleted.
- `fighterAId` and `fighterBId` remain optional.
- If image checks fail or time out, the fighter is created with `needs_review` rather than blocking the full import.

# Fantasy MMADNESS — Pro Wrestling Backend

This implementation adds Pro Wrestling as an additive game mode. Existing MMA, boxing, kickboxing, bare-knuckle, affiliate, wallet, admin, notification, and payment routes remain available under their original contracts.

## New environment variables

```env
# Enabled by default. Set to false for an immediate kill switch.
PRO_WRESTLING_ENABLED=true

# Keep false in production. MongoDB transactions require an Atlas/replica-set deployment.
# This escape hatch is only for local development against a standalone Mongo instance.
PRO_WRESTLING_ALLOW_NON_TRANSACTIONAL=false

# Optional secret for an external scheduler calling GET /api/wrestling/cron/process.
CRON_SECRET=replace-with-a-long-random-value
```

Existing `JWT_SECRET`, `JWT_SECRET_ADMIN`, MongoDB, Cloudinary, and Pusher variables are reused.

## Game flow

1. Admin creates wrestlers and a Pro Wrestling contest.
2. Admin publishes the contest (`DRAFT -> OPEN`).
3. Authenticated players join; the entry fee is deducted transactionally from the existing `User.tokens` wallet.
4. Players submit full-match predictions for both competitors:
   - `HP`: Head Punches
   - `BP`: Body Punches
   - `K`: Kicks
   - `PM`: Power Moves
   - `FM`: Finishers
   - `winnerPrediction`: `A`, `B`, or `DRAW`
5. Predictions lock at `lockAt`.
6. Admin enters live action totals. Provisional scores and ranks are recalculated.
7. Admin confirms the official result and finalizes.
8. The backend calculates the final leaderboard, credits winners, credits an optional affiliate commission, records the platform fee, and stores audit records.
9. Cancelled/no-contest events refund entry fees exactly once.

## Match lifecycle

```text
DRAFT -> OPEN -> LOCKED -> LIVE -> SCORING -> FINALIZED
                   \          \-> CANCELLED
                    \-----------> NO_CONTEST
```

Terminal states cannot be reopened through the normal status endpoint.

## Scoring V1

Default category weights:

| Code | Category | Weight |
|---|---|---:|
| HP | Head Punches | 1.0 |
| BP | Body Punches | 1.0 |
| K | Kicks | 1.2 |
| PM | Power Moves | 1.5 |
| FM | Finishers | 2.0 |

Accuracy multipliers:

- Exact: `1.00`
- Within 20%: `0.75`
- Within 50%: `0.40`
- Outside 50%: `0.10`
- Correct winner bonus: `1,000`

Rules are versioned and snapshotted onto every contest. Editing a ruleset later does not change historical contest scoring.

Tie-break order:

1. Highest total score
2. Lowest normalized prediction error
3. Most exact predictions
4. Lowest combined finisher error
5. Earliest valid submission

## Default payout V1

- Eligible winners: top 10%, with at least three winners when enough players exist
- 1st: 40%
- 2nd: 25%
- 3rd: 15%
- Remaining eligible winners share 20%
- One-, two-, and three-player edge cases are normalized to distribute the full player pot
- Optional platform fee and affiliate commission are deducted before player payout

Every debit, payout, commission, refund, fee, and admin adjustment uses a unique idempotency key in `ProWrestlingWalletLedger`.

## Main public/player endpoints

```text
GET    /api/wrestling/health
GET    /api/wrestling/config
GET    /api/wrestling/wrestlers
GET    /api/wrestling/wrestlers/:idOrSlug
GET    /api/wrestling/matches
GET    /api/wrestling/matches/:matchId
POST   /api/wrestling/matches/:matchId/join
GET    /api/wrestling/matches/:matchId/my-entry
POST   /api/wrestling/matches/:matchId/prediction
PUT    /api/wrestling/matches/:matchId/prediction
GET    /api/wrestling/matches/:matchId/prediction
GET    /api/wrestling/matches/:matchId/live
GET    /api/wrestling/matches/:matchId/leaderboard
GET    /api/wrestling/matches/:matchId/results
GET    /api/users/me/wrestling-history
GET    /api/users/me/wrestling-wallet-ledger
GET    /api/users/me/wrestling-notifications
PATCH  /api/users/me/wrestling-notifications/:id/read
GET    /api/affiliates/me/wrestling-summary
```

`/api/wrestling/contests` aliases are also available for contest listing, detail, and joining.

## Main admin endpoints

```text
GET/POST/PUT/DELETE  /api/admin/wrestling/wrestlers...
GET/POST/PUT/DELETE  /api/admin/wrestling/matches...
PUT    /api/admin/wrestling/matches/:id/status
PUT    /api/admin/wrestling/matches/:id/live-stats
PUT    /api/admin/wrestling/matches/:id/result
POST   /api/admin/wrestling/matches/:id/recalculate
POST   /api/admin/wrestling/matches/:id/finalize
POST   /api/admin/wrestling/matches/:id/cancel
POST   /api/admin/wrestling/matches/:id/refund
GET    /api/admin/wrestling/matches/:id/entries
GET    /api/admin/wrestling/matches/:id/predictions
PUT    /api/admin/wrestling/matches/:id/predictions/:userId
GET/POST/PUT /api/admin/wrestling/scoring-rules...
GET/POST/PUT /api/admin/wrestling/payout-rules...
GET    /api/admin/wrestling/analytics
GET    /api/admin/wrestling/audit-logs
GET    /api/admin/wrestling/wallet-ledger
POST   /api/admin/wrestling/wallet-adjustment
POST   /api/admin/wrestling/migrate-existing-matches
GET    /api/admin/wrestling/system-check
GET    /api/admin/wrestling/docs
```

All `/api/admin/wrestling/*` endpoints require the existing admin bearer token signed with `JWT_SECRET_ADMIN`.

## Scheduled maintenance

Call this endpoint from a secure scheduler:

```text
GET /api/wrestling/cron/process
Authorization: Bearer <CRON_SECRET>
```

It:

- locks due contests,
- refunds contests that miss their minimum participant threshold,
- sends starting-soon notifications.

Prediction submission also checks `lockAt` server-side, so the lock remains enforced even when no scheduler is configured.

## Migration

Preview existing legacy match classification:

```http
POST /api/admin/wrestling/migrate-existing-matches
Authorization: Bearer <admin token>
Content-Type: application/json

{ "apply": false }
```

Apply only after reviewing the preview:

```json
{ "apply": true }
```

The migration only adds `gameMode`, `predictionFormat`, and `scoringRuleVersion` to legacy records. It does not rewrite existing predictions or scores.

## Validation

```bash
npm test
node --check server.js
```

The test suite checks scoring, zero-stat behavior, tie-breaking, payout allocation, lock rules, all required Pro Wrestling routes, duplicate route declarations, and preservation of every legacy endpoint recorded in `legacy-route-manifest.json`.

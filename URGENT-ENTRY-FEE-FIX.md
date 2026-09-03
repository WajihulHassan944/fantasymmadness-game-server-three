# URGENT FIX — entry fees were never charged

**The leak:** `POST /api/scores` saved a prediction and **nothing debited the wallet**. The app checked the balance client-side, which enforces nothing. Every paid contest entry was free. This is now fixed with one atomic endpoint.

---

## What was happening

```js
// OLD — frontend
POST /api/scores                              // saves prediction
POST /api/matches/:id/updatePredictionStatus  // flips a flag
```

Neither call touched `user.tokens`. The only fee check was in the browser:

```js
if (this.state.coins < entryFee) { showToast('Not enough FM coins'); return; }
```

A client-side check is a suggestion, not a rule. Anyone could enter every paid fight on the card without spending a coin — and the pot never grew, so prize funding was wrong too.

Your Pro Wrestling flow (`joinWrestlingMatch`) already did this correctly. The classic fight flow never got the same treatment. The new endpoint is modelled directly on it.

---

## The new endpoint — `POST /api/fights/:fightId/entries`

```
Headers
  Authorization:   Bearer <token>     REQUIRED
  Idempotency-Key: <uuid>             recommended (deterministic fallback if absent)

Body
  { "predictions": [ ...rounds ], "category": "Boxing" }
```

No `playerId`, no `userId`, **no fee or price**. All derived server-side.

### Inside one MongoDB transaction

1. Resolve user from token → 401 if absent
2. Load `Match`, fall back to `Shadow` → 404
3. Assert open for entry → 409 `FIGHT_LOCKED`
4. Re-check for an existing entry inside the transaction → closes the double-submit race
5. **`entryFee = fight.matchTokens`** — read from the fight, request ignored
6. If fee > 0: check balance → 402 `INSUFFICIENT_FUNDS`, debit `user.tokens`, write ledger row
7. Create the `Score`
8. Mark `userPredictions[].predictionStatus = 'submitted'`
9. `fight.pot += entryFee`

All of it commits together or rolls back together. No charge without an entry; no entry without a charge.

### Response

```json
{
  "entryId": "...",
  "entryFeeCharged": 500,
  "walletBalance": 11950,
  "potTotal": 24500,
  "playerCount": 49,
  "predictionStatus": "submitted"
}
```

`walletBalance` is authoritative — the app should display this, never subtract locally.

### Error codes

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHENTICATED` | No/invalid token |
| 402 | `INSUFFICIENT_FUNDS` | Includes `balance`, `entryFee`, `shortfall` |
| 404 | `FIGHT_NOT_FOUND` | Not in `Match` or `Shadow` |
| 409 | `FIGHT_LOCKED` | Finished, closed, or past its start |
| 422 | `INVALID_PREDICTION` | Empty/missing predictions |

### Idempotency

Two layers:
1. A pre-flight check returns the existing entry instead of charging again.
2. A unique ledger key (`fight:ledger:<key>`) makes a concurrent duplicate collide on the index; that's caught and answered `200 idempotent`.

Mobile users double-tap. Without this you double-charge real customers.

### Free contests

Same path. `matchTokens: 0` skips the debit entirely — no parallel free-entry route to leave unprotected.

### New model: `FightEntryLedger`

Every debit writes an audit row (`userId`, `matchId`, `amount`, `balanceBefore`, `balanceAfter`, `idempotencyKey`). Money movement without an audit trail can't be reconciled or disputed. No migration needed — it creates itself on first write.

### `FIGHT_ENTRY_ALLOW_NON_TRANSACTIONAL`

Transactions need a replica set. If your Mongo is standalone, entries will fail with a transaction error. Setting this env var to `true` allows a non-transactional fallback **for local development only**. Do not set it in production — without a transaction, a mid-sequence failure can charge a user and not record their entry.

---

## Frontend — `MakePredictions.jsx`

`handleFinish()` now makes one call instead of two, sends the token and an idempotency key, and handles the real failure modes:

- `INSUFFICIENT_FUNDS` → tells the user the exact shortfall and routes to buy coins with `returnTo` back to the fight
- `FIGHT_LOCKED` → explains entry closed
- `ALREADY_ENTERED` → no re-charge

Also added `idempotencyKeyRef` — it was referenced before I declared it, which would have thrown on submit.

---

## Deploy together

Backend and frontend in one release. Backend alone: predictions 401. Frontend alone: the new endpoint 404s.

Smoke test in this order:
1. Fight with `matchTokens: 0` → entry succeeds, balance unchanged
2. Paid fight, sufficient balance → **balance drops by exactly the fee**, pot rises, ledger row exists
3. Same fight again → "already entered", **balance does not change**
4. Paid fight, balance below fee → 402, shortfall correct, **no debit, no entry**
5. Double-tap submit → one entry, one charge

Step 3 and 5 are the ones that matter. If either double-charges, stop and fix before going live.

---

## The leak is now closed

`POST /api/scores` no longer creates free entries. Both endpoints share **one** code path (`createFightEntry`), so there is exactly one place in the codebase that can create a paid entry.

`/api/scores` now behaves as:

| Situation | Behaviour |
| --- | --- |
| No existing entry | Delegates to `createFightEntry()` → **charges atomically** |
| Existing entry | Updates the predictions, **no charge** (a legitimate pre-lock edit) |
| No token | 401 |

This preserves "entries remain editable until the fight locks" — editing something you already paid for shouldn't cost again — while making the first submission impossible to get for free.

`createFightEntry` is declared as a hoisted `function` specifically so the older `/api/scores` route (line ~8994) can call it despite being defined later in the file (line ~15458).

Verified after refactor: braces and parens balanced across the whole file, one `Score.create`, one `FightEntryLedger.create`, one transaction wrapper call.

### Add to the smoke test

6. Submit via the **old** `/api/scores` path on a paid fight → balance must drop
7. Edit that same entry again via `/api/scores` → predictions change, **balance does not**

---

## Refunds — built

Two admin endpoints, both idempotent, both inside the same transaction wrapper:

```
POST /api/admin/fights/:fightId/refund           → refund every entry (cancellation)
POST /api/admin/fights/:fightId/refund/:userId   → refund one player (dispute)

Headers: Authorization: Bearer <admin token>
Body:    { "reason": "Fight cancelled by promoter" }   // optional
```

### The refund amount comes from the ledger, not the fight

This is the important design decision. `fight.matchTokens` can be edited *after* players have entered — so refunding the current fee would pay some players too much and others too little. Each refund reads that player's original `FIGHT_ENTRY` ledger row and returns exactly what they were charged.

Entries that predate the charging fix have no debit row, so there is nothing to give back. They're voided, and reported with `note: 'no charge on record'` rather than silently paid out.

### Per refund

1. Skip if a `fight:refund:<fightId>:<userId>` ledger row already exists — never pay twice
2. Read the original `FIGHT_ENTRY` debit for the exact amount
3. Credit `user.tokens`, write a `FIGHT_ENTRY_REFUND` ledger row
4. Mark the `Score` as `refunded` (kept for history, not deleted)
5. Flip the fight's entry marker back to `notSubmitted`
6. Decrement `fight.pot` by the total refunded

### Schema addition

`scoreSchema` gains `refunded` (indexed), `refundedAt`, `refundReason`. Existing documents simply lack the field, which reads as not-refunded. No migration needed.

### A leak the refund work itself created — closed

Marking an entry `refunded` meant the duplicate-entry checks would still find it, so a refunded player re-entering would have been treated as a **free edit**. All three lookups now exclude refunded rows:

- `createFightEntry` fast-path check
- the in-transaction race re-check
- the legacy `/api/scores` edit-vs-new decision

A refunded player who re-enters pays again, which is correct.

### Refund smoke test

8. Refund a paid fight → each entrant's balance rises by **their own** original fee, pot drops by the total
9. Run the same refund again → `refundedCount: 0`, **no balances change**
10. A refunded player re-enters → **charged again** (not treated as an edit)
11. Single-player refund → only that player is credited, others untouched

Step 9 and 10 are the ones that would cost you money if wrong.

---

## Affiliate payout — secured

`POST /affiliate/:id/payout` had three problems, all live:

1. **No authentication.** The affiliate came from `:id` in the URL, so anyone could request a payout against any affiliate account.
2. **No balance check.** `amount` was taken straight from the request body and pushed to the payouts array — a caller could request any figure, unrelated to what they'd actually earned.
3. **No debit.** The balance was never reduced, so the *same* balance could be requested over and over.

Now:

```js
app.post('/affiliate/:id/payout', verifyToken, async (req, res) => {
  const affiliateId = String(req.user?.id || req.user?._id || '').trim();
```

- Requires a Bearer token; the affiliate comes from the token. `:id` stays in the path for compatibility but is **no longer trusted**.
- `amount` is validated: must be > 0 and ≤ the real balance → `400 INSUFFICIENT_BALANCE` with the actual figures.
- The balance is **debited immediately**, so the same earnings can't be claimed twice while a request is outstanding.
- A second request while one is pending → `409 PAYOUT_ALREADY_PENDING`.
- `status: 'pending'` matches the existing schema default (lowercase), so any admin filtering still works.

**Important for whoever processes payouts:** because the debit happens at request time, a rejected payout must credit the amount back. That path is now built (below).

## Payout administration

Three admin endpoints, all `verifyAdminToken`:

```
GET  /api/admin/affiliate-payouts?status=pending|paid|rejected|all
POST /api/admin/affiliate-payouts/:affiliateId/:payoutIndex/approve
POST /api/admin/affiliate-payouts/:affiliateId/:payoutIndex/reject
```

**The list** is the work queue — every request across all affiliates, newest first, with the affiliate's name, email, preferred payment method, current balance, amount and request date.

**Approve** marks it `paid`. The balance stays debited, because the money actually went out. Pass `reference` in the body to record the payment reference.

**Reject** marks it `rejected` and **credits the amount back**. This is the important one: since requesting debits immediately, a decline without a credit-back would silently destroy the affiliate's earnings.

Both are **idempotent** — a payout that's already resolved returns `alreadyResolved: true` and moves no money. Clicking approve twice cannot double-pay; clicking reject twice cannot double-credit.

The payout subschema gained `resolvedAt`, `resolvedBy` and `reason`, so you have an audit trail of who actioned what and why. Existing payout records simply lack those fields and read as pending.

## Still to do (backend)

**Retire the legacy route** once the website's prediction room posts to `/api/fights/:fightId/entries`. It's safe now, but two doors into the same room is more surface area than you need.

**Admin UI for refunds.** The endpoints exist but nothing in the back office calls them yet — refunds are API-only until your developer wires a button to them.

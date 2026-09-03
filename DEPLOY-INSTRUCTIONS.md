# DEPLOY INSTRUCTIONS — read before touching anything

Two downloads. **They must go live together.** Backend alone breaks predictions; frontend alone breaks entries.

- **Backend** → `WajihulHassan944/fantasymmadness-game-server-three` (single file: `server.js`, plus `.gitignore`)
- **Frontend** → `WajihulHassan944/fmm-ver2` (full Next.js repo)

---

## Step 1 — BEFORE deploying: rotate JWT_SECRET

`.env` is committed to the backend repo. Every security fix below is enforced by tokens that `JWT_SECRET` signs. Anyone who has read that repo can forge an admin token and walk past all of it.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Set the new value in your host's environment variables (not in a file), then:

```bash
git rm --cached .env
git commit -m "Stop tracking .env"
```

Also rotate the DB connection string, payment keys, mail credentials, Cloudinary and Google OAuth values. Full steps in `URGENT-EXPOSED-SECRETS.md`.

**Rotating logs every user out.** Do it in a quiet window. Skipping this makes the rest of this work close to pointless.

---

## Step 2 — Deploy backend

Replace `server.js`. No new dependencies, no migrations.

Optional env vars (all have sane defaults):

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_TOKEN_TTL` | `30d` | Player/affiliate session length (was 1h) |
| `SESSION_COOKIE_MAX_AGE` | 30 days in ms | Matching cookie lifetime |
| `FIGHT_ENTRY_ALLOW_NON_TRANSACTIONAL` | unset | **Leave unset in production.** Dev-only escape hatch for standalone Mongo |

**Requires a MongoDB replica set** (Atlas has one by default). Entries run in a transaction so the wallet debit and the prediction save can't come apart. On standalone Mongo every paid entry fails loudly.

## Step 3 — Deploy frontend

Standard Next.js build. `.npmrc` (`legacy-peer-deps=true`) is included and required — several React ecosystem packages still declare React 18 peers against your React 19.

```bash
npm install
npm run build
```

Deploy within minutes of the backend, not hours.

---

## Step 4 — Smoke test in this order

Money first. Stop and report if any of these fail.

1. **Free fight** (`matchTokens: 0`) → entry succeeds, balance unchanged
2. **Paid fight, funded** → balance drops by **exactly** the fee; pot rises; ledger row written
3. **Same fight again** → "already entered", **balance does not move**
4. **Double-tap submit** → one entry, one charge
5. **Paid fight, underfunded** → 402, correct shortfall, **no debit and no entry**
6. **Refund a fight** → each entrant regains **their own** original fee; pot drops by the total
7. **Refund again** → `refundedCount: 0`, no balances move
8. **Refunded player re-enters** → **charged again** (not treated as a free edit)
9. **Payout request** → balance debited, request appears in the admin queue
10. **Reject that payout** → amount **returns** to the affiliate
11. **Buy coins** → after payment you land back on the page you left, funded, automatically

3, 4, 7 and 8 are the ones that cost real money if they're wrong.

Then the flow checks: sign in inside the app; enter a fight as a guest and confirm your picks survive signup; join a league logged out and confirm you land in that league; complete a 12-round boxing card and confirm submit stays locked until every round has a winner.

---

## What changed, and why it mattered

**Entry fees were never charged.** `/api/scores` saved a prediction and never touched the wallet — the only fee check was in the browser. Every paid contest entry was free, and pots never grew. Replaced with `POST /api/fights/:fightId/entries`, which authenticates, reads the fee **from the fight record** (never the request), debits, saves and increments the pot in **one transaction**. The legacy route now shares the same code path, so no route can create a free entry. Editing an existing entry before lock stays free — that's intended.

**Fight scoring had no authentication.** `POST/PUT /api/admin/matches/:id/scoring` sets official results, which decide who wins the pot. Anyone with the URL could declare a winner and trigger a real payout. Now admin-only.

**Coin minting was open.** `/api/reward-tokens/:userId` and three siblings credited a wallet from an amount in the request body with no auth. `/api/deduct-tokens` took `userId` from the body, so anyone could drain any player. All now authenticated; deduct derives the user from the token.

**Predictions were impersonatable.** `/api/scores` and `/api/matches/:id/updatePredictionStatus` identified the user by an ID in the body. Both now token-derived.

**Bulk fight delete was open** — all four routes. Deleting fights destroys the paid entries attached to them.

**Payouts** could be requested for any amount, for any affiliate, repeatedly, and never debited. Now token-bound, validated against the real balance, debited on request, with a pending guard. Admin approve/reject added — **reject credits the amount back**, which is mandatory since requesting debits immediately. Both idempotent.

**Spin wheel and signup bonus** trusted client-supplied values. The wheel now validates the prize against the server's own segment list (`0,1,2,3,4,5,7,10,200`) and binds the credit to the signed-in account.

**Sessions expired after 1 hour.** A player who signed in early got 401s the moment they tried to enter a fight later — at the money step. Now 30 days, with `POST /api/auth/refresh` renewing silently on app launch. **Admin tokens stay at 1 hour deliberately.**

**Per-round scorecards.** The scoring engine indexes `predictions[i]` against round *i*'s actual stats. The app submitted one whole-fight object, so it scored against round 1 and silently forfeited every other round. Boxing/MMA/kickboxing/BKFC now collect a winner and stats per round, driven by `maxRounds`. Wrestling stays one card. Submit is blocked until every round has a winner. QUICK FILL sets all rounds in one tap for long cards.

**Everything now happens inside the app** — predictions, signup/login, league join, affiliate dashboard, payouts, admin refunds. Only two things leave, and both should: Etsy for apparel, and the processor's hosted page for card entry. Payment returns the user automatically to the page they left.

---

## Still open — needs a decision, not code

- **`RESTRICTED_STATES` is empty on purpose.** Paid fantasy is restricted in some US states. Set the env var to a comma-separated list of two-letter codes after legal review (e.g. `RESTRICTED_STATES=WA,ID,MT,NV,AZ,LA`) and the eligibility gate enforces it immediately — no code change. Left empty so nothing is blocked on a guess.
- **`MINIMUM_PLAY_AGE`** defaults to 18. Change the env var if your legal advice differs.
- **Affiliate tax IDs are stored encrypted by you.** Consider a payout provider (Trolley, Tipalti) that collects W-9s and files 1099s instead — it removes SSN handling from your database entirely.
- **Rate limiting is in-memory.** Fine on one instance. If you scale horizontally, move the counters to Redis or each instance limits separately.
- **Spin wheel odds** — the server validates the prize is a real wheel segment, but the client still decides *which* segment. If you want provably fair odds, the server should pick.
- **No FM+ auto-renewal handling** — cancellation exists, but recurring billing is not wired.

## New environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_TOKEN_TTL` | `30d` | Player/affiliate session length |
| `SESSION_COOKIE_MAX_AGE` | 30 days (ms) | Matching cookie lifetime |
| `MINIMUM_PLAY_AGE` | `18` | Minimum age for paid entry |
| `RESTRICTED_STATES` | *(empty)* | Comma-separated state codes blocked from paid play |
| `TAX_1099_THRESHOLD_CENTS` | `60000` | $600 1099 threshold |
| `MAX_ACCOUNTS_PER_DEVICE` | `2` | Duplicate-signup limit |
| `PAYMENT_FAILURE_THRESHOLD` | `3` | Failures before an alert email |
| `PAYMENT_FAILURE_WINDOW_MS` | `900000` | 15-minute detection window |
| `PAYMENT_ALERT_COOLDOWN_MS` | `3600000` | Minimum gap between alerts |
| `FIGHT_ENTRY_ALLOW_NON_TRANSACTIONAL` | unset | **Leave unset in production** |

## New endpoints added this round

**Player** — `POST/GET /api/users/me/eligibility`, `POST /api/users/me/self-exclude`, `POST /api/users/me/deposit-limits`, `POST /api/auth/refresh`, `POST /api/checkout/claim-guest-orders`, `POST /api/support/tickets`, `POST /api/auth/check-duplicate`

**Affiliate** — `POST /api/affiliates/me/tax-details`

**Admin** — `GET /api/admin/affiliate-payouts`, `POST .../approve`, `POST .../reject`, `GET /api/admin/affiliate-tax-report`, `GET/PATCH /api/admin/support/tickets`, `GET /api/admin/duplicate-signups`, `POST /api/admin/fm-plus/:userId/cancel`, `POST /api/admin/fights/:fightId/refund[/:userId]`

## Frontend page added

`src/pages/refund-policy.jsx` — link it from your footer alongside Terms and Privacy. Payment processors generally expect a refund policy to be reachable from every page.

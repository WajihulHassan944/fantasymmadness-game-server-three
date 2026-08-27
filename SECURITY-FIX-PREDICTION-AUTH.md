# SECURITY FIX — prediction endpoint authentication

**⚠ Backend and frontend must deploy together.** The backend now rejects unauthenticated prediction submits. If you ship the backend alone, the website's prediction room breaks (401) until the frontend change is live.

---

## What was wrong

Two endpoints accepted the user's identity **from the request body with no token**:

```js
app.post('/api/scores', async (req, res) => {
  const { playerId, matchId, predictions } = req.body;   // playerId trusted from body
```
```js
app.post('/api/matches/:matchId/updatePredictionStatus', async (req, res) => {
  const userId = String(req.body?.userId || req.body?.playerId || '').trim();
```

Anyone could submit or overwrite **any user's** predictions by changing that id — no login, no token. Both are live in production today.

Your `verifyToken` middleware already existed and was correctly applied to ~25 other routes, including every Pro Wrestling prediction route. These two were simply missed.

---

## Backend changes — `server.js`

### 1. `POST /api/scores` (was line ~8981)
```js
app.post('/api/scores', verifyToken, async (req, res) => {
  const { matchId, predictions } = req.body;
  const playerId = String(req.user?.id || req.user?._id || '').trim();
```
- Requires a valid Bearer token.
- `playerId` now comes from the verified token; **the body value is ignored**.
- Returns 401 when the token resolves to no user.

### 2. `POST /api/matches/:matchId/updatePredictionStatus` (was line ~3422)
```js
app.post('/api/matches/:matchId/updatePredictionStatus', verifyToken, async (req, res) => {
  const userId = String(req.user?.id || req.user?._id || '').trim();
```
- Same treatment: token-derived user, body `userId`/`playerId` ignored.

### 3. Moved the `verifyToken` definition (important)
`verifyToken` was declared at line ~6341 with `const`. The `updatePredictionStatus` route sits at line ~3422 — *above* it. Because `const` is not hoisted, adding the middleware there would have thrown:

```
ReferenceError: Cannot access 'verifyToken' before initialization
```

…and the server would not have booted at all. The definition now sits at line ~145, right after the body-parser middleware and before every route that uses it. Single definition, no duplicate declaration.

### Not changed
`GET /api/scores` and `DELETE /api/scores` are untouched. Leaderboards, `FightLeaderboard`, `PublicFightLeaderboard`, `AffiliateFightLeaderboard`, `FinishedFightUserBoard` and `winnerUtils` all read via GET and keep working exactly as before.

---

## Frontend change — `src/Components/MakePredictions/MakePredictions.jsx`

`handleFinish()` now sends the token and stops sending the user id:

```js
const authToken = localStorage.getItem('authToken');
if (!authToken) { alert('Please sign in again to submit your predictions.'); ... return; }
const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };
// playerId / userId deliberately omitted — server derives the user from the token
```

Both calls use `authHeaders`. If the token is missing the user is asked to sign in rather than firing a request that would 401.

---

## Deploy order

1. Deploy **frontend and backend together**. Backend-only = broken prediction room; frontend-only = harmless (extra header the old server ignores).
2. If you must stagger, ship the **frontend first** — sending a token to the old endpoint is safe, and it is a no-op until the backend enforces.
3. Smoke test after deploy: log in, submit a prediction, confirm it saves and the status flips to `submitted`.

---

## Two things this fix does NOT solve

**1. Entry fees still are not charged.** `/api/scores` saves a prediction and nothing debits the wallet. The app checks the balance client-side, which enforces nothing. **Users can currently enter paid contests without paying.** That needs the atomic entry endpoint in `ENTRY-AND-CHARGING-DESIGN.md` — a wallet debit and prediction save in one transaction. This is revenue leaving the building.

**2. No idempotency.** A double-tap or a network retry can create duplicate submissions. `POST /api/scores` does update an existing `{playerId, matchId}` record rather than duplicating, which limits the damage today — but once a fee is attached, an `Idempotency-Key` becomes mandatory or you will double-charge people.

---

## Separate, urgent: `.env` is committed to the backend repo

`.env` (2,616 bytes) is tracked in `WajihulHassan944/fantasymmadness-game-server-three`. If it contains `JWT_SECRET`, `JWT_SECRET_ADMIN`, database credentials, mail credentials or payment keys, then **anyone with repo access has them**, and they are in the git history even if you delete the file now.

What to do:
1. Add `.env` to `.gitignore`.
2. `git rm --cached .env`.
3. **Rotate every secret it contains** — especially `JWT_SECRET`, since that signs the tokens this fix now depends on. Rotating it invalidates existing sessions; users will need to sign in again, which is the correct trade.
4. Set the values as environment variables in your host's dashboard instead.

Deleting the file without rotating the secrets does not fix the exposure — the history still holds them.

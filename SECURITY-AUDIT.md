# Full system security check — findings and fixes

Scope: `backend-fix/server.js` (17.7k lines, ~200 routes) and every `fmm-frontend`
call site affected by the changes. Method: every route registration was parsed
and checked for an auth guard, then each unguarded route was read to judge
whether it should be public.

Result: **102 routes had no auth guard.** Most are legitimately public (fight
cards, public leaderboards, webhooks with signature checks, login/register).
**34 were real gaps.** All 34 are fixed below.

---

## Critical — fixed

| # | Route | What an attacker could do | Fix |
|---|---|---|---|
| 1 | `POST /login`, `/loginAffiliate`, `/admin/login`, `/forgotPassword*` | NoSQL injection: `{"email":{"$ne":null}}` matches the first user in the collection and returns a valid session for an account you don't own | Global `stripMongoOperators` middleware drops `$`-prefixed and dotted keys from every body/query/params payload |
| 2 | `GET /sponsors/email/:email` (sponsor login) | Sponsor login was **email address only** — no password, no code. Knowing an address granted the sponsor dashboard, and the "session" was `isSponsorAuthenticated: 'true'` in localStorage | Replaced with emailed one-time code: `POST /api/sponsor/login/request` → `POST /api/sponsor/login/verify` → real JWT (`scope: 'sponsor'`). Route is now admin-only. Non-enumerating response |
| 3 | `PUT /update-profile/:userId` | Fully public — rewrite any player's name, phone, zip, **and their `isUSCitizen` eligibility flag**, by guessing an id | `verifyToken` + `requireSelf` |
| 4 | `POST /upload-avatar` | Email came from the request body — overwrite anyone's avatar and destroy their stored image | `verifyToken`; email resolved from the token |
| 5 | `GET /approveAffiliate/:id` | Open GET that flipped an affiliate to `verified`. A link-prefetching mail client could self-approve accounts | HMAC-signed link (`?t=`), or a valid admin token |
| 6 | `POST /addShadow` | Create shadow fights (the paid-contest templates) unauthenticated | `verifyAdminToken` |
| 7 | `POST /activate-match/:matchId` | Activate a fight **and trigger a mass email to every user and guest** — free spam cannon on your SMTP reputation | `verifyAdminToken` |
| 8 | `POST /update-match-status-shadow/:matchId`, `POST /update-match-shadow-open-status/:matchId` | Open or close any contest for entry at will | `verifyAdminToken` |
| 9 | `POST /redusers` | Suspend/ban **and delete** any user account by email, with a violation email sent to them | `verifyAdminToken` (was only rate-limited) |
| 10 | `GET /api/cron-job`, `GET /api/update-shadow-open-status` | Anyone could trigger fight rollover and affiliate mail blasts on demand, repeatedly | New `verifyCronSecret` (`CRON_SECRET` header, or an admin token for manual runs) |
| 11 | `PUT /update-profile-affiliate/:userId` | Rewrite any affiliate's profile | `verifyToken` + `requireSelf` |
| 12 | `POST /upload-sponsor`, `PUT /sponsor/:id`, `POST /api/create-blog`, `POST /upload-affiliate-reward` | Publish arbitrary content and images to the live site | `verifyAdminToken` |

## Data exposure — fixed

| Route | Was leaking | Fix |
|---|---|---|
| `GET /admin/device-info`, `GET /admin/device-info-spin-wheel` | Every device id paired with a player email. The spin wheel downloaded the whole table on page load just to test one device | Admin-only. New scoped `GET /api/spin-wheel/eligibility?deviceId=` and `GET /api/guest-coins/eligibility?deviceId=` return a boolean; `SpinWheel.jsx` repointed |
| `GET /users/removed-matches` | Every player's trashed-fight list | `verifyToken`, returns only the caller's rows (admins still get all) |
| `GET /user/:userId/removed-matches`, `GET /notifications/:userId` | Any user's data by id | `verifyToken` + `requireSelf` |
| `GET /affiliates` | Affiliate email, phone, payout preference — called from **player-facing** Leagues and Promo screens | Admin-only. New `GET /api/public/affiliates` with a public projection (no email/phone/payout); player screens repointed |
| `GET /api/public/leagues` | Same affiliate PII, plus joined players' emails, on a fully public route | Public projection for leagues; joined members reduced to name + avatar |
| `GET /api/referrals` | Names of every referred account on a public leaderboard | Public but count-only; referred-user identities removed |
| `GET /dashboard-counts`, `GET /api/admin-tokens`, `GET /api/users/nonregistered`, `GET /redusers`, `GET /api/notifications`, `GET /api/messages/get` | Business metrics, profit records, the guest mailing list, admin chat | `verifyAdminToken` |

## Frontend wiring

Locking those routes broke every screen that called them with no header — so
each caller was updated. New shared helper: `fmm-frontend/src/Utils/authFetch.js`
(`adminHeaders`, `userHeaders`, `affiliateHeaders`, `adminJsonHeaders`,
`userJsonHeaders`, `hasAdminSession`).

Updated: `Admin.jsx`, `AdminRecords.jsx`, `AdminSponsor.jsx`, `AffiliateUsers.jsx`,
`AffiliatesPayouts.jsx`, `ShadowFightsLibrary.jsx`, `RegisteredUsers.jsx`,
`SuspendedAccounts.jsx`, `NonRegisteredUsers.jsx`, `BlogsAiBot.jsx`,
`blogs/add-new-blog.jsx`, `Profile.jsx`, `UserAccountSettings.jsx`,
`AffiliateProfile.jsx`, `Dashboard.jsx`, `YourFights.jsx`, `TrashedFights.jsx`,
`SpinWheel.jsx`, `Leagues.jsx`, `PromoTwo.jsx`, `SponsorLogin.jsx`,
`AuthPortal.jsx`, `WrestlingAdminMatchForm.jsx`.

---

## New environment variables

```
CRON_SECRET=<random 32+ chars>       # required, or scheduled jobs return 503
ACTION_LINK_SECRET=<random 32+ chars> # optional; falls back to JWT_SECRET_ADMIN
```

## Still open (not code — operational)

1. **Rotate `JWT_SECRET` and `JWT_SECRET_ADMIN`** — they are in a committed `.env`.
   Every fix above rests on those secrets being secret.
2. Set `CRON_SECRET` and update the scheduler to send it, or cron returns 503 by design.
3. Confirm MongoDB is a replica set (entry/settlement transactions require it).
4. Set `RESTRICTED_STATES` after legal review.
5. Sponsor dashboard pages still trust `isSponsorAuthenticated` in localStorage for
   *rendering*. The data behind it is now token-gated (`GET /api/sponsor/me`), but the
   pages should be switched to that call so the shell can't be faked either.
6. `/track-click`, `/affiliate/:id/incrementViews`, `/threads/:id/views` remain public
   and rate-limited only — vanity counters can still be inflated. Left as-is
   deliberately; say the word if you want them device-signed.


---

# Pass 2 — affiliates, game flow, deployment readiness

Scope: all 34 affiliate routes and all 46 entry/prediction/settlement/payout
routes (301 routes total in the file), read individually for ownership checks,
race conditions and lock enforcement.

## Affiliates — audited clean

Every affiliate route that acts on an id in the path already derives the actor
from the verified token and refuses cross-affiliate access:

- `POST /affiliate/:id/payout` — affiliate id comes from the token, not the URL; balance debited with an atomic compare-and-set so two simultaneous requests cannot claim the same balance; a pending request blocks a second one.
- `POST /affiliate/updatePayment/:id` — owner check (`NOT_OWNER`). This is the bank-detail route; it was the one worth checking twice.
- `POST /affiliate/:affiliateId/remove-user` — league-owner check (`NOT_LEAGUE_OWNER`).
- `POST /affiliate/:affiliateId/join` — joining player taken from the token; body ids ignored.
- `POST /api/affiliates/me/shadow-fights/:fightId/stake` — promoter check (`NOT_PROMOTER`), and the pot is frozen once entries start.
- `GET /affiliateByName` — safe projection only (no email, payouts or tax fields).
- Payout approve/reject are admin-only, idempotent, and a rejection credits the balance back.
- Self-entry ban: a promoter cannot enter a contest they promote (`AFFILIATE_SELF_ENTRY`), enforced server-side.

### Fixed in this pass

| Issue | Detail | Fix |
|---|---|---|
| `POST /registerAffiliate` unlimited | No rate limit — unlimited affiliate accounts and unlimited Cloudinary uploads from one IP | `submitLimiter` |

Confirmed not a problem: `/registerAffiliate` and `/affiliate-google-login` both
hard-code `verified: false` and assign fields explicitly, so there is no
mass-assignment path to a self-approved or pre-funded affiliate.

## Game flow — two real holes, both fixed

**1. Predictions could be edited after the fight.** `POST /api/scores` charged and
lock-checked *new* entries through `createFightEntry`, but the edit branch — taken
whenever the player already had an entry — wrote new predictions with no lock check
at all. An existing entrant could rewrite their card after the fight ended, or
after the official round stats were entered, and submit a perfect scorecard.
Edits now go through the same `isFightOpenForEntry` gate and are refused once
`prizesSettledAt` is set (`FIGHT_LOCKED` / `FIGHT_SETTLED`).

**2. A fight could be settled twice.** `POST /api/admin/fights/:fightId/settle`
checked `prizesSettledAt` and then paid out — read-then-write. Two concurrent
calls (a double-click, or a retried request) both passed the check and both paid
the full pot: double prize money and a double promoter share. Settlement is now
claimed atomically (`findOneAndUpdate` on `prizesSettledAt: null`) before any
money moves; the loser of the race gets `alreadySettled: true`. If settlement
throws mid-run the claim is released so an operator can retry, and every credit
is already in the wallet ledger, so a retry is auditable.

Verified sound, no change needed: entry charging is transactional and idempotent
(`idempotency-key`), the fee is read from the fight and never from the client,
refunds are computed from the **ledger** rather than the current fee (the fee can
be edited after players enter), refunds are idempotent per player, eligibility is
gated on paid entries only, and scoring runs server-side.

## Deployment readiness — added

**Boot configuration guard.** Every auth check rests on `JWT_SECRET` /
`JWT_SECRET_ADMIN`. A missing value failed *silently at request time* —
`jwt.verify(token, undefined)` throws, so every protected route returned 403 with
no clue why. The server now validates configuration at boot and, in production,
refuses to start when:

- `MONGODB_URI`, `JWT_SECRET` or `JWT_SECRET_ADMIN` is missing
- either secret is under 32 characters or a known placeholder
- `JWT_SECRET === JWT_SECRET_ADMIN` (a player token would pass admin checks)

and warns when `CRON_SECRET`, `AUTHORIZE_NET_SIGNATURE_KEY` or `SMTP_PASS` is
absent, naming the feature each one silently disables.

## Pre-launch checklist

1. Rotate `JWT_SECRET` and `JWT_SECRET_ADMIN` to fresh 32+ character random values, and make them different from each other. They are in a committed `.env`; nothing else matters until this is done.
2. Set `CRON_SECRET` and add it to the scheduler as `x-cron-secret`.
3. Set `ACTION_LINK_SECRET` (or accept the `JWT_SECRET_ADMIN` fallback) for signed affiliate-approval links.
4. Confirm MongoDB is a **replica set** — entry and refund transactions require it and fail loudly on a standalone.
5. Set `RESTRICTED_STATES` after legal review.
6. Confirm `AUTHORIZE_NET_ENVIRONMENT=production` and that `AUTHORIZE_NET_SIGNATURE_KEY` is live, not sandbox.
7. Smoke test in this order: register → verify email → buy coins → enter a paid fight (balance drops once) → try to edit predictions after lock (must refuse) → admin settles (winners paid once) → settle again (must return `alreadySettled`) → affiliate requests payout → admin rejects (balance returns).
8. Sponsor sign-in: request a code, confirm the email arrives, confirm a wrong code fails and expires after 5 attempts.

## Pass 3 — token scopes (done)

Player, affiliate and sponsor sessions were all signed with the same
`JWT_SECRET` and carried only `{ id }`. Nothing was exploitable, because ids
never collide across collections — but that was a coincidence, not a rule, and
one shared id space away from being a real cross-audience hole.

Every session token now declares its audience — `scope: 'player' | 'affiliate' |
'sponsor'` — issued at `/login`, `/google-login`, `/loginAffiliate`,
`/affiliate-google-login` and the sponsor code exchange. `/api/auth/refresh`
carries the original scope through, so renewing a session can never widen it.

`requireScope()` asserts the audience on the routes where it matters:

- **Player only** — fight entries, `/api/scores`, wallet spend, deduct-tokens, daily rewards, guest-coin and spin-wheel credits, own fight entries, joining a league.
- **Affiliate only** — payout requests, payment details, league member removal, tax details, Shadow Fight stake and status, affiliate profile.
- **Sponsor only** — `/api/sponsor/me`.

Tokens issued before this change have no `scope` claim. Rather than log everyone
out mid fight-night, `requireScope` treats a missing scope as legacy-and-allowed
and rejects only a scope that is present and wrong (`WRONG_TOKEN_SCOPE`). Once the
30-day session TTL has rolled over, every live token carries a scope and the
allowance is dead weight — **delete the legacy branch in `requireScope` 30 days
after deploy** to make the assertion absolute.

Frontend: the sponsor token is stored as `sponsorAuthToken` only, no longer
aliased into `authToken`, so a sponsor session cannot be presented to a player
money route.


---

# Head-to-Head — shipped as a waitlist

Head-to-Head had a live "+ CHALLENGE" button, a wager input, a "Max Head-to-Head
Wager" setting and an "Auto-Settle Challenges" toggle — and **no backend at all**.
No challenge model, no escrow, no settlement. A player could set a stake and
nothing happened. Rather than build peer-to-peer wagering before the
`RESTRICTED_STATES` legal review comes back, the app now measures demand.

## What ships

- **Leagues screen** (`renderLeagues`) gains an in-development Head-to-Head card: what the feature will be, a live count of how many players want it, and a "NOTIFY ME WHEN IT OPENS" button. Once joined it reads "YOU'RE ON THE LIST".
- **Waitlist modal** captures email (auto-filled for signed-in players) and an optional self-reported stake band — `1-100`, `100-500`, `500-1k`, `1k+`. That band is the number worth reading before writing escrow code; it is a signal only and is never used as a limit.
- **Admin dashboard** gains a "Feature demand" panel: signups per feature, how many are signed-in players, and the stake-band distribution.

## Removed, because it configured a feature that does not exist

- `Auto-Settle Challenges` toggle
- `Max Head-to-Head Wager` picker (and `setWagerLimit`, `settings.wagerLimit`, `settings.autoSettle`)
- `respondChallenge` / `autoSettleChallenge` — a client-side simulation that credited coins with `Math.random()`
- `renderLeaguesLegacy` — 200 lines of dead renderer carrying the demo challenge UI
- Copy that promised challenges: push-notification and auto-payout descriptions, and the settings subtitle

## API

```
POST /api/waitlist/head-to-head      # rate-limited, guests allowed, idempotent per email
GET  /api/waitlist/head-to-head/me   # joined? + total
GET  /api/admin/waitlist             # admin: totals, stake bands, recent 200
```

Signed-in players are matched on their account email, not on anything the client
sends. One row per email per feature — re-joining updates rather than duplicates.
The feature list is a server-side allowlist (`WAITLIST_FEATURES`), so the route
cannot be used as an arbitrary data dump.

## When you decide to build it

The decision input is the stake-band spread, not the raw signup count — it tells
you the escrow size to design for. Build it on the entry/settlement patterns that
are now hardened: authoritative server-side amounts, an atomic claim before money
moves, ledger-based refunds, and lock enforcement on both create **and** edit
paths. Get the `RESTRICTED_STATES` answer first.


---

# Head-to-Head — built, shipped dark

Built on the existing pipeline rather than as a parallel money system, because
the platform is already the referee: it escrows both stakes in its own ledger,
scores both cards server-side from the official round stats, and pays out. A
head-to-head is a contest with two entrants.

## What is reused, not rebuilt

| Concern | Reused from |
|---|---|
| Stake debit/credit | `moveChallengeStake` → the same `FightEntryLedger` + `recordWalletMove` audit trail as fight entries |
| Transactions | `runFightEntryTransaction` / `withFightSession` |
| Scoring | `calculateClassicPredictionPoints` on the same official round stats — neither player touches it |
| Lock rule | `isFightOpenForEntry` |
| Eligibility | `checkPlayEligibility` (age, state, self-exclusion) |
| Settlement discipline | atomic status claim before any money moves, as in fight settlement |

## The invite lifecycle (the only new logic)

```
POST /api/challenges                        create + escrow challenger's stake
POST /api/challenges/:id/accept             escrow opponent's stake
POST /api/challenges/:id/decline            release escrow (either side may back out)
GET  /api/challenges/me                     my challenges, both directions
POST /api/admin/fights/:id/settle-challenges  admin sweep (also runs inside fight settle)
GET  /api/cron/challenges/expire            expiry sweep, CRON_SECRET
GET  /api/public/features                   tells the app: live feature or waitlist
```

Rules that took a decision:

- **Both players must already have a scorecard in the fight** (`NO_ENTRY_YET`). The challenge scores off their real entry — there is no second prediction surface, and no way to wager on a card you never submitted.
- **The challenger's stake is escrowed at create**, not at accept, so the coins being offered cannot be spent elsewhere while the invite is open.
- **Invites expire at the prediction lock, or 24h, whichever is sooner.** An unaccepted challenge must never outlive the thing it is betting on. Expiry returns the stake.
- **A draw returns each side's own stake** rather than splitting a pot — same amount, but it reads correctly in the ledger. Ties matter here: level scores between two players are common where a tie across a 40-player pot is not.
- **A refunded or missing card cannot win.** If neither player has a valid card, both stakes go home — the platform does not keep money from a contest that never really happened.
- **Opponents are resolved by player name or email**, never by a client-supplied id, so a challenge cannot be aimed at an arbitrary account row.
- **One live challenge per pair per fight** (partial unique index on PENDING/ACCEPTED), so a rematch is still possible after a decline or on another fight.
- Settlement runs **inside the existing fight settle action** — one admin click settles the pot and the challenges — but with its own per-challenge claim, so a challenge failure cannot unwind the pot payout.

## It is off

```
HEAD_TO_HEAD_ENABLED=false            # default; every route 404s with FEATURE_DISABLED
HEAD_TO_HEAD_RESTRICTED_STATES=       # stricter than RESTRICTED_STATES when set
HEAD_TO_HEAD_MIN_STAKE=10
HEAD_TO_HEAD_MAX_STAKE=5000
```

The app reads `GET /api/public/features` and renders the live challenge UI or the
waitlist card accordingly — **flipping the flag needs no new build**. If legal
comes back with a state list, put it in `HEAD_TO_HEAD_RESTRICTED_STATES`: the
existing eligibility gate then blocks those players at create and accept while
pooled contests keep working for them.

## Smoke test when you turn it on

1. Two accounts, both with a scorecard in the same open fight.
2. A challenges B for 100 FM → A's balance drops 100, B gets an email.
3. B declines → A's balance returns to where it started, ledger shows both moves.
4. A challenges B again, B accepts → both balances down 100.
5. Try to accept twice → second attempt returns `CHALLENGE_NOT_PENDING`, no second debit.
6. Admin enters round stats and settles the fight → higher card receives 200 FM, both get result emails, pot contest settles in the same action.
7. Settle again → `alreadySettled`, no second payout.
8. Create a challenge and let it pass the lock unaccepted → run the expiry cron, stake returns.
9. Challenge a player with no scorecard → `NO_ENTRY_YET`. Challenge yourself → `SELF_CHALLENGE`.


---

# Pass 4 — logging, output, uploads, replay

## Fixed

| Issue | Detail |
|---|---|
| **Bearer tokens written to logs** | `verifyToken` ran `console.log('Request headers:', req.headers)` on **every authenticated request**. Anyone with log access — or a log aggregator — could lift a live session token and resume a player's session. Removed. |
| **Plaintext passwords written to logs** | `/register` logged the whole request body, and the validation warning logged `{ email, password }` by value. Both now log presence booleans only. |
| **Internal errors returned to clients** | 32 responses serialized the caught error (`{ message, error }`, `error: error.message`, `details: err.message`) — mongoose validation internals and occasionally connection strings. Stripped, plus `console.error` added at 22 sites that were silently swallowing failures. New `serverError()` helper for the generic path. |
| **Uploads accepted anything** | The multer filter trusted the client's `Content-Type`: it allowed `image/*`, `application/octet-stream`, **and a missing type** — i.e. every file. Uploads go to Cloudinary on our account and are served from URLs we hand to browsers, so an SVG carrying `<script>` is stored XSS. Now validated by **file signature** (JPEG/PNG/GIF/BMP/WebP/HEIC magic bytes); SVG and HTML rejected outright. Wrapped `upload.single/fields/array` so all 16 call sites are covered without touching the routes. |
| **Email HTML injection** | The contact form interpolated `fullName`/`subject`/`message` straight into the admin email body — a visitor could inject a link or a fake "reset your password" block into mail arriving from our own address. Escaped and length-capped through the existing `escapeHtml`. |
| **Unbounded queries** | Email blasts ran `User.find()` with no projection — loading every user document, password hashes included, into memory. Now projected and capped. Eight other wholesale `find()` calls bounded. |

## Verified sound — no change needed

- **Payment webhook replay is safe.** `settlePaidCoinOrder` / `settlePaidFmPlusOrder` run inside a transaction with a `status === 'CREDITED'` early return and a status-transition guard, so a replayed webhook credits nothing. Two concurrent replays conflict on the same document and one aborts.
- **Apparel order emails** already escape every user field.
- Signature verification on both webhooks uses a timing-safe comparison.

## Known, deliberately not changed

- **JSON-LD blocks** (`SeoHead`, blog details, shadow pages) inject `JSON.stringify(data)` into a `<script>` tag. A blog title containing `</script>` would break out. Low severity — the content is admin-authored — but worth a `.replace(/</g, '\\u003c')` when convenient.
- `BlogsAiBot.jsx` renders AI output with `dangerouslySetInnerHTML`. Admin-only page, admin-authored input.
- The in-memory rate limiter is per-instance. On more than one instance the counters diverge — move to Redis if you scale out.
- Vanity counters (`/track-click`, view increments) stay public and rate-limited only.

## What has now been checked, by lens

1. Route authentication — all 301 routes
2. Ownership / cross-user access — every route taking an id
3. Money races, idempotency, transactions — all 46 entry/settlement/payout routes
4. Prediction lock enforcement — create and edit paths
5. Token audience — all five login paths
6. Secrets and boot configuration
7. Data exposure in responses and logs
8. Upload content validation
9. Webhook replay
10. Injection into emails and rendered output
11. Query bounds
12. Dead UI / no-op buttons

Not covered, and not "someone takes your money" work: load and index performance,
accessibility, dependency CVEs, and browser/device QA.


---

# Pass 5 — app-wide sweep (frontend)

Previous passes were backend-heavy. This one walked the app: navigation, sessions,
dead ends, and the screens my own earlier changes touched.

## Found and fixed

| Issue | Detail |
|---|---|
| **Sponsor sign-out left the credential behind** | `handleLogoutSponsor` removed `isSponsorAuthenticated` and `sponsorData` but not `sponsorAuthToken` — the display flag went, the actual session token stayed on the device. On a shared computer the next person could still call sponsor endpoints. Introduced by my own sponsor-login change earlier in this session. |
| **In-app sign-out only ended the player session** | `logoutInApp` cleared `authToken` alone. Now clears player, admin, affiliate and sponsor sessions together — a shared phone should not keep an affiliate session alive because the player signed out. |
| **Sponsor dashboard was permanently stuck loading** | It parsed `JSON.parse(sponsorData)?.data?.[0]` — the shape of the *old* email-only login response. The new login stores a single sponsor object, so that lookup returned undefined and the page never left "Loading sponsor details…". **My change broke this page and I did not notice until this sweep.** |
| **Sponsor dashboard trusted localStorage** | It rendered whatever was in `sponsorData` with no server call, so a fabricated entry produced a working-looking dashboard. Now loads from `GET /api/sponsor/me` with the session token, and shows a proper "session ended" state with a route back to sign-in. |
| **`/sponsor-login` did not exist** | My AuthPortal change redirected sponsors to `/sponsor-login`, which had no page file — a 404, meaning **sponsors could not sign in at all**. The `SponsorLogin` component existed but nothing ever mounted it. Added `pages/sponsor-login.js`. |

## Verified clean

- **No dead buttons.** One "COMING SOON" label in `MembershipCheckout`, on a correctly `disabled` button — honest, not a no-op.
- **Every internal link resolves.** Checked all `router.push` and `href` targets across the header, footer, admin nav, auth portal and mobile shell against the 150 real page routes (including dynamic segments). No broken destinations.
- **Startup performance holds.** The header banner is a true 16:9 asset with a `<picture>` source swapping in a 900×507 mobile version below 767px, with explicit dimensions to prevent layout shift. The two calls I added this session (`/api/public/features` and challenge/waitlist status) run in effects with defaults already in state, so neither gates first paint, and the features route touches no database.

## Note on where these came from

Three of the five findings in this pass were **regressions I introduced earlier
in this session** — the sponsor token surviving logout, the dashboard parsing the
old response shape, and the missing sign-in route. Replacing an authentication
flow touches more surfaces than the diff shows: the login screen, the route that
serves it, the dashboard that consumes the session, and the logout that ends it.
Worth remembering for the head-to-head switch-on: when `HEAD_TO_HEAD_ENABLED`
flips, walk the same four surfaces rather than trusting the flag.

## Known, not changed

- `sponsorData` is still written to localStorage at sign-in. Nothing reads it now that the dashboard calls the server — harmless, and left alone to avoid touching the login path again this session.
- The **bold hero** image on the home screen (`bold-hero-new.jpg`, 403KB at 1983px) has no mobile variant. It is `loading="lazy"` so it does not affect app startup, but phones fetch a 1983px image to paint it a few hundred pixels wide. Roughly 300KB of scroll weight, available whenever you want it.


---

# Owner Check — read-only platform inspection

A single owner account (`OWNER_EMAIL`, default `fantasymmadness2@gmail.com`) can
sign in at `/owner` with an emailed 6-digit code and inspect the whole platform.

## Deliberately powerless

There is **no write endpoint** beyond signing in. Every money action stays behind
admin auth with its existing audit trail. A leaked owner code costs information,
not money — which is the only reason it is safe to have a credential that sees
everything.

- Separate secret (`JWT_SECRET_OWNER`) from player and admin, so no single compromise spans roles.
- Session is **1 hour**, not 30 days. You are checking, not living there.
- Code expires in 10 minutes, 5 attempts, hashed at rest, timing-safe comparison.
- Requesting a code for any other address returns the **identical** response and sends nothing — the endpoint never confirms the owner address.
- Every successful sign-in emails the owner with time and IP, so an unexpected one is visible immediately.

## What it answers

**Configuration** — each row green or red with the consequence spelled out:
database transaction support, payment provider live vs sandbox, webhook signing
key, email delivery, cron protection, whether the admin and player secrets
differ, restricted-state list.

**Integrity — the money invariants.** These are questions nothing in the app could
answer before:

1. **Paid entries with no ledger row** — an entry fee taken with no audit trail.
2. **Wallets with an unrecorded balance change** — every ledger row stores the balance before and after, so a gap between consecutive rows proves a balance moved outside the ledger. This is the check that would have caught the pre-hardening leaks.
3. **Fights with entries awaiting settlement** — players paid in and have not been paid out.
4. **Coin orders stuck or failed over an hour old** — money possibly taken without coins credited.
5. **Payouts pending over 48 hours** — affiliates waiting.
6. **Challenges holding coins on a settled fight** — escrow not released (only when Head-to-Head is on).

Each reports a count, a plain-language explanation, and at most 10 sample rows —
never a bulk dump.

**Live counts and feature flags** — players, affiliates, open fights, entries in
the last 24h, pending payouts, and which features are on so Head-to-Head being
dark is verifiable at a glance.

## Nightly

`GET /api/cron/owner-integrity` (cron secret) runs the same checks and emails the
owner **only when something is wrong**. Silence means the books balance, which
keeps the email worth reading.


---

# Phone fixes — load time, header, quick owner access

## The 10-second blank wait

The loader looked staged but was not. Four "critical" calls were batched with
`Promise.allSettled`, which resolves only when **all four settle** — so the first
paint waited for the slowest endpoint, and one sluggish response held the entire
screen blank. The "secondary" batch had the same shape.

Rewritten so every request paints the moment **it** lands: results accumulate and
the view re-composes on each arrival. Also:

- First page of fights reduced from 80 to 20; the full 80 loads underneath and replaces it.
- A 2.5s reveal timer: on a slow network the shell appears with whatever has arrived rather than holding a spinner.
- One failed section can no longer blank the screen.
- The response cache is written after the heavy sections land, so the next open is instant.

## The header not fitting

The artwork is 16:9 with the tagline and the BOXING / BARE KNUCKLE / PRO
WRESTLING labels baked into its **far edges**. Full-width on a 390px phone that
is a 390×219 strip where the edge text renders around 7px tall — unreadable, and
the title tiny. That is the "doesn't fit" complaint.

Fixed in CSS rather than with a new asset: on phones the image sits in a taller
box (5:4, and 4:3 under 400px) and is centre-cropped with `object-fit: cover`, so
the unreadable outer thirds fall away and the crown and title fill the space.
Desktop keeps the full 16:9 composition. The inline `aspect-ratio` was removed
from the element because an inline style would have overridden the media query.

*Rejected approach:* a pre-cropped phone asset. Every crop that gained useful
height sliced the baked-in text mid-word ("JUST / THE FIGHT. / DICT IT."), which
looks broken rather than tight — and the sandbox could only encode PNG, making
the file 2.6 MB against the 190KB it replaced. Browser-side cropping is smaller,
tunable via `object-position`, and clips nothing mid-word.

**Also found:** the hero's call-to-action was an invisible `<div>` tap target
positioned over empty canvas — nothing in the artwork marked it, so no player
could know it was there. Replaced with a real, visible 46px "PLAY FREE" button
with keyboard support.

## Quick owner access without an email code

Emailing a code every time is right for a new device and wrong for the phone in
your pocket. Now: prove it once by email, then unlock with a PIN.

- `POST /api/owner/device/trust` (owner session) — set a 4–8 digit PIN; the server returns a 32-byte device key **once** and stores only its hash. Obvious PINs (repeated digits, `1234`, `0000`) are refused.
- `POST /api/owner/login/device` — device key + PIN exchanges for a normal 1-hour owner session. The trust window slides on each use, so a phone you actually use stays trusted.
- **Five wrong PINs deletes the device record**, forcing an email code.
- `POST /api/owner/device/forget-all` — kills quick access everywhere from inside the view.
- Trusting a device emails the owner, so an unexpected setup is visible.

This is only defensible because the owner view is read-only. A PIN would be a bad
guard on anything that can move money; here the worst case is that someone
holding your unlocked phone reads numbers they could read over your shoulder.


---

# View as — owner sees the app as a player or affiliate

## Not impersonation

The token minted for this **cannot write**. `verifyToken` rejects any non-GET
request carrying `scope: 'owner-preview'` with `403 PREVIEW_READ_ONLY`. That check
lives at the single place every authenticated request passes through, so no route
can forget it and no future route can opt out. A preview session can look at
anything and change nothing — it cannot spend the person's coins, enter them into
a fight, edit their predictions, request their payout or alter their profile.

## How it works

```
GET  /api/owner/preview/search?q=   # owner session; players + affiliates, minimal fields
POST /api/owner/preview/token       # mints a 20-minute read-only token for one account
```

The token is signed with `JWT_SECRET` so ordinary read routes accept it, but
carries the preview scope that blocks writes. `requireScope` lets a preview read
any role's screens — safe, because the GET-only rule has already applied.

Hand-off: the owner page opens the app in a new tab with the token in the URL;
the app moves it to **sessionStorage** and strips it from the address bar, so it
is not left in browser history or pasted into a shared link. `_app.js` hydrates
Redux from it, so the whole app — player screens or the affiliate dashboard —
renders as that account. It is never written to localStorage, so it cannot
outlive the tab or displace a real login, and `affiliateAuthSlice` explicitly
refuses to persist it.

A sticky amber banner is always visible while previewing: who is being viewed,
that it is read-only, and an Exit button.

## Limits, deliberately

- 20 minutes, then it simply stops working.
- Every preview start is logged server-side with the owner email and target id.
- Search needs two characters and returns at most ten of each type with minimal fields — it is a picker, not an export.


---

# Compliance build — jurisdiction modes and house-risk removal

Built against `fantasy_madness_compliance_framework.pdf`. **Not legal advice** —
this is the engineering half of a legal document, and a gaming attorney has to
confirm which states go in which list.

## What was already compliant

- **Skill dominance.** Scoring weights method of victory and exact rounds per round, not binary win/loss, and runs server-side where players cannot reach it.
- **Prize declared in advance.** `fight.pot` is set when the contest is created and is **never** incremented by entries — checked, because the framework leads with this. The federal exemption language ("prizes… not determined by the number of participants or the amount of any fees paid") was already satisfied on the prize side.
- **Fixed rake**, taken only at settlement.

## What was missing: house risk

The prize is fixed, so a thin contest was paid out of platform funds — the "no
house risk" condition the exemption depends on. Now:

- **Minimum entrants**, defaulting to **break-even** (`ceil(pot ÷ buy-in)`) when no explicit figure is set, so every existing fight is protected without editing the creation routes. This mirrors the figure affiliates already size campaigns with on the campaign screen.
- Below the minimum the contest **voids and refunds every entry from the ledger** rather than paying a prize the entries never covered.
- `POST /api/admin/fights/:fightId/prize-guard` sets or waives it per fight. Waiving returns an explicit warning that the platform now covers any shortfall — a deliberate choice rather than a blank field.
- The owner integrity report gained **"Open contests not yet covering their prize"**, so a shortfall is visible while there is still time to fill the contest.

## Prize fixed, revenue growing

The requirement constrains the **prize**, not the rake. So entry fees above the
declared prize are now tracked (`collectedFees` per fight) and settled as revenue:

- `surplus = collectedFees − declaredPot`
- The promoter receives their fixed cut **plus `AFFILIATE_SPLIT_PCT` of the surplus**, recorded in the wallet ledger with entrant count and fee total.
- Settlement responds with `collectedFees`, `declaredPrizePool`, `surplus`, `promoterSurplusShare`, `platformKept`, `entrants` and `breakEvenEntrants`.

Ten entrants or two hundred, the prize is exactly what was advertised — and
promoter and platform revenue scale with entries.

## Jurisdiction modes

One codebase, three modes, resolved from the player's state of residence:

| Mode | Entry fees | Coin purchases | Prizes | KYC |
|---|---|---|---|---|
| `paid` | real | yes | cash value | required |
| `free` | free | **refused** | status only | not required |
| `blocked` | — | — | — | no access |

- `PAID_STATES` is an **allowlist**. A state must be named there to take money; the default for everything else is free play. Failing closed is the only safe default.
- `BLOCKED_STATES` for states where even free play is unwelcome.
- `RESTRICTED_STATES` keeps working and is treated as free-play.
- **Per-state minimum age**: 21 in `AGE_21_STATES` (default `MA,AZ,IA,LA,AL,NE`), 18 elsewhere, enforced in `checkPlayEligibility` before any paid action.
- Coin and FM+ purchases are refused server-side outside paid states (`FREE_PLAY_ONLY`) — the free mode only holds if coins truly have no cash value there, so the block cannot live in the UI.
- `GET /api/public/jurisdiction` tells the app which mode to render, so enabling a state is an env change, not a release.

## Still not software

- The segregated escrow account (bank + processor arrangement).
- KYC and geolocation vendors — I can build both integrations; the contracts and keys are yours. Geolocation is not in the framework but licensed states require it; stated residence is not accepted on its own.
- Licence applications and fees (~$152k–$170k for the four states listed, before tax).
- Which states belong in which list. That is the attorney's answer, and it is the last real blocker.


## State configuration as shipped

- **Paid (45 states + DC)** — the default when `PAID_STATES` is blank. Set that variable only to *narrow* the list.
- **Free-play only, hard-locked: HI, ID, MT, NV, WA.** These five prohibit paid daily-fantasy contests. The lock is enforced twice — the resolved `PAID_STATES` list filters them out, and `resolveStateMode` checks them before anything else. Naming one in `PAID_STATES` is ignored and logs a warning at boot. A misconfigured deploy cannot start charging entry fees in a state that forbids them.
- **Unknown or unrecognised state codes resolve to free**, never paid. Unknown must not mean chargeable.
- Nevada being free-play is the interesting one commercially: the fight capital can still be built as a free leaderboard audience — reputation, badges, sponsor-backed prizes — with no entry fee and therefore no consideration.

**A caution that matters more than the code:** flipping a state to `paid` makes it
*technically* able to take entry fees. It does not make you registered or licensed
there. Several of those 46 require operator registration before paid contests, and
your own framework prices four of them at $50k, $50k, $50k and $2–10k in
application fees. The allowlist is a switch, not a permission. Narrow it to what
your attorney confirms and widen it as registrations land.


---

# Non-cash prizes — making free contests worth winning

In free-play states the entry fee is zero, so there is no consideration and no
wager — and also nothing to pay out of. Prizes there are things with no cash
value to the player: badges, leaderboard titles, sponsor merch and PPV codes the
sponsor funds.

**Kept deliberately separate from the wallet.** Coins are a balance; these are
awards. Putting sponsor prizes into coin balances would give "free" coins a cash
value and collapse the exact distinction the free mode depends on.

## Types

| Type | Fulfilment | Notes |
|---|---|---|
| `badge` | none | instant, shows on the profile |
| `title` | none | leaderboard title, e.g. "Vegas Champion" |
| `ppv_code` | none | claimed from a pre-loaded pool, one code per winner |
| `merch` | queue | physical goods, goes to the fulfilment queue |
| `sponsor_other` | queue | anything else a sponsor puts up |

## How awarding works

`awardNonCashPrizes` runs inside the existing settle action, so one admin click
settles cash prizes, head-to-heads **and** sponsor prizes. It ranks entrants by
the same scores the cash prizes use, so a winner is a winner in both.

- `place: 1|2|3…` awards to that finishing position; `place: 0` awards to **everyone who entered** (participation badges).
- **PPV codes are claimed atomically** with `$pop` on the code pool, so two winners can never receive the same code. An empty pool logs and skips rather than awarding a blank code.
- Every award carries an idempotency key, so re-running settlement cannot double-award.
- Winners are emailed, including the code where there is one.
- Unclaimed codes are **never returned** by the admin list endpoint — only the remaining count.

## Endpoints

```
POST   /api/admin/fights/:fightId/prizes    add a prize (place, type, name, sponsor, codePool)
GET    /api/admin/fights/:fightId/prizes    list, with codesRemaining
DELETE /api/admin/prizes/:prizeId           deactivate (awards already given are untouched)
GET    /api/admin/awards/fulfilment         queue of physical prizes to send, with winner contact
POST   /api/admin/awards/:awardId/fulfil    mark shipped/cancelled — emails the winner
GET    /api/users/me/awards                 the player's trophy case
GET    /api/public/awards/:userId           public showcase for profiles and leaderboards
```

## Free contests can now settle

Settlement previously assumed a pot. A contest with `matchTokens: 0` is now
flagged as free: the minimum-entrant guard is skipped (nothing was charged, so
there is no shortfall to protect against) and it still settles so awards are
handed out.

## Owner view additions

Two new integrity checks:

- **Open contests not yet covering their prize** — a paid contest whose entries do not yet cover the declared prize, visible while there is still time to fill it.
- **Prizes won but not sent after a week** — winners waiting on merch or sponsor goods.

## State configuration as shipped

Paid: 45 states + DC. Free-play, **hard-locked in code**: HI, ID, MT, NV, WA.
Naming one of those five in `PAID_STATES` is ignored and warns at boot, and
unknown state codes resolve to free rather than paid.


## Head-to-head platform fee

`HEAD_TO_HEAD_RAKE_PERCENT` (default **10**, capped at 25) takes a percentage of
the pot on a decided head-to-head. 50 + 50 → pot 100, fee 10, winner receives 90.

- **Charged only on a decided result.** A draw returns both stakes whole — the platform does not charge for a contest that produced no winner. A void or expiry returns stakes whole too.
- **Floored**, so rounding can never pay out more than the pot holds. A 7 + 7 pot pays 13, not 13.3.
- **Disclosed before commitment, in three places**: the create modal states the fee in words, a live line under the stake field shows pot / fee / winner-takes as the player types, and the invite email tells the opponent what they would win before they accept. A fee a player discovers only after losing is a chargeback and a complaint.
- Persisted per challenge as `rake`, so platform revenue from H2H is auditable per contest rather than inferred.
- Surfaced to the app through `GET /api/public/features` — the UI never hardcodes the percentage, so changing it is an environment variable with no deploy.

Setting `HEAD_TO_HEAD_RAKE_PERCENT=0` makes it winner-takes-all with no fee.

### What the fee does and does not change legally

It is the normal DFS pricing model for head-to-head, so commercially it is the
right shape. It does **not** resolve the compliance question, and it is worth
being clear why: what matters in the state statutes is whether the contest is a
game of skill with prizes determined by participants' knowledge, not what
percentage the operator keeps. Taking a cut of two players' stakes is also the
fact pattern some states describe as pool-selling, so the fee is a reason for
counsel to look closely rather than a reason not to.

`HEAD_TO_HEAD_ENABLED` stays `false`.


---

# Season Cards — the multi-sport long game

A player drafts **one fighter per sport**. Over the season those fighters compete
on their own schedules, and whatever each actually does is credited to whoever
drafted them. It is a fantasy roster, not a prediction contest — but it keeps the
platform's DNA in two deliberate ways.

## 1. Output is scored with the platform's own categories

A boxer earns from head punches, body punches, total punches, rounds won and
knockdowns. An MMA fighter from strikes, kicks, knees, elbows, rounds won and
knockdowns. A wrestler from signature moves, near falls, reversals and pinfalls.
Nothing new was invented, and the numbers come from the **same official round
stats an admin already enters** — so a Season Card can never disagree with the
fight it was scored from. Decisive events are weighted (a round win is 10, a
knockdown or pinfall 25) rather than counted flat, because they are rare.

## 2. Every pick carries a called number

The player names a category and a figure their fighter will reach across the
season. It scores by **exactly the platform's existing rule** — if you called at
or under what the fighter actually did, you score what you called. Call low and
it is safe but small; call high and you risk the whole bonus. Same trade-off as a
scorecard, stretched over three months. Capped by
`SEASON_CALL_BONUS_CAP` (default 100) so a called number can never out-weigh the
fighter's real output.

## Cross-sport fairness

A twelve-round boxing match generates several times the countable output of a
three-round MMA fight, so raw totals would make the boxing slot decide every
season and the other four picks decoration. Each slot is therefore scored **out
of 100 within its own sport**, measured against the best performance any entrant
got from that slot this season. Five slots sum to a score out of 500.

Two consequences worth knowing:

- The yardstick is what was **actually achieved**, not a guessed constant — so the scale self-corrects for a quiet or busy season in any sport.
- **A slot nobody scored in is worth zero to everyone.** No free points for a fighter who never competed, and no division by zero.

The raw number is kept and shown next to the normalised one. The player sees
"IRON JACKSON — 847 pts — 92/100". The platform's number is the headline; the
normalisation is the conversion.

## Mechanics

```
GET  /api/seasons/open                    open seasons, slots, call categories
POST /api/seasons/:seasonId/draft         lock a card; charges entry in a transaction
GET  /api/seasons/me                      my cards, live progress, called-number status
GET  /api/seasons/:seasonId/leaderboard   ranked; provisional until settled
POST /api/admin/seasons                   create a season
POST /api/admin/seasons/:id/status        open drafting / start / void (voiding refunds all)
POST /api/admin/seasons/:id/settle        normalise, apply calls, pay prizes
```

Reuses the hardened paths rather than duplicating them: entry charging runs
through `runFightEntryTransaction` with a `recordWalletMove` ledger row, prizes
go through `buildPrizeAwards` so the same 60/30/15 and 50/30/20 tiers apply,
non-cash prizes attach through `awardNonCashPrizes`, and settlement claims the
season atomically before any money moves.

Rules that took a decision:

- **One roster per player per season**, enforced by a unique index, not just a check.
- **Each slot needs a different fighter** — no drafting the same name into two slots.
- **A paid season obeys the state mode**, exactly as a paid fight does. Free seasons (`entryFee: 0`) run everywhere, including the five free-play states, and award non-cash prizes.
- **Fighters are drafted from the real schedule**, derived from the fight card in the app — a player cannot draft someone who is not booked.
- **Name matching is normalised and family-scoped**, so a name collision across sports cannot cross-credit a slot.
- **Voiding a season refunds every entry fee** with a ledger row and an email. A season nobody can win is a season nobody should have paid for.
- **The leaderboard is labelled provisional** until settlement, and ranks on raw output mid-season — publishing a normalised figure before the field is complete would show a number that later moves.

## It is LIVE

```
SEASON_CARDS_ENABLED=true        # default. Set false to pull the feature.
SEASON_CALL_BONUS_CAP=100        # ceiling on a called-number bonus
```

Shipped on at the owner's decision, for retention. Three things were added to
make it safe to run live rather than under supervision:

**1. The lifecycle runs itself.** `GET /api/cron/seasons/advance` (CRON_SECRET)
starts seasons whose draft window has closed and settles seasons that have ended.
Without it, drafting stays open past its close date and a finished season is never
scored — the two ways a long-game feature quietly breaks. **This job must be on
the scheduler for the feature to work.**

**2. A one-entrant paid season is refunded, not paid.** Normalisation needs a
field to measure against; with a single paid card there is no contest. The entry
is returned with a `season_refund_no_field` ledger row and an email, and the
prize step is skipped so the same coins cannot go out twice.

**3. Live progress is visible in the app.** `My Season Cards` on the profile
screen shows all five fighters, their running points, how many fights each has
had, and a progress bar closing in on the called number. A drafted card the player
cannot watch is a card they forget about — the progress view *is* the retention
mechanic, not decoration.

### Launch order that keeps the risk low

Run the **first season free** (`entryFee: 0`). It is legal in all 51
jurisdictions, awards badges and titles through the existing prize system, needs
no minimum field, and exercises every code path — drafting, crediting,
normalisation, called numbers, settlement — with no money exposed. Turn on a paid
season once one free season has settled correctly end to end.


---

# Team Cards — five fighters from one event

The flagship contest. A player picks five fighters from a single card, one from
each of five different bouts, and their combined output that night is the score.

## Why this shape is the strongest one

- **Every fighter is in the same sport under the same rules**, so the score is a plain total. No normalisation, no conversion, nothing to explain — the platform's scoring runs untouched. (Contrast Season Cards, which need an out-of-100 conversion precisely because they cross sports.)
- **It resolves the same night**, matching the rhythm of the rest of the app.
- **It is a five-athlete lineup across five bouts** — the classic daily-fantasy shape, rather than a contest on one event. That is a materially better position than a single-fight contest under the state statutes that require a contest to reflect multiple athletes in multiple contests.
- **Promoters can run their own**, which gives affiliates a second product they can sell in one sentence.

## One fighter per bout — enforced twice

Without it, a player picks both sides of a fight and banks points whichever way it
goes: a hedge, not a call. Enforced on the server (`DUPLICATE_BOUT`) and made
structurally impossible in the app, where the draft is **keyed by bout** so a bout
cannot physically hold two picks.

A contest also cannot be created with fewer bouts than picks (`NOT_ENOUGH_BOUTS`)
— otherwise the rule makes the contest impossible to enter.

## Mechanics

```
GET  /api/team-contests/open                    open contests with their bouts
POST /api/team-contests/:contestId/enter        one fighter per bout; charges entry
GET  /api/team-contests/me                      my teams, live per-fighter points
GET  /api/team-contests/:contestId/leaderboard  live during the card
POST /api/admin/team-contests                   create
POST /api/admin/team-contests/:id/void          cancel and refund everyone
POST /api/admin/team-contests/:id/settle        settle by hand
GET  /api/cron/team-contests/settle             auto-settles once every bout is scored
POST /api/affiliates/me/team-contests           a promoter runs one for their league
```

Reuses the hardened paths throughout: entry charging in
`runFightEntryTransaction` with a ledger row, crediting driven by the same
`fighterOutputFromRounds` the season game uses, prizes through
`buildPrizeAwards`, non-cash prizes through `awardNonCashPrizes`, and
settlement claimed atomically before money moves.

Decisions worth recording:

- **Picks are validated against the real bout.** A named fighter must actually be in the bout they are picked from (`FIGHTER_NOT_IN_BOUT`), and the bout must still be open (`BOUT_LOCKED`).
- **Auto-settlement waits for the whole card.** `/api/cron/team-contests/settle` only settles once *every* bout has `prizesSettledAt` — a partial card would score an incomplete team and pay the wrong winner.
- **Promoters cannot enter their own contest** (`AFFILIATE_SELF_ENTRY`), and must be verified before running one.
- **A one-entrant paid contest is refunded, not paid**, and the prize step is skipped so the same coins cannot go out twice.
- **The leaderboard is live mid-card**, ranked on points scored so far with a count of how many of each team's fighters have been scored.

## It is live

```
TEAM_CARDS_ENABLED=true      # default
TEAM_PICKS_REQUIRED=5        # 2–10
TEAM_CALL_BONUS_CAP=50       # ceiling on a called-number bonus
```

**Scheduler addition required:** `GET /api/cron/team-contests/settle`, every
15 minutes on fight nights. Without it, contests settle only when an admin clicks.

Covered in the Terms as Section 8.


---

# Terms of Use — now inside the app

The Terms existed only as a standalone document at the project root, which meant
the app itself had no reachable copy: no route, no link, and nothing shown at
signup. Section 1 states that a player agrees by using the Services — that only
holds if they were shown where to read them. Both app stores also require a
reachable terms link on the listing.

Shipped as `fmm-frontend/src/pages/terms.js` — a real Next.js route at
**`/terms`**, carrying all 25 sections. The design document used the Classical
design system's CSS variables, which the app does not load, so every token was
resolved to a literal and the fonts are pulled from Google Fonts on the page
itself. Verified: 25 sections in sequence, no unresolved `var(--*)`, no leftover
placeholders, no raw HTML attributes that JSX would reject.

Linked from three places, each for a different reason:

| Where | Why |
|---|---|
| Signup consent line (player and affiliate) | The agreement is only formed if the player was shown the Terms when they agreed |
| App menu → Terms of Use | Reachable from anywhere; what the app stores check for |
| Scoring-rules screen | Where a player is already reading about how the game works |

**Keep the two copies in step.** `Terms of Use.dc.html` at the project root is the
editable/printable master; `pages/terms.js` is what players see. A change to one
needs the same change to the other.


## Cron schedule — closed a real gap

The cron endpoints were built and guarded, but **nothing was scheduled to call
them**. Team Cards would never settle, seasons would never close drafting, and
head-to-head stakes would sit on players' coins indefinitely — every one of
those a money path stalling silently rather than erroring.

`backend-fix/vercel.json` now declares all seven jobs. Also fixed:
`/api/cron/retention` was checking `CRON_SECRET` by hand with a plain string
comparison and only accepted the `Authorization` header; it now uses the shared
`verifyCronSecret` guard like every other job, which is timing-safe and accepts
both header styles.


---

# First-open flash and lag — root cause found

## The old header flash

`FantasyMobileExperience` is loaded with `dynamic(..., { ssr: false })`, and its
`loading` fallback pointed at **different banner files** than the real hero:

| | File |
|---|---|
| Loading placeholder (was) | `hero-banner-crop-v62.webp` / `hero-banner-new.jpg` |
| Real hero | `hero-banner-v2-mobile.jpg` / `hero-banner-v2.jpg` |

So the paint sequence was: blank → **old banner** → new banner. That middle frame
is the "old header for a split second". It was not a caching artefact or a stale
build — two different images were being served by design.

Fixed by pointing the placeholder at the same files, with the same `width`/
`height`, plus CSS giving `.fmm-app-route-loading` the identical 16:9 box and
`object-fit: contain` as `.fmm-app-hero`. Placeholder and real hero are now
geometrically and visually identical, so there is no transition to see.

## The remaining first-open pause

With `ssr: false`, nothing renders server-side: the browser must download and
execute the app chunk before anything appears, and the banner request did not
even *start* until the placeholder rendered. Two `<link rel="preload" as="image">`
hints now sit in the document head — media-scoped so exactly one file is fetched —
so the banner downloads in parallel with the JavaScript instead of after it.

## Not changed, deliberately

`ssr: false` remains. Removing it would put the app shell in the initial HTML and
cut the pause further — the code comment above `renderPrototypeExperience` says
that was the intent — but the mobile app reads `window` and `localStorage` during
mount, so enabling SSR risks a server-render crash that cannot be verified
without running the app. **Not a launch-day change.** Revisit with a running
environment: the payoff is real, and so is the risk.


---

# App load time — 571 KB removed from first paint

## Measured cause

118 stylesheets totalling **2,994 KB** loaded on every route. The browser must
download and parse all of it before painting, which is the wait on opening the app.

The mobile app renders **23 CSS classes**. Checking the twelve heaviest sheets
against those classes: ten of them, 1.4 MB, name none of them.

## Why only four were removed

A class-name scan proves a sheet does not style the app's *own* classes. It does
**not** prove the sheet is irrelevant — one that defines `:root` variables,
styles `body`, or declares `@font-face` is consumed indirectly by sheets the app
does use. Each candidate was therefore re-checked for global selectors:

| File | Size | Verdict |
|---|---|---|
| `featured-fight-stage-final.css` | 280 KB | class-scoped — **removed** |
| `pro-wrestling.css` | 120 KB | class-scoped — **removed** |
| `experience-theme.css` | 104 KB | class-scoped — **removed** |
| `affiliate-experience-final.css` | 66 KB | class-scoped — **removed** |
| `homepage-final-premium-polish.css` | 305 KB | `:root` + 81 vars, `h1`, `h2` — kept |
| `home-design-reference-lock.css` | 217 KB | `:root` — kept |
| `frontend-final.css` | 182 KB | `:root` + 14 vars — kept |
| `globals.css` | 134 KB | `body`, `*`, `:root`, `@font-face` — kept |
| `new-theme.css` | 105 KB | `html`, `body`, `:root`, `@font-face` — kept |
| `client-feedback-final.css` | 79 KB | `:root` — kept |

**Result: 2,994 KB → 2,423 KB on the app route.** The four removed files are
served from `/public/legacy-css/` and linked at runtime only when
`renderLegacyExperience` is true, so website pages keep them and the app never
downloads them.

## Reverting

Originals are in `fmm-frontend/src/styles/_backup-legacy-css/` (byte-identical,
verified). To revert one: re-add its `import "@/styles/<file>";` to `_app.js` and
delete its `<link>` from the Head block.

## The remaining 1.0 MB

The six kept files are the bigger prize but cannot be removed by inspection —
their CSS variables are consumed by sheets the app *does* load, so cutting them
requires extracting the variable definitions first. That is a refactor to do with
a browser open, not from source. Expect roughly another 700 KB.

## Check after deploying

1. Home page, fight detail, affiliate dashboard, pro-wrestling pages — all still styled.
2. The app route in DevTools → Network → CSS: the four files must **not** appear.
3. A legacy page: they **must** appear, from `/legacy-css/`.


---

# Pass 5 — money identity, affiliate ownership, auth limits

Lens: **does any route decide whose money or account it touches from the request
body rather than the token?** That is the shape of every cross-user bug.

## Two real holes, both fixed

### 1. Mass defacement — `PUT /update-profile-url` (critical)

```js
app.put('/update-profile-url', verifyToken, ...)   // any signed-in player
await User.updateMany({}, { $set: { profileUrl } });       // NO filter
await Affiliate.updateMany({}, { $set: { profileUrl } });  // NO filter
```

Behind `verifyToken` only, with an unfiltered `updateMany({})`. **Any player with
an account could overwrite the profile image of every user and every affiliate on
the platform in a single request.** It is a bulk migration tool that was left
reachable by players.

Now `verifyAdminToken`, and it additionally requires
`confirmBulkOverwrite: "YES-OVERWRITE-EVERY-ACCOUNT"` so an admin cannot fire it
by accident either, and it logs the admin who ran it.

### 2. Coins credited to any address — `POST /admin/add-tokens-won`

```js
const email = String(req.user?.email || req.body?.email || '').trim();
```

This *looked* bound to the signed-in account — an earlier pass in this project even
commented it as fixed. It was not. **The session token carries `{ id, scope }` and
no email**, so `req.user.email` was always `undefined` and every request fell
through to `req.body.email`. Any player could send the 200-coin guest claim to any
address they typed.

The email is now resolved from the account the token belongs to and the body value
is ignored entirely.

**The lesson worth recording:** a comment saying a route is secure is not evidence.
This one read as fixed and was verified only by eye. The defect was in the *shape
of the token*, which is two files away from the route.

## Checked clean

**Affiliate flow — no ownership gaps.** Every affiliate write taking an id in the
path either derives the actor from the token and ignores the path entirely
(`/affiliate/:id/payout` — the payout route reads `req.user.id`, never `:id`), or
carries an explicit owner check (`NOT_OWNER`, `NOT_LEAGUE_OWNER`, `NOT_PROMOTER`),
or is admin-only. `/affiliate/:affiliateId/incrementViews` is public by design — a
vanity counter, rate-limited only.

**Auth endpoints — no unlimited credential surface.** Every login, register,
password-reset, verification and one-time-code route carries `loginLimiter` or
`submitLimiter`. Zero gaps.

**Spin-wheel claim — already safe.** It reads the email from the body, but verifies
it against the token's own account before crediting. An edit here was reverted
after confirming the existing guard; a note now records the guarantee so the next
reader does not "fix" it into a duplicate lookup.


---

# Pass 6 — id-based reads and email-link actions

Lens: **authenticated is not authorised.** A route can require a valid token and
still hand the caller someone else's data.

## Two more holes, both fixed

### 1. Player PII by email address — `GET /user/:email`

Behind `verifyToken`, but the email in the URL was never compared to the caller.
Any signed-in player could read **any other player's phone number and zip code**
by knowing their email address — and emails are visible on leagues, leaderboards
and forum posts.

Callers now get their own full record, or a name-and-avatar projection of someone
else's. No contact detail crosses accounts.

### 2. Unsubscribe anyone — `GET /unsubscribe-user/:userId`

Fully public, taking a bare user id. Anyone could walk ids and unsubscribe every
player on the platform — silently cutting them off from entry confirmations,
refund notices and payout emails. Not a data leak; a way to make the money
notifications stop arriving.

Links now carry an HMAC (`?t=`), the same `signActionToken` pattern as the
affiliate approval links, and the one place that builds the link was updated to
sign it. Unsigned legacy links keep working for 30 days so nobody's existing
email breaks — set `ALLOW_UNSIGNED_UNSUBSCRIBE=false` after that, and the
warning logged for each unsigned use tells you when they have stopped arriving.

## Checked clean

**Client-supplied amounts.** Only two routes let a number from the request body
reach a balance, and both validate it: the spin wheel checks the value against
`SPIN_WHEEL_PRIZES` (an unlisted segment is rejected), and the affiliate payout
checks the requested amount against the affiliate's own confirmed balance. No
self-service coin printer.

**`GET /approveAffiliate/:id`** reads a raw document but is already HMAC-gated
from pass 1.


---

# Pass 7 — destructive bulk operations

Lens: **what can one request destroy?** Admin-only stops outsiders. It does not
stop a mis-tap in a back-office UI, a stale browser tab replaying a request, or a
script pointed at production instead of staging.

## Twelve unfiltered `deleteMany({})` calls, one of them catastrophic

`DELETE /api/scores` ran `Score.deleteMany({})` — **every prediction on the
platform** — behind nothing but an admin token and a comment. Those rows are what
settlement scores from, what refunds are computed from, and what eligibility is
checked against. Deleting them mid-season would leave open contests unscoreable
*and* unrefundable, with players' entry fees already taken. There is no recovery
path from the app; it would be a database restore.

Now guarded three ways:

1. `confirm="DELETE-ALL-SCORES"` must be sent explicitly.
2. It **refuses outright** while any fight is still awaiting settlement, naming the count, unless `force="YES-I-ACCEPT-UNSETTLED-LOSS"` is also sent.
3. Every attempt logs the admin id and timestamp.

The same `requireBulkConfirmation` guard now covers the content wipes —
FAQs, testimonials, news, sponsors, admin messages and site stats. Those are
recoverable, but they were equally one-click.

## Checked clean

**Mass assignment.** Only two routes build a document straight from `req.body`
(`POST /faqs`, `POST /news`). Both are admin-only and neither schema carries a
privilege or balance field, so there is nothing to escalate into. Every
account-creating route assigns fields explicitly.

**The other bulk deletes are correct by design** — the owner login code sweep
clears one-time codes before issuing a new one, and `forget-all` on owner devices
is the point of that button.


---

# Boot crash + why the banner stayed cropped

## `ReferenceError: Cannot access 'requireBulkConfirmation' before initialization`

The bulk-delete guard from pass 7 was declared as `const requireBulkConfirmation =`
next to the head-to-head helpers (~line 19,600), but the routes that use it
register much earlier in the file (`DELETE /api/scores` is ~line 10,600). Route
registration runs at module load, so the reference hit the temporal dead zone and
the server died at boot.

Fixed by making it a **function declaration**, which hoists fully — position in
the file stops mattering.

Swept the whole file for the same defect class: every `const`/`let` helper
referenced on a route-registration line before its declaration. Four other hits,
all false alarms — they are wrapped as `(req, res, next) => verifyOwnerToken(...)`,
so resolution is deferred to request time. This was the only real one.

**Rule for anything added later:** middleware referenced directly in an
`app.get/post(...)` call must be a hoisted `function`, or be declared above every
route that uses it.

## Why the hero banner was still cropped after being "fixed"

The first hero fix was correct CSS that **never applied**. `fmm-hero-fit-final.css`
loads last (114 of 114) and uses `!important`, but source order only breaks ties
at *equal specificity* — and `fmm-client-v62-unified-theme-performance.css` has:

```css
.fmm-exact-mobile-portal .fmm-prototype-view--home .fmm-app-hero {
  aspect-ratio: 853 / 700 !important;   /* specificity 0,3,0 */
}
```

against a plain `.fmm-app-hero` at 0,1,0. The nearly-square box won on every
phone, so the 16:9 artwork kept being cropped.

Every rule in the file is now written to exceed 0,3,0 (42 vs 30 on the container,
24 vs 11 on the image). The decorative glows, particles and sparkles — positioned
for the old cropped box — are hidden on phones, where they now land over the
artwork.

**The lesson:** "loaded last with `!important`" is not a guarantee. In a codebase
with 114 stylesheets, check the *specificity* of what you are overriding, not the
load order.


---

# Home screen fixes, sounds, and a prepared CSS split

## Featured This Week — fighters were behind the names

The card put the fighter cut-outs at 33% width down each side, then centred a
25px headline bottom-aligned over the whole card, and darkened both edges to 82%
opacity — precisely where the fighters stand. So the faces were dimmed *and*
covered.

Fixed: side darkening dropped to 28%, card raised to 246px, the cut-outs stop
74px short of the bottom, and the copy sits in a scrim band below them. The
headline came down to 21px. Faces are now the brightest thing on the card.

## Featured Fight — heads cropped

70px round frames with centre-anchored `cover`, which cuts the top off a
standing figure. Frames are 92px now, and every fighter portrait is anchored at
`center 22%` so the face lands inside the circle.

## Discipline circles — static art, now a live cycle

The five circles pointed at fixed files, so adding a fight changed nothing. Each
circle now builds a gallery from **every fighter image uploaded to that
discipline** (both corners of every bout, soonest fight first) and cross-fades
through it on a 4-second cycle. One shared timer for all five, paused when the
tab is hidden, and it respects `prefers-reduced-motion`. A discipline with one
photo simply holds it; one with none falls back to the discipline art.

## Ticker

`marquee 24s` → `11s`. It was crawling.

## Buttons — glaze, press light, press sound

Applied by selector (`button`, `[role="button"]`, `.theme-btn`, `.btn-grad`)
rather than by editing hundreds of inline-styled elements:

- A two-layer highlight overlay that *lightens* whatever background a button
  already has, so brand gradients survive.
- On press: brightness up, a 1px settle, and an accent glow ring.
- Themed `:focus-visible` ring instead of the browser default.
- Opt-outs for things that are `role="button"` but not visually buttons — cards,
  tiles, the bottom nav, hero overlays. A glaze on a photograph looks like a bug.

Sound is one capture-phase `pointerdown` listener rather than `playTap()` threaded
through every call site. The **iOS unlock** is the part that mattered: an
AudioContext created outside a user gesture starts suspended, which is why the
treasure chest was silent even though it already called `playBell()`.

## Load time — 492 KB more identified, prepared, not activated

See `fmm-frontend/src/styles/split/HOW-TO-ACTIVATE.md`. Four stylesheets were
split rule-by-rule into an app part (9 KB total) and a legacy-only part (492 KB).
The split is safe by construction; activating it changes cascade order on the
legacy website pages, which needs a browser to verify. Four edits, ten minutes,
right after launch.


## News bar — was system status, now actual news

The bottom ticker existed but carried plumbing messages: "Live fight status
refreshes from the production feed", "Contest dates, fees and pools come directly
from the registered fight". Nothing a player would read twice.

Rebuilt from data the app already holds, in priority order:

1. **Who is leading** — top three off the live leaderboard with their points.
2. **Who won** — settled fights, phrased as "X BEAT Y".
3. **Money on the table** — each open contest's pot.
4. **Where the action is** — entry counts per card.

The generic lines now appear **only** when there is genuinely nothing else, never
alongside real results — filler next to live news reads as a broken feed.

It was also mid-scroll, so it disappeared the moment you moved. It is now
`position: sticky; bottom: 0` inside the phone's scroll area, so it behaves like a
news bar and stays in view without covering the nav. Marquee speed scales with
how many items there are, so a long feed does not crawl and a short one does not
race. Held still under `prefers-reduced-motion`.


---

# Notifications when a fight is uploaded — the gap

Publishing a fight wrote **one global row** into `Notification` — schema
`{ title, read }`, no `userId` — and the only routes that read it are
admin-only. So:

- **No player ever saw a new-fight notification in the app.** Only the mass email.
- `read` was global: one admin marking it read cleared it for everyone.
- The bell had a per-user `notificationsReadAt` timestamp and a badge, but **no feed to count against**, so it was permanently empty.

## Built: `GET /api/users/me/notifications`

**Derived, not fanned out.** A row per user per fight would be tens of thousands
of writes every time a card is published, plus a pruning job. This reads recent
fights and the caller's own events, then compares each against
`notificationsReadAt` for the unread count:

1. **New fights** published in the last 21 days — the thing that was missing.
2. **Results for fights this player actually entered.** A settled fight they were not in is not their news.
3. **Their own money movements**, straight off the wallet ledger.

Newest first, capped at 50. The app polls every 60 seconds (skipped while the tab
is hidden), so a fight published while someone has the app open appears without a
reload. Opening the bell marks everything read server-side, so the badge stays
cleared across reopens instead of coming back.

The admin console keeps its global row for the back-office list; a comment now
says why it is not the player path.

## Still email-only

The mass email on `/activate-match/:matchId` goes to every user and guest. That is
now the *second* channel rather than the only one — worth reviewing whether every
published fight should email your whole list, or only ones you mark as featured.


---

# Mass email reserved for featured fights

`POST /activate-match/:matchId` emailed **every user and every guest** on every
activation. Publish three cards in a week and your list gets three blasts — which
is how a list learns to ignore you, and how a sending domain earns a spam
reputation it does not recover from quickly.

Now:

- **Email only when the fight is marked `featuredThisWeek` or `featuredFight`.** Anything else activates silently and returns `emailed: false, reason: 'NOT_FEATURED'`.
- `{ "notify": true }` in the body forces a send for a one-off.
- **Unsubscribes are respected.** The blast now filters on `isSubscribed` and `isNotificationsEnabled`, which already existed on the account and were being ignored. Mailing someone who opted out is the fastest route to a complaint.

Players still learn about every fight — through the in-app bell
(`GET /api/users/me/notifications`), which is what makes gating the email safe
rather than a loss of reach.

Two other blast paths were already opt-in (`notify: true`) but were loading whole
documents to read an address: the fight-creation mail pulled full user records
(password hashes included) and the affiliate announcement pulled full affiliate
records (payout and tax fields). Both now select just the mail fields, bounded.

## Social accounts

TikTok and Facebook pointed at guessed handles that 404'd. Corrected to
`@fantasy.mmadness` and the real Facebook share URL — used verbatim, because that
is what Facebook issues for a page without a vanity URL.


---

# League notices — giving promoters a way to reach their players

Nothing existed. A promoter could put a card up and their league members had no
way to learn about it except opening the app and noticing. That breaks the
affiliate model: you ask someone to bring you players, then give them no channel
to the players they brought.

## The promoter announces, deliberately

`POST /api/affiliates/me/promotions/:fightId/announce`

Not automatic on every promotion, for two reasons: the promoter knows which of
their cards is worth an inbox, and firing on every write path (creation, shadow
link, admin edit) would send several notices for one fight.

- **Ownership is checked.** The fight must be attached to this affiliate, on `Match.affiliateId` or `Shadow.AffiliateIds`, or the announce is refused (`NOT_YOUR_FIGHT`). Otherwise a promoter could announce — and take credit for — somebody else's card.
- Requires a **verified** league.
- **Every notice reaches every member's bell.** Email is the throttled part, not the notice.
- **Email cooldown: one per promoter per `LEAGUE_EMAIL_COOLDOWN_HOURS` (default 24).** One promoter with a large league mailing every card would burn the platform's sending reputation exactly as the old platform-wide blast did. When the cooldown blocks a send the response says so in words, so the promoter knows their league got notifications but not email.
- **Opt-outs respected** (`isSubscribed`, `isNotificationsEnabled`), and every email carries a plain line explaining why the player is receiving it.

## Reach, so a promoter can see whether it worked

`GET /api/affiliates/me/promotions/reach` — members, how many have actually
entered something, joins in the last 7 days, whether email is currently
available, and the last 20 notices with their real reach.

The "playing" number is the honest one: a league of 200 where 4 have entered a
contest is a different business from one where 120 have.

## Share kit — removing the friction

`GET /api/affiliates/me/promotions/:fightId/share` returns a join link, a
fight-specific link, and **ready-written post text per platform** — Facebook,
TikTok, SMS and a short version. A post that works on X reads wrong on Facebook,
so they are written separately rather than one string reused.

Both links carry `?ref=<affiliateId>`, which is what ties a signup back to the
promoter.

## In the app

A promoter panel at the top of the Leagues screen — three numbers, then
**Announce** and **Share** per card, and a line stating plainly whether email is
available or on cooldown. It renders only when the reach endpoint answers, which
needs an affiliate session, so a normal player never sees it. Loaded when the
Leagues tab is opened rather than on mount, so a player's app start does not fire
a guaranteed 401.

## Not built: SMS

No SMS provider is wired into the backend. It needs a Twilio account, a per-message
cost, US A2P carrier registration, and written consent per player — fantasy sports
texting sits under rules with real penalties for getting consent wrong. Worth doing
once there is evidence players want it; not a launch feature.


---

# Fighter cutouts — transparent backgrounds, no AI regeneration

The branding spec's most valuable single item is the transparent background: one
fighter asset that works on a fight card, a leaderboard row, a poster and a
prediction screen. It is also the only part with **no identity risk** — nothing
about the fighter is altered, the background is simply removed.

**Built without a new provider.** Fighter photos already live on Cloudinary,
which removes backgrounds as a *delivery* transformation. So the cutout URL is
derived from the URL already stored:

```
/image/upload/<id>.jpg  →  /image/upload/e_background_removal/f_png/<id>.png
```

Consequences worth noting:

- **Nothing about upload changed**, and it applies **retroactively** to every fighter image already in the account.
- `f_png` is forced, because a JPEG cutout comes back with a white box instead of alpha.
- Screens pass the cutout as `src` and the original as `fallbackSrc`. `MobileImageSlot` already swaps to the fallback on error, so if the Cloudinary add-on is not enabled the transformed URL 404s and the original photo appears. **This cannot break an image — worst case it is a no-op.**
- Controlled by `NEXT_PUBLIC_FIGHTER_CUTOUTS` and `NEXT_PUBLIC_CLOUDINARY_CUTOUT_TRANSFORM`, so the transform can change or be switched off without a code change.

Applied to the round fighter portraits and the discipline circles — the two
places a fighter is shown as a figure rather than a photograph.

**Requires:** the Cloudinary *AI Background Removal* add-on enabled on the
account. It is a paid add-on; until it is on, the app behaves exactly as before.

## Not built: AI gear regeneration

Deliberately. Two reasons recorded so the decision is not re-litigated blind:

1. **Identity drift.** No current image model reliably preserves a real person's face and tattoos while changing their clothing. Expect a high rejection rate, which is why the spec's own review-first default is right.
2. **Right of publicity.** An altered image of a real fighter's face wearing platform branding, used to promote a paid contest, has no clear safe harbour in any state — unlike names and statistics in fantasy contests. Any generation pipeline must be gated on a recorded `likenessConsent` per fighter, enforced in code rather than policy.


---

# Fighter roster foundation

Built the filing system the branding spec needs, with **no AI generation** — every
piece below is useful with hand-made images and cannot be invalidated by a model
performing worse than hoped.

## An important correction

A fighter library already exists: fights carry `fighterAId` / `fighterBId`
referencing a **`CombatFighter`** model, with a resolver and populate calls
throughout. Its schema lives in a **sibling module, not `server.js`**.

So rather than modify a model defined elsewhere, this is a **companion
collection** keyed by a normalised fighter name. Keyed by name because most
existing fights carry only `matchFighterA` / `matchFighterB` strings — a name key
covers the whole back catalogue. Where a `CombatFighter` row exists it is linked
as well.

## What was built

| Piece | Detail |
|---|---|
| **`FighterProfile`** | Permanent `fmId`, display name, sport, original vs branded image, which is live, image status |
| **Permanent FM IDs** | `FM-000001` from an atomic counter, so two simultaneous creations cannot collide. Never reused |
| **Version history** | `FighterImageVersion` — the previous look is archived before a new one replaces it, so nothing is destroyed |
| **Appearance counts** | Computed from real `Match` records, never typed in. Recounted on publish and on demand |
| **Gear tiers** | Thresholds in code, **designs as `GearDesign` rows** — a new look is a back-office record, not a deploy |
| **Levels** | ROOKIE → CONTENDER → VETERAN → ELITE → LEGEND, derived from appearances |
| **Consent gate** | `likenessConsent` with date, source and who recorded it |
| **Central resolver** | `getActiveFighterImage(profile)` — one place decides which picture represents a fighter |

## The consent gate is enforced, not documented

`assertLikenessConsent` refuses with `LIKENESS_CONSENT_MISSING`, and it already
guards the manual branded-image attachment — so the gate exists and is proven
before any generator is written. Granting consent **requires a source** ("signed
agreement", "affiliate contract"); it cannot be set as a bare boolean. Every
change is logged with the admin id.

`GET /api/admin/fighters/overview` lists fighters without consent **ordered by
appearance count**, so the ones worth asking first are at the top.

## The roster builds itself

- `POST /api/admin/fighters/backfill` scans every existing fight and creates profiles for everyone found, then counts appearances. Safe to re-run — it fills blanks and never overwrites.
- On every fight publish, both fighters are upserted and recounted, wrapped so a roster problem can never stop a fight being published.

## Endpoints

```
GET  /api/fighters                          public roster
GET  /api/fighters/:key                     public profile, resolved image
POST /api/admin/fighters/backfill           build the roster from existing fights
GET  /api/admin/fighters/overview           totals + who needs consent
POST /api/admin/fighters/:key/consent       record or revoke likeness consent
POST /api/admin/fighters/:key/image         attach branded image / switch active
GET  /api/admin/fighters/:key/versions      image history
POST /api/admin/fighters/:key/recount       recount appearances
POST /api/admin/gear-designs                add a gear design
GET  /api/admin/gear-designs                list designs
```

## Deployment note — `backend-fix/` is `server.js` only

`server.js` requires five sibling modules that are **not in this folder**:
`./swarm-phase2`, `./seo-performance-phase2`, `./fight-data-quality`,
`./ufc-event-discovery`, `./client-feedback-core`. They live in the real
repository. Copy `server.js` (and `vercel.json`) into the repo — do not deploy
this folder on its own, or the server will fail at boot with a missing-module
error.


## Contest standings — the last launch-blocking gap

Team Cards and Season Cards were live and enterable, but nothing displayed the
leaderboard. A player could enter, watch their own points land, and never see who
won or where they placed. A contest without visible standings reads as broken, and
the standings screen is the moment that brings people back.

The endpoints already existed; only the screen was missing. One sheet serves both
contest types, reached from a STANDINGS link on each card the player holds.

Two honest labels rather than a bare number:

- **Team Cards mid-card** show "Live", and each row reports how many of that team's fighters have been scored — which is what explains a low score before the card is finished.
- **Season Cards** show "Provisional — ranked on raw points until the season settles", because the out-of-100 conversion is not final until every slot has been scored. Publishing the normalised figure early would show a number that later moves.

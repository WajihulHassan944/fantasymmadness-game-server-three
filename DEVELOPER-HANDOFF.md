# Developer handoff — Fantasy MMAdness

Everything in this repo has been security-hardened and statically verified.
**It has not been run.** Your job is the runtime half. Work top to bottom; each
step gates the next.

---

## 1. Set environment variables (do this first — the server refuses to boot without them)

A boot guard in `backend-fix/server.js` validates configuration and, in
production, exits with a `FATAL:` line naming the problem.

**Required — server will not start:**

```
MONGODB_URI=...
JWT_SECRET=<32+ random chars>
JWT_SECRET_ADMIN=<32+ random chars, DIFFERENT from JWT_SECRET>
```

- Both secrets must be 32+ characters and must not be placeholders (`secret`, `changeme`, etc).
- They must differ from each other. If they match, a player token passes admin checks.
- **The old values are in a committed `.env` — rotate them, do not reuse.** Rotating logs every user out once. Do it at a quiet hour.

**Required for features to work (warns, does not block):**

```
CRON_SECRET=<32+ random chars>        # scheduled jobs return 503 without it
ACTION_LINK_SECRET=<32+ random chars> # signed affiliate-approval email links
                                      # (falls back to JWT_SECRET_ADMIN)
AUTHORIZE_NET_ENVIRONMENT=production
AUTHORIZE_NET_API_LOGIN_ID=...
AUTHORIZE_NET_TRANSACTION_KEY=...
AUTHORIZE_NET_SIGNATURE_KEY=...       # live key, not sandbox
SMTP_USER=... / SMTP_PASS=...         # no email at all without these
PUBLIC_APP_URL=https://www.fantasymmadness.com   # league notice emails, share links
```

Every remaining variable is grouped by feature below — feature flags, states,
league notices, email links, test accounts, frontend. `backend-fix/.env.example`
carries the complete list with no values.

**Owner Check (read-only owner view at `/owner`):**

```
OWNER_EMAIL=fantasymmadness2@gmail.com
JWT_SECRET_OWNER=<32+ random chars, DIFFERENT from the other two secrets>
OWNER_SESSION_TTL=1h
OWNER_DEVICE_TTL_DAYS=30       # how long a PIN-trusted phone stays trusted
OWNER_PREVIEW_TTL=20m          # "view as" read-only session length
```

### Scheduler — now configured in `vercel.json`

`backend-fix/vercel.json` declares all seven jobs, so deploying the backend
registers them. Nothing to wire by hand.

| Job | Schedule | What breaks without it |
|---|---|---|
| `/api/cron/team-contests/settle` | every 15 min | Team Cards never settle; winners never paid |
| `/api/cron/challenges/expire` | every 30 min | Unanswered head-to-head stakes sit on players' coins |
| `/api/cron/seasons/advance` | hourly | Drafting never closes; finished seasons never score |
| `/api/update-shadow-open-status` | hourly (:05) | Shadow fights never open or close for entry |
| `/api/cron-job` | hourly (:15) | Fight rollover stops |
| `/api/cron/retention` | daily 15:00 UTC | No retention email |
| `/api/cron/owner-integrity` | daily 08:00 UTC | No nightly books check |

**Two things to know:**

1. **Set `CRON_SECRET` in Vercel before deploying.** Vercel signs its own cron
   requests with `Authorization: Bearer $CRON_SECRET`, and `verifyCronSecret`
   accepts that as well as an `x-cron-secret` header. Until the variable is set,
   every job correctly returns 503 — that is the guard working, not a fault.
2. **`*/15` and `*/30` need a Vercel Pro plan.** Hobby allows one cron run per
   day, which would mean Team Card winners waiting until the next morning.
   **A plan-independent scheduler is already included** — see below.

### Plan-independent scheduler (no Vercel Pro needed)

`.github/workflows/fmm-cron.yml` runs the frequent jobs from GitHub Actions
every 15 minutes, free. Two repository secrets, set once:

| Secret | Value |
|---|---|
| `FMM_API_BASE` | `https://fantasymmadness-game-server-three.vercel.app` |
| `FMM_CRON_SECRET` | the same value as `CRON_SECRET` in Vercel |

Settings → Secrets and variables → Actions → New repository secret. Then open the
**Actions** tab and use *Run workflow* to fire it once by hand — that confirms the
secret is wired up without waiting for the schedule.

Running this **and** `vercel.json` at the same time is harmless: every job is
idempotent, so a second call returns "already settled" rather than paying twice.
On Pro you can delete the workflow.

### Testing a job by hand

`backend-fix/run-cron.sh` fires the jobs directly — useful before you trust the
schedule, or to settle a card immediately mid-event:

```bash
chmod +x run-cron.sh
CRON_SECRET=... ./run-cron.sh                      # all jobs
CRON_SECRET=... ./run-cron.sh cron/team-contests/settle
```

Three separate secrets on purpose: player, admin, owner. A compromise of one
must not include the others.

### Feature flags — what is live and what is not

```
TEAM_CARDS_ENABLED=true          # LIVE. Five fighters from one event — the flagship
TEAM_PICKS_REQUIRED=5
TEAM_CALL_BONUS_CAP=50
SEASON_CARDS_ENABLED=true        # LIVE. Multi-sport season rosters
SEASON_CALL_BONUS_CAP=100
HEAD_TO_HEAD_ENABLED=false       # OFF pending legal — peer-to-peer staking
HEAD_TO_HEAD_RESTRICTED_STATES=
PRO_WRESTLING_ENABLED=false      # your call
```

**First contest should be free** (`entryFee: 0`). It exercises drafting,
crediting, scoring, settlement and prizes with no money exposed, and is legal in
all 51 jurisdictions.

### State configuration

```
PAID_STATES=                     # blank = all 45 DFS states + DC (the shipped default).
                                 # Set it only to NARROW that list.
BLOCKED_STATES=
AGE_21_STATES=MA,AZ,IA,LA,AL,NE
RESTRICTED_STATES=               # legacy; anything listed is treated as free-play
```

**HI, ID, MT, NV and WA are free-play only, hard-locked in code.** Naming one in
`PAID_STATES` is ignored and logs a warning at boot. Unknown state codes resolve
to free, never paid.

**Being able to take paid entries is not the same as being registered to.**
Several of those 46 jurisdictions require operator registration first. Narrow
`PAID_STATES` to what your attorney confirms and widen it as registrations land —
one variable per state, no deploy.

### League notices

```
LEAGUE_EMAIL_COOLDOWN_HOURS=24   # how often one promoter may email their league
LEAGUE_EMAIL_MAX_RECIPIENTS=5000
```

### Email links

```
ALLOW_UNSIGNED_UNSUBSCRIBE=true  # set false ~30 days after launch, once old
                                 # unsigned links have aged out of inboxes
```

### Test accounts — PREVIEW ONLY

```
TEST_ACCOUNTS_ENABLED=false      # NEVER true on production; passwords are guessable
TEST_ACCOUNT_DOMAIN=fmmtest.com
TEST_ACCOUNT_START_COINS=25000
```

Set `true` on preview, then **seed the demo card before minting logins** —
`POST /api/admin/demo-card` creates a fight in each of the five disciplines, one
already-scored fight, a joinable league, a free Team Card and a free Season.
Without it, testers have coins and nothing to spend them on.

Then mint the logins and hand out `Tester Handout.dc.html`. See
`TESTER-CREDENTIALS.md`. Purge both and set back to `false` before going live.

### Frontend

```
NEXT_PUBLIC_FIGHTER_CUTOUTS=true
NEXT_PUBLIC_CLOUDINARY_CUTOUT_TRANSFORM=e_background_removal
```

Needs the Cloudinary **AI Background Removal** add-on enabled. Until it is, the
app falls back to the original photos — safe either way.

---

## 2. MongoDB replica set — now checked for you

Entry charging, refunds, prize settlement, coin purchases and challenge escrow
all run inside MongoDB transactions, which **do not exist on a standalone
mongod**. Standalone gives no warning: it throws part-way through, which is the
worst possible moment because money may already have moved.

**You no longer have to remember to check this.** Three things now handle it:

**a. The server checks at boot.** On connection it asks MongoDB what it is. You
will see one of:

```
MongoDB topology OK — replica set "atlas-abc123". Transactions available.
```

```
FATAL: MongoDB is running as a STANDALONE server, which does not support
transactions. Paid fight entries, refunds, prize settlement, coin purchases and
challenge escrow will all FAIL until this is a replica set...
```

In production the FATAL line **exits the process** — it will not serve traffic in
a state where money paths are broken. In development it warns and continues.

**b. A URL you can hit instead of opening a shell:**

```
GET /api/health/db
```

`200` with `transactionsSupported: true` means money paths are safe. `503` means
they are not, and the message says what to do. Point your uptime monitor at this.

**c. The dev escape hatch can no longer fire in production.**
`FIGHT_ENTRY_ALLOW_NON_TRANSACTIONAL=true` used to let entries run without a
transaction. It is now ignored when `NODE_ENV=production` — the request returns
`503 DATABASE_NOT_TRANSACTIONAL` and logs a data-risk line, rather than charging
a player without recording their entry.

**If you get the FATAL line:** Atlas M10+ clusters are replica sets already, so
check the connection string points at the cluster and not a single host. For a
self-hosted node, start `mongod` with `--replSet rs0` and run `rs.initiate()`
once — a single-member replica set is enough for transactions.

---

## 3. Build the frontend

```
cd fmm-frontend && npm install && npm run build
```

25+ files were edited. This catches any import or syntax problem in about a
minute. Do not skip it.

---

## 4. Boot the backend and watch the first 10 lines

Expect either a clean start or a `FATAL:`/`WARNING:` line naming exactly what is
missing. Fix and repeat until clean.

---

## 5. Smoke tests — run in this order

The money paths. Stop and report if any step misbehaves.

| # | Test | Pass condition |
|---|---|---|
| 1 | Register → verify email → log in | Session works; no password appears in server logs |
| 2 | Buy coins (live card, smallest amount) | Balance increases once; wallet ledger has one row |
| 3 | Replay the payment webhook | No second credit; response says already credited |
| 4 | Enter a paid fight | Balance drops by exactly the fee, once |
| 5 | Enter the same fight again | Refused as already entered; no second charge |
| 6 | Edit predictions **after** lock | Refused (`FIGHT_LOCKED`) |
| 7 | Admin enters round stats → settle | Winners paid once; emails sent |
| 8 | Settle the same fight again | Returns `alreadySettled`; no second payout |
| 9 | Admin refunds a fight | Each player gets back what the **ledger** says they paid |
| 10 | Affiliate requests payout → admin rejects | Balance returns to the affiliate |
| 11 | Sponsor sign-in | Code arrives by email; wrong code fails; dashboard loads |
| 12 | Sign out everywhere | No token left in localStorage |
| 13 | Upload a non-image renamed `.jpg` | Rejected (`UNSUPPORTED_UPLOAD_TYPE`) |
| 14 | Open `/owner`, request a code with the owner email | Code arrives; a wrong code is refused |
| 15 | Open `/owner` with any other email | Same generic response, no code sent, no sign-in |
| 16 | Signed in at `/owner` | Config rows, live counts and integrity checks all render |
| 17 | Set up a PIN at `/owner`, reload | Asks for the PIN only, no email code |
| 18 | Enter a wrong PIN five times | Device is un-trusted; falls back to email code |
| 19 | Owner view → View as a player → open the app | Amber banner shows; their screens render |
| 20 | In that preview, try to enter a fight or spend coins | Refused with `PREVIEW_READ_ONLY`; no balance change |
| 21 | Close the preview tab, reopen the app normally | Your own session is intact, not theirs |
| 22 | Player in a non-`PAID_STATES` state tries to buy coins | Refused with `FREE_PLAY_ONLY` |
| 23 | Same player enters a free contest | Works; coins awarded with no cash value |
| 24 | 19-year-old in MA tries a paid contest | Refused — 21+ required there |
| 25 | Settle a paid fight with fewer entrants than break-even | Contest voids, every entry refunded, no prize paid |
| 26 | Settle a well-subscribed paid fight | Prize is exactly the declared pot; surplus split with the promoter |
| 27 | Add a badge (place 1) and a PPV code prize to a free fight, settle it | Winner gets both; code is unique; winner emailed |
| 28 | Settle that free fight again | No duplicate awards |
| 29 | Add a merch prize, settle, check `/api/admin/awards/fulfilment` | Appears with winner contact details |
| 30 | With H2H on, stake 50 v 50 and settle a decided result | Winner receives 90 FM; challenge records `rake: 10` |
| 31 | Settle a tied H2H | Both stakes returned in full; `rake: 0` |
| 32 | With Season Cards on, create a season, draft 5 fighters with a called number | Entry charged once; ledger row `season_entry` |
| 33 | Draft the same season twice | Refused, `ALREADY_DRAFTED`; no second charge |
| 34 | Settle a fight one of your fighters was in | `seasonCards.credited` > 0; `/api/seasons/me` shows raw points rising |
| 35 | Settle the season | Each slot scored /100 within its sport; called numbers that were met paid as bonus |
| 36 | Settle the season again | `alreadySettled: true`; no second payout |
| 37 | Void a paid season | Every entrant refunded with a `season_refund` ledger row and an email |
| 38 | Settle a paid season with only ONE entrant | Entry refunded, no prize paid, `payout.refunded: true` |
| 39 | Hit `/api/cron/seasons/advance` with the cron secret | Draft-closed seasons flip to RUNNING; ended seasons settle |
| 40 | Draft a card, then check the profile screen | `My Season Cards` shows five fighters, live points, called-number progress |
| 41 | Create a Team Card on a 5+ bout event, enter 5 fighters | Entry charged once; ledger row `team_entry` |
| 42 | Try to pick both fighters from one bout | Refused, `DUPLICATE_BOUT` |
| 43 | Create a 5-pick Team Card on a 3-bout event | Refused, `NOT_ENOUGH_BOUTS` |
| 44 | Settle each bout on the card | Team points appear per fighter; leaderboard moves live |
| 45 | Hit `/api/cron/team-contests/settle` after the last bout | Contest settles; winners paid; not before the last bout |
| 46 | As a promoter, run a Team Card then try to enter it | Contest created; entry refused with `AFFILIATE_SELF_ENTRY` |
| 47 | Open `/terms` directly | Full 25-section Terms render, serif type, no missing styles |
| 48 | Sign up as a player | Consent line above the button links to `/terms` in a new tab |
| 49 | App menu → Terms of Use | Opens `/terms`; also linked from the scoring-rules screen |
| 50 | Hard-refresh the home screen on a phone, watch the top | One banner only — no flash of a different header, no jump |
| 51 | Same on a throttled connection (DevTools → Slow 4G) | Placeholder and real hero are the same image at the same size |
| 52 | Open the app route, DevTools → Network → CSS | `featured-fight-stage-final`, `pro-wrestling`, `experience-theme`, `affiliate-experience-final` must NOT load |
| 53 | Open a legacy page (`/`, `/AffiliateDashboard`, pro-wrestling) | Those four DO load from `/legacy-css/`, pages fully styled |
| 54 | Compare app open time before/after | ~571 KB less CSS parsed before first paint |
| 55 | As a normal player, `PUT /update-profile-url` | 403 — admin only (was: overwrote every account's avatar) |
| 56 | As a player, `POST /admin/add-tokens-won` with someone else's email | Coins credit YOUR account, not theirs |
| 57 | As a player, `GET /user/<another player's email>` | Name and avatar only — no phone, no zip |
| 58 | `GET /unsubscribe-user/<id>` with no `?t=` | Works for now, logs a warning; blocked once `ALLOW_UNSIGNED_UNSUBSCRIBE=false` |
| 59 | Unsubscribe from a real email | Link carries `?t=`, unsubscribes correctly |
| 60 | `DELETE /api/scores` with no `confirm` | 400 `BULK_CONFIRMATION_REQUIRED` — nothing deleted |
| 61 | Same with `confirm` but an unsettled fight open | 409 `UNSETTLED_CONTESTS_EXIST`, names the count |
| 62 | Any `/all/delete/*` route with no `confirm` | 400 — nothing deleted |
| 63 | Start the server | Boots with no `ReferenceError` (was: crashed on `requireBulkConfirmation`) |
| 64 | Home screen on a phone, inspect `.fmm-app-hero` | Computed `aspect-ratio: 16/9`, image `object-fit: contain` — whole banner visible |
| 65 | Watch the five discipline circles for 15s | They cross-fade through the fighters on that discipline's fights |
| 66 | Add a fight with fighter images, reload | The new fighter appears in that discipline's cycle |
| 67 | Press any button | It lights up, has a glaze, and makes a click |
| 68 | Press the treasure chest | Tap + chime (check the iPhone ringer switch if silent — iOS mutes web audio) |
| 69 | Scroll the home screen | News bar stays pinned at the bottom, above the nav |
| 70 | With a scored fight and a populated leaderboard | Bar shows the leader, who beat whom, pots and entry counts |
| 71 | Publish a fight from admin, leave the app open 60s | Bell badge increments, no reload needed |
| 72 | Open the bell | New fight listed with its entry fee; badge clears |
| 73 | Close and reopen the app | Badge stays cleared (server-side read state) |
| 74 | Enter a fight, settle it | "Results are in" appears; a fight you did NOT enter does not |
| 75 | Activate a NON-featured fight | No email sent; response says `NOT_FEATURED`; bell still shows it |
| 76 | Activate a fight marked Featured This Week | Email goes out, only to subscribed users |
| 77 | Unsubscribe, then activate a featured fight | You receive nothing |
| 78 | Tap the TikTok and Facebook icons | Open `@fantasy.mmadness` and the real Facebook page |
| 79 | As a verified promoter, open Leagues | Promoter panel shows members / playing / new-7d |
| 80 | Announce one of your cards | Members get a bell notice AND an email; response states the reach |
| 81 | Announce a second card immediately | Bell notice only; response explains the email cooldown |
| 82 | Try to announce a fight that is not yours | Refused, `NOT_YOUR_FIGHT` |
| 83 | Tap Share on a card | Ready-written Facebook / TikTok / SMS text, each copyable, links carry `?ref=` |
| 84 | As a league member, check the bell | The promoter's notice is listed |
| 85 | Fighter portraits with the Cloudinary add-on OFF | Original photos show, nothing broken |
| 86 | Enable Cloudinary AI Background Removal, reload | Same portraits render with transparent backgrounds |
| 87 | `POST /api/admin/fighters/backfill` | Roster created from existing fights; each gets an `FM-` id |
| 88 | Run it a second time | No duplicates, nothing overwritten |
| 89 | `GET /api/admin/fighters/overview` | Totals, plus fighters needing consent ordered by appearances |
| 90 | Attach a branded image to a fighter with no consent | Refused, `LIKENESS_CONSENT_MISSING` |
| 91 | Record consent with no `source` | Refused, `CONSENT_SOURCE_REQUIRED` |
| 92 | Record consent properly, attach a branded image, switch it live | `GET /api/fighters/:key` returns the branded image |
| 93 | Replace that branded image | Previous one appears in `/versions` |
| 94 | Publish a fight with a new fighter name | Profile created automatically; appearances = 1 |
| 95 | Enter a Team Card, tap STANDINGS | Ranked list with places, names and points |
| 96 | Same mid-card, before every bout is scored | Marked "Live", each row shows how many of their fighters are scored |
| 97 | Season Card → STANDINGS | Marked "Provisional" until the season settles, then "/500" scores |
| 98 | `POST /api/admin/test-accounts` on preview | 6 player + 2 league logins, each with 25,000 FM |
| 99 | Same call with `NODE_ENV=production` | Refused, `PRODUCTION_BLOCKED` |
| 100 | Purge with the confirm string | Test accounts, their predictions and ledger rows gone; real players untouched |
| 101 | App route → Network → CSS | ~1,939 KB, not 2,994 KB; the eight `/legacy-css/` files absent |
| 102 | Home, fight detail, affiliate dashboard, pro-wrestling pages | All fully styled — the split's one real risk |
| 103 | If any of those looks wrong | Revert per `src/styles/split/HOW-TO-ACTIVATE.md` (two lines) |
| 104 | Spin the welcome wheel, then sign in as the same account on a second phone | No wheel offered — once per account, not just per device |
| 105 | Spin and watch the response | Coins credited AND a success response (was: credited, then a 500) |
| 106 | Watch the news bar for 30s | Real items — leader, results, pots, entry counts. Not system messages |
| 107 | Leave the app open 60s after publishing a fight | Bell increments without a reload |
| 108 | `POST /api/admin/demo-card` on preview | 5 upcoming fights + 1 scored + league + Team Card + Season |
| 109 | Run it a second time | Nothing duplicated |
| 110 | Sign in as a tester | Fights visible in all five disciplines; the scored one shows a result |
| 111 | Purge the demo card | Only `[DEMO]` fights and their entries go; real fights untouched |
| 112 | Testers enter, then `POST /api/admin/demo-card/fast-forward` | Every demo fight settles; scores, prizes and standings appear |
| 113 | `POST /api/admin/demo-card/replay` | Entries cleared, fights reopened, pots zeroed, testers back to 25,000 |
| 114 | Run the enter → fast-forward → replay loop three times | Balances and ledger stay consistent each round |
| 115 | Fast-forward with no demo card seeded | `NO_DEMO_CARD`, nothing changed |
| 116 | Seed accounts, check the six leagues | Each has its own name and a starting balance |
| 117 | Sign in as each league owner, open Leagues | Each sees only their own fights to announce |
| 118 | As a league owner, try to enter your own contest | Refused, `AFFILIATE_SELF_ENTRY` |
| 119 | Sign in to the admin console as `backoffice1@fmmtest.com` | Full back-office access |
| 120 | Purge test accounts | Players, leagues AND the admin all removed — no privileged login left behind |
| 121 | `GET /api/public/demo-card/pots` while testers enter | Live pot rises per entry; `willVoidIfSettledNow` flips false once minimums are met |
| 122 | All testers enter the SAME fight on a countdown | Pot rises by exactly one fee per person; no duplicate entries |
| 123 | `GET /api/admin/test-accounts/reconcile` | `clean: true` — every balance matches its ledger |
| 124 | Settle while testers are still entering, then reconcile | Still clean, or the findings name exactly what drifted |
| 125 | Eight testers on one WiFi each enter a contest | None blocked — the limiter buckets per session, not per IP |
| 126 | Buy coins with sandbox card 4111 1111 1111 1111 | Coins credited once, one ledger row |
| 127 | Buy coins with decline card 4222 2222 2222 2 | No coins, no ledger row, a clear message |
| 128 | Buy twice in a row | Two separate credits, not swallowed as a duplicate |
| 129 | Browse the app fully signed out | Fights visible, purpose clear, sign-up findable |
| 130 | Set a deposit limit, then exceed it | Refused |
| 131 | Self-exclude, then try to enter or buy | Both refused; no promotional email |
| 132 | Register a second account on the same device | Blocked |

---

## 6. Before you take real money

Everything above can be done on a preview deployment with test accounts. These
four gate production, and none of them are code:

1. **Rotate `JWT_SECRET` and `JWT_SECRET_ADMIN`** to fresh, different, 32+ char values. The boot guard enforces this — the server will not start otherwise.
2. **Confirm `GET /api/health/db` returns 200** with transactionsSupported: true.
3. **Set `PAID_STATES` to the states your attorney confirms** — not the 46-state default. This is the revenue gate, and it is a legal question rather than a technical one.
4. **Purge the test accounts** and set `TEST_ACCOUNTS_ENABLED=false`.

Then confirm `AUTHORIZE_NET_ENVIRONMENT=production` with a live signature key, and
that `HEAD_TO_HEAD_ENABLED` is still false.

---

## 7. This folder is not a deployable app

`backend-fix/` holds `server.js` and its docs. `server.js` requires five sibling
modules that live in the real repository and are **not here**:

```
./swarm-phase2   ./seo-performance-phase2   ./fight-data-quality
./ufc-event-discovery   ./client-feedback-core
```

Copy `server.js` and `vercel.json` **into** the repo. Deploying this folder on its
own fails at boot with a missing-module error.

---

## 8. Known gaps — deliberate, not oversights

| Gap | Why |
|---|---|
| **Head-to-Head is off** | Peer-to-peer staking is classified differently from pooled contests in some states. Built and tested, waiting on legal |
| **No SMS** | Needs Twilio, US A2P carrier registration and written consent per player. Real penalties for getting consent wrong |
| **Fighter admin has no UI** | Consent, branded images and gear designs are API-only. Nothing depends on it at launch — no AI is running |
| **Server-side rendering off** | Would cut startup further, but the mobile component reads window during mount. Needs a running app to change safely |
| **Etsy apparel is slow** | Images are fetched live from Etsy on every request. Fix is hourly catalog caching on our side |
| **Terms exist in two places** | The printable master and the in-app page. Change one, change the other |
| **AI gear generation not built** | Models cannot hold a real face while changing clothing, and an altered fighter likeness promoting a paid contest has no clear legal cover. The consent gate is built and enforced for when that changes |

---

## 9. The honest state of this

Every line is statically verified — it parses, boot order is checked, and seven
security passes found and fixed 40+ real issues, including NoSQL injection on
every login, a route that let any player overwrite every account avatar, and a
settle path that could pay a prize pool twice.

**None of it has been run.** No server started, no coin moved, no fight settled.
That is why section 5 is ordered as it is: tests 1–10 are the money paths, and if
any of them misbehaves, nothing else on the list matters yet.

---
## 10. Phone testing

The mobile app is a Next.js route, not a native build — open it in the phone
browser.

- **Banner** fills the width at 16:9 and shows the **whole** image — nothing cropped off the sides, no jump as it loads, no flash of a different header first.
- **Green panel** below it has two buttons side by side: TRY DEMO and PLAY FREE. Neither the panel nor the banner should be secretly tappable.
- **Discipline circles** cross-fade through the fighters on that sport, roughly every 4 seconds.
- **News bar** stays pinned at the bottom while you scroll and carries real items.
- **Every button** lights up, has a glaze, and clicks. Silent means the phone ringer switch, not the code.
- **Content appears within a second or two** — no long blank wait.
- Per-round scorecards submit and charge the entry fee once.
- Team Card and Season Card entries appear on the profile with a STANDINGS link.
- Bell notifications persist after closing and reopening.
- Leagues screen: a promoter panel if signed in as a league, the Head-to-Head **waitlist** card otherwise (H2H is off).
- No dead buttons anywhere.

---

## 11. Already verified statically — no need to re-check

Machine-verified, not eyeballed:

- **Boot order** — every middleware is defined before its first route use. The one real violation (`requireBulkConfirmation`) crashed the server at boot and is fixed; four look-alikes were confirmed as deferred wrappers.
- **Server parses** cleanly, all 23k lines.
- **Database capability self-checks** — standalone MongoDB is detected at boot, blocks a production start, and `/api/health/db` reports it.
- **Frontend imports** — every auth-header helper is imported in each file that uses it; the one duplicate import that would have failed the build is fixed.
- **CSS split integrity** — all 14 @font-face, 6 :root blocks, 16 @keyframes and every body rule stayed in the app half; kept + legacy accounts for 100% of the original bytes.
- **Mobile app wiring** — every handler the app calls is passed by the shell, every modal it opens exists, and every render method it mounts is defined.
- **No dead code** from removed simulations; no duplicate state keys.

## 12. NOT verified

- **Anything at runtime.** No request has been made against this code.
- Load behaviour and database index performance.
- Accessibility and cross-device browser QA.
- Dependency vulnerabilities (`npm audit`).
- Whether the four legacy website pages still look right after the CSS split — section 5, tests 102–103.

---

## Operational notes

- **The in-memory rate limiter is per-instance.** More than one instance means the counters diverge — move to Redis if you scale out.
- **`bold-hero-new.jpg`** (403 KB, 1983px) has no mobile variant. Lazy-loaded, so it does not affect startup; ~300 KB of avoidable scroll weight.
- **JSON-LD blocks inject `JSON.stringify`** into script tags. Admin-authored content only.
- **Delete the legacy branch in `requireScope`** 30 days after deploy. Tokens issued before scopes existed are allowed through; once the 30-day session TTL has rolled over, that allowance is dead weight and removing it makes the check absolute.
- **Set `ALLOW_UNSIGNED_UNSUBSCRIBE=false`** on the same schedule, once old email links have aged out.

Full finding-by-finding record: `backend-fix/SECURITY-AUDIT.md`.
Tester logins and the handout: `backend-fix/TESTER-CREDENTIALS.md` and `Tester Handout.dc.html`.

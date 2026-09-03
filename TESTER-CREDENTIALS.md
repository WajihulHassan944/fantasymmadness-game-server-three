# Test accounts for your testing group

## Why separate accounts instead of one shared login

One login handed to six people does not work for this app. Testers would
overwrite each other's predictions, spend the same coins, and every second entry
would be rejected by the one-entry-per-player rule. It also cannot exercise
duplicate-account prevention, per-user notifications, or head-to-head — all of
which need two distinct people.

So each tester gets their own pre-verified, pre-funded account.

## Already seeded? Run this once

The first seed created fights but never flagged any as featured, so the app's
**Featured This Week** and **Featured Fight** sections were empty and the
website's promoted list returned nothing — the data was there, nothing was
flagged.

```bash
curl -X POST https://YOUR-SERVER/api/admin/demo-card/repair-featured \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Reload the app and website afterwards. A fresh seed now sets the flags itself.

## Seed the demo card FIRST

Test accounts with 25,000 coins are useless against an empty database. Before
handing out any logins, seed a card for them to play:

```bash
curl -X POST https://<preview-url>/api/admin/demo-card \\
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

That creates:

| What | Detail |
|---|---|
| 5 upcoming fights | One per discipline — boxing, MMA, bare knuckle, kickboxing, pro wrestling |
| A stakes ladder | Free · 100 · 500 · 1,500 main event with a **20,000 guaranteed pot** · 4,000 high roller |
| 1 fight already scored | So results, standings and "results are in" notices work the moment a tester signs in, instead of waiting for a settle |
| A league to join | Attached to `league1@fmmtest.com`, so the promoter panel has real fights to ANNOUNCE |
| A free Team Card | Over all five upcoming bouts |
| A free Season | Drafting open for two days |

Every fight is named with a `[DEMO]` prefix and dated 3–7 days out, so entry stays
open throughout testing.

**Testers start with 6,000 coins, not 25,000.** That is deliberate. With an
effectively infinite balance nobody thinks before entering, and a tester who
cannot run out does not behave like a player. At 6,000 the main event costs a
quarter of the stack and the high roller two thirds — so they have to choose,
which is when the interesting bugs surface. Override with
`{"coins": 25000}` if you want a looser session.

**Watch the pots move:**

```bash
curl https://<preview-url>/api/public/demo-card/pots
```

No auth needed. Returns each fight's entry fee, how many are in, the live pot, and
whether it would void if settled right now. Keep it open on a laptop while they
play — "the pot just hit 9,000" is what makes people enter.

The main event carries a **20,000 guaranteed pot with a promoter stake behind
it**, which is the real Shadow Fight mechanic: entries fill the pot and the
promoter keeps the surplus past break-even. The high roller needs **4 entrants**,
so if only two or three enter it must void and refund — that guard is worth
watching fail safely.

Safe to re-run: it reuses anything already seeded rather than duplicating.

### Removing it

```bash
curl -X DELETE https://<preview-url>/api/admin/demo-card \\
  -H "Authorization: Bearer <ADMIN_TOKEN>" \\
  -H "Content-Type: application/json" -d '{"confirm":"DELETE-ALL-DEMOCARD"}'
```

Matched on the `[DEMO]` prefix only, so a real fight can never be caught by it.
Removes the fights, their predictions, and the demo contests and seasons with
their entries.

---
## Setup (once, on the PREVIEW environment)

Set in Vercel, preview scope only:

```
TEST_ACCOUNTS_ENABLED=true
TEST_ACCOUNT_START_COINS=25000
```

Then, signed in as an admin:

```bash
curl -X POST https://<preview-url>/api/admin/test-accounts \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"players":6,"affiliates":6,"admin":true,"state":"GA","coins":6000}'
```

## The credentials it creates

Predictable on purpose, so you can text them to someone without a password
manager. Safe **only** because the feature is environment-gated and the accounts
are disposable.

| Role | Email | Password |
|---|---|---|
| Player 1 | `tester1@fmmtest.com` | `FightNight-tester1` |
| Player 2 | `tester2@fmmtest.com` | `FightNight-tester2` |
| Player 3 | `tester3@fmmtest.com` | `FightNight-tester3` |
| Player 4 | `tester4@fmmtest.com` | `FightNight-tester4` |
| Player 5 | `tester5@fmmtest.com` | `FightNight-tester5` |
| Player 6 | `tester6@fmmtest.com` | `FightNight-tester6` |
| Southside Fight Club | `league1@fmmtest.com` | `FightNight-league1` |
| The Cutmen | `league2@fmmtest.com` | `FightNight-league2` |
| Iron Row Collective | `league3@fmmtest.com` | `FightNight-league3` |
| Backyard Brawlers | `league4@fmmtest.com` | `FightNight-league4` |
| Championship Circle | `league5@fmmtest.com` | `FightNight-league5` |
| The Corner Crew | `league6@fmmtest.com` | `FightNight-league6` |
| **Back office (admin)** | `backoffice1@fmmtest.com` | `FightNight-backoffice1` |

Each player starts with **25,000 FM** and a **Georgia** residence (a paid-contest
state, so paid entry is testable). Date of birth is set to 1990, clearing the 21+
threshold everywhere.

All six league accounts are **verified**, each with its own league name and a
seeded balance — so a payout request is testable immediately rather than after
waiting for rake to accumulate across several settled contests. The demo fights
are **spread across the six leagues**, so each owner has something of their own to
announce, and a player can see what happens when two leagues promote the same
night.


## The back-office login

`backoffice1@fmmtest.com` / `FightNight-backoffice1` — signs in at the admin
console, not the app. One only: a second admin proves nothing extra, and every
privileged login is another thing to remember to delete.

Use it to walk the workflow you will actually be doing on a fight night, rather
than only the player side:

1. **Publish a fight.** Does it appear for testers? Does the bell fire within a minute?
2. **Enter round stats and settle.** Are the right people paid, once?
3. **Refund a player.** Does the amount match what the ledger says they paid — not the current fee?
4. **Approve, then reject, an affiliate payout.** Does the balance come back on a rejection?
5. **Look at the dashboard counts.** Do they match what you can see happening?
6. **Add a sponsor prize** to a free fight and settle it. Does the winner get a code, and does it appear in the fulfilment queue?
7. **Open the fulfilment queue.** Is the winner contact detail there and readable?

What to watch for, because these are the things a checklist misses: how many taps
a routine action costs, whether anything is ambiguous about which fight you are
about to settle, and whether a destructive button looks different from a safe one.

**It is purged with everything else** — one DELETE removes the players, the
leagues and this admin together, so a privileged test login cannot be left behind.
## Running it again

Safe. An existing tester keeps their entries and history — only the password is
re-issued, which is how you rescue someone who lost theirs.

## Mid-session top-up

```bash
curl -X POST https://<preview-url>/api/admin/test-accounts/refill \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" -d '{"coins":25000}'
```

## The fast cycle — a full fight night in two calls

Testers should not wait days to see a score. Two endpoints collapse the whole
thing, so they can play, see results, and go again in minutes.

### 1. They enter, then you fast-forward

```bash
curl -X POST https://<preview-url>/api/admin/demo-card/fast-forward \\
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Fills in official round stats, moves the fights into the past, and settles
everything — scorecards, Team Cards and the Season. Within seconds every tester
sees their points, their placing, prizes in their wallet, and results in the bell.

It settles through the **real** settle endpoint, forwarding your admin token —
not a shortcut. A demo path that faked settlement would prove nothing about the
code that actually pays people.

### 2. Reset and go again

```bash
curl -X POST https://<preview-url>/api/admin/demo-card/replay \\
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Clears every demo entry, reopens the fights on fresh future dates, wipes the
settlement stamps, resets the contest pots, tops every tester back to 25,000
coins, and clears their bell so it lights up again.

Then they enter again. Fast-forward again. As many rounds as you want in an hour.

### Why the pots are zeroed on replay

The coins that were in them have just been refunded to the testers. Leaving the
pot behind would pay the next round out of money that no longer exists — and the
ledger would stop balancing, which is the one thing you want to be able to trust
when you read it afterwards.

### What this exercises each cycle

- Entry charging and the one-entry-per-player rule
- Per-round scorecards in all five disciplines
- Server-side scoring from official stats
- Prize distribution at the real 60/30/15 and 50/30/20 tiers
- Team Card settlement, one fighter per bout, called-number bonuses
- Season normalisation out of 100 per slot
- Standings for both contest types
- Bell notifications, results emails, wallet ledger rows

Everything except real card payments and withdrawals.

---
## What to ask your testers to do

Six players and six league owners. If you have fewer than twelve people, give
someone both — a league owner cannot enter their own contest, so they will need a
player card to test entry as well.

1. Sign in, enter one of the paid `[DEMO]` fights, confirm the coin balance drops **once**.
2. Try to change predictions after the fight starts — must refuse.
3. All six enter the `[DEMO] Fight Night Team Card`, then check **STANDINGS**.
4. A league account announces a card; the players confirm the bell notice arrives.
5. Two players each draft the `[DEMO] Test Season` with a called number.
6. Someone claims the treasure chest and the spin wheel.
7. Anyone tries to register a second account on the same device — must be blocked.
8. Tell me when everyone has entered. I fast-forward, you all check your scores
   and standings, then I reset and we go again.


## Testing everyone at once — the most valuable session you can run

Every money bug found in this codebase was a **race**: two settles paying the
same pot, two accepts debiting the same stake, an entry charged without being
recorded. Races only appear under concurrency. Thirteen people tapping at the
same moment finds things that thirteen people taking turns never will.

### One fix was needed before this could work

The rate limiter keyed on **IP address**. Testers sharing a WiFi share one
public IP, so the ninth person to enter a contest would get blocked and report
"can't enter" as a bug. It now buckets per session instead — so a household, an
office or a watch party cannot lock itself out. Sign-in stays IP-limited, which
is correct: brute force comes from one machine.

### Run it like this

1. **Everyone signs in first**, before anyone touches a contest. Sign-in is still IP-limited at 10 per 15 minutes, so if you are all on one WiFi, stagger the logins.
2. **Pick one fight. Count down. Everyone enters on zero.** This is the test — same contest, same second.
3. **Watch the pot** on a laptop: `GET /api/public/demo-card/pots`. It should rise by exactly one entry fee per person, no more, no less.
4. **Then the harder one:** have everyone enter while you run fast-forward at the same time. Settling mid-entry is the real-world nightmare — a fight ending while someone is still submitting.
5. **Reconcile.** This is the step that matters.

### Reconcile — the check a tester cannot do for you

```bash
curl https://<preview-url>/api/admin/test-accounts/reconcile \\
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Nobody notices 100 missing coins. This does. It re-derives every test account's
balance from the ledger and compares it to the stored balance, checks the ledger
chain for interleaved writes, looks for duplicate entries, and verifies each
contest pot equals what was actually collected.

You get one line back:

> **Books balance.** Every test account matches its ledger, no duplicate entries, pots correct.

Or a list of exactly what is off, by account and by amount. **Run it after every
simultaneous round.** A clean reconcile after five concurrent rounds is real
evidence the money paths hold; anything else is an opinion.

### What this session will NOT tell you

Being straight about the limits: thirteen people is a concurrency test, not a
load test. It will not surface slow database queries, index problems, or how the
app behaves at a thousand users. And the in-memory rate limiter is per-instance —
if the host runs more than one, the counters diverge. Neither matters at your
stage; both will at some point.

---

## Buying coins — testable, with sandbox cards

The payment code already defaults to Authorize.net **sandbox**, so the full
purchase flow can be tested with fake cards and no real money. This matters:
buying coins is how money enters the platform, and it was the one money path a
tester could not otherwise reach.

On the preview environment:

```
AUTHORIZE_NET_ENVIRONMENT=sandbox
AUTHORIZE_NET_API_LOGIN_ID=<sandbox login id>
AUTHORIZE_NET_TRANSACTION_KEY=<sandbox transaction key>
```

Get those from a free Authorize.net sandbox account. Then hand testers these
card numbers — they are Authorize.net's official test cards, they are not real,
and they never move money:

| Card | Number | What it tests |
|---|---|---|
| Visa | 4111 1111 1111 1111 | A successful purchase |
| Mastercard | 5424 0000 0000 0015 | A successful purchase |
| Amex | 3700 0000 0000 002 | A different card length |
| Visa (decline) | 4222 2222 2222 2 | **A declined payment** |

Any future expiry date, any 3-digit CVV (4 for Amex).

**The decline card is the important one.** A successful purchase is easy; what
you need to know is that a *failed* payment leaves no coins credited, no ledger
row, and a message the player understands. Ask two testers to try it.

Also worth trying: buy coins, then immediately buy again — the second purchase
must credit separately, not be swallowed as a duplicate.

**Set `AUTHORIZE_NET_ENVIRONMENT=production` before you go live.** Sandbox on
production means every real purchase silently succeeds without taking money.

## Three things the ten-step list misses

Worth assigning to specific people, because nobody does these unprompted:

**1. The guest experience — give this to someone with no card at all.**
Ask them to open the app and browse without signing in. Can they see fights?
Understand what the app is? Find the sign-up? This is the first impression every
real user gets, and no tester card covers it.

**2. Responsible play — one tester, near the end of the session.**
In account settings: set a deposit limit, then try to exceed it. Then
self-exclude. While excluded they must not be able to enter or buy anything, and
must stop receiving promotional email. **This is the one that matters legally**,
and it is the least likely to be tested by accident. Warn them it locks their
account for the period they choose — it cannot be lifted early, by design.

**3. Duplicate accounts — one tester, deliberately.**
Ask them to register a second account on the same phone. It must be blocked. Then
ask them to try from a different browser on the same device.

---
## Before you go live

```bash
# 1. Purge
curl -X DELETE https://<preview-url>/api/admin/test-accounts \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" -d '{"confirm":"DELETE-ALL-TESTACCOUNTS"}'

# 2. Then set TEST_ACCOUNTS_ENABLED=false
```

The purge only touches rows flagged `isTestAccount`, so a real player can never
be caught by it. It removes the accounts, their predictions and their ledger rows.

## The one rule

**Never set `TEST_ACCOUNTS_ENABLED=true` on production.** The passwords are
guessable by design. The code refuses to run when `NODE_ENV=production` unless
`ALLOW_TEST_ACCOUNTS_IN_PRODUCTION` is also set — do not set it.

# Growth Engine back-office API (isolated staging)

Base: `https://<isolated-deployment>/api/growth` — served only by the isolated
Vercel project `fantasymmadness-growth-isolated-test`. Admin routes need
`Authorization: Bearer <admin JWT>` signed with that project's `JWT_SECRET_ADMIN`
(the same token the back office already uses with `/admin/login`).

| Method | Path | Purpose | Body / query | Success |
|---|---|---|---|---|
| GET | `/health` | Config status (public, no secrets) | — | `{ok, errors[], warnings[], delivery, database}` (503 if not ready) |
| GET | `/cron/tick` | Scheduled run (Vercel Cron) | `Authorization: Bearer CRON_SECRET` | `{ok, summary}` |
| GET/POST | `/unsubscribe` | One-click opt-out | `?token=` | HTML page / `{ok}` |
| GET | `/admin/overview` | Dashboard counters, last 10 runs, latest daily report | — | `{overview}` |
| GET | `/admin/drafts` | Review queue | `status` (`needs_owner_review`, `approved`, `delivered`, `rejected`, `suppressed`, `delivery_failed`), `kind` (`marketing`, `pr`, `affiliate`), `limit` | `{drafts[]}` |
| POST | `/admin/drafts/:id/approve` | Owner approval (only from `needs_owner_review`) | — | `{ok, draft}` / 409 |
| POST | `/admin/drafts/:id/reject` | Reject | `{reason}` | `{ok, draft}` / 409 |
| GET | `/admin/prospects` | Discovered media/creator prospects | `genre`, `limit` | `{prospects[]}` |
| POST | `/admin/prospects/:id/contact` | Owner attests a verified business contact + consent basis; creates a personalized PR/affiliate draft for review | `{contact, kind: "pr"\|"affiliate", consentNote}` | 201 `{ok, draft}` / 422 `{reason}` |
| GET | `/admin/alerts` | Failure alerts | `state` (`open` default, `all`) | `{alerts[]}` |
| POST | `/admin/alerts/:key/ack` | Acknowledge | — | `{ok}` |
| POST | `/admin/jobs/:id/requeue` | Re-run a job that exhausted its retries | — | `{ok}` / 409 |
| POST | `/admin/suppressions` | Manually opt someone out | `{address, reason}` | 201 |
| POST | `/admin/run-now` | Run a tick immediately (same safety rules) | — | `{ok, summary}` |

Draft lifecycle: `needs_owner_review` → `approved` → `delivered` (or `suppressed` / `delivery_failed`), or `rejected`.
Marketing drafts are social posts: once approved they are "ready to publish" (copy into the social accounts); there is no social-posting provider.
PR/affiliate drafts are emails: delivered only when the configured provider is authorized (see ACTIVATION-CHECKLIST.md).

Suggested back-office screens (fmm-ver2, admin area): Overview tiles · Review queue (approve/reject with preview of HTML) · Prospects (add verified contact) · Alerts (ack, requeue) · Opt-outs.

## Back-office console (Phase 2)

Open **`https://<isolated-deployment>/api/growth/console`** and sign in with the owner password.
The password itself is never stored: the isolated project holds only its scrypt hash in
`GROWTH_ADMIN_PASSWORD_HASH`. To change it, generate a new hash
(`node -e "console.log(require('./growth-backoffice').hashPassword('NEW PASSWORD'))"`), replace the
variable in the isolated project, and redeploy. Sign-in issues a 12-hour token; 10 wrong attempts
from one address lock sign-in for 15 minutes.

Screens: Overview · Campaign Approvals · Marketing · Public Relations · Affiliate Recruitment ·
Automation · Analytics · Revenue Attribution. All data is read live from `fmgrowthtest`.

Additional routes used by the console (all admin-only):

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/login` | `{password}` → `{token}` (12 h). 401 wrong password, 429 rate limited, 503 not configured |
| GET | `/admin/session` | Token check |
| GET | `/admin/status` | Scheduler health (last run, runs in 24 h), delivery status, warnings |
| GET | `/admin/runs` · `/admin/jobs` | Run history; background jobs (`state` filter) |
| GET | `/admin/workstreams` | 25 department × sport results for a run (`runId`, `department`) |
| GET | `/admin/workstreams/:runId/:workstreamId` | Prepared drafts (with prospect names, email HTML) |
| POST | `/admin/drafts/:id/edit` | `{headline|subject, text}` — only while awaiting approval; email HTML rebuilt from escaped text |
| POST | `/admin/drafts/:id/mark-published` | `{postUrl?}` — approved marketing posts only (owner posted it manually) |
| GET | `/admin/analytics` | Counts, approval rate, 5×5 department matrix, runs per day, daily reports |
| GET | `/admin/attribution` | Revenue credited only from verified, settled `paid_entry` events in `growth_attribution_events`; tracked links for approved affiliates. Live payments are not connected. |
| GET | `/admin/reports` · `/admin/audit` · `/admin/suppressions` | Daily reports, owner activity log, do-not-contact list |

Verification: `growth-console.e2e.test.js` (Chromium drives every screen and button against real
routes and MongoDB; CI workflow `growth-console-e2e.yml`) and `growth-acceptance/console-live-check.js`
(the same walkthrough against the live isolated Atlas data, using only labelled `uitest-` fixtures
that it deletes afterwards).

# Growth Engine — implementation & activation checklist

Isolated staging only. Nothing here touches the live website, production database or payments.
Project: `fantasymmadness-growth-isolated-test` (prj_Hpe9UjGrBBJOm3boxHsL9lHesWLl) · Branch: `test/growth-unattended-controller` · PR #102 (do not merge).

## A. Already implemented on the branch
- Isolated service mounted inside the existing deployment, **only** when `VERCEL_PROJECT_ID` is the isolated project (inert in the production backend). Health check reports any missing setting.
- Persistent scheduler: Vercel Cron every 15 minutes → `/api/growth/cron/tick` (minute claims prevent duplicates; stale interrupted runs detected and alerted; daily discovery / follow-up / report jobs with retry + backoff; exhausted jobs alerted; admin requeue).
- Database: all state in Atlas database `fmgrowthtest` (store `store_5mRLkf9U8eKGIaaO`), unique indexes for idempotency.
- Marketing: daily real public discovery for all five sports → one social-post draft per sport for owner review.
- PR + affiliate recruitment: discovered prospects → owner adds a verified contact + consent basis → personalized email draft → owner approval → delivery (suppression-checked, at most once) → follow-up drafts (4 then 7 days, stop on reply/opt-out/bounce, max 2).
- Opt-out: signed one-click unsubscribe link + `List-Unsubscribe` headers; permanent suppression list.
- Delivery providers: `none` (default, nothing sent), `sandbox-smtp` (loopback only), `resend` (real, locked behind every approval flag below).
- Back office: admin API (see BACK-OFFICE-API.md) with audit log.

## B. Vercel settings needed for the isolated project (exact)
Environment variables (Production + Preview):
| Variable | Value | Status |
|---|---|---|
| `GROWTH_STAGING_MODE` | `isolated` | present |
| `GROWTH_OUTBOUND_ENABLED` | `false` | present (keep false until section D) |
| `MONGODB_URI` | from Atlas store fmgrowthtest | present (integration) |
| `JWT_SECRET_ADMIN` | existing | present |
| `CRON_SECRET` | random, 32+ chars | **MISSING — required** (Vercel sends it to the cron) |
| `GROWTH_UNSUBSCRIBE_SECRET` | random, 32+ chars | **MISSING — required** |
| `GROWTH_TEST_ATLAS_HOST` | Atlas cluster hostname (e.g. `cluster0.xxxxx.mongodb.net`) | recommended (pins the database host) |
| `GROWTH_ALERT_EMAIL` | owner inbox for alerts | optional (used only once real delivery is authorized) |

Cron execution: Vercel runs crons **only on the project's production deployment**. Set the isolated project's Production Branch to `test/growth-unattended-controller` (Project → Settings → Git), or promote the latest branch deployment. Note: the root `vercel.json` also lists the backend's existing crons; in this isolated project they run against the test database only.

## C. Verify after the settings are saved (no code changes needed)
1. Open `/api/growth/health` on the isolated deployment → `"ok": true`, `"database": {"kind":"atlas","name":"fmgrowthtest"}`.
2. In the back office (or with an admin token) call `POST /api/growth/admin/run-now` → summary shows the discover job `ok`, 5 marketing drafts, 25 workstreams.
3. `GET /api/growth/admin/overview` → prospects > 0, drafts awaiting review = 5.
4. Wait for the next quarter-hour → `lastRuns` shows a cron run; repeat calls in the same minute show `duplicate_invocation`.

## D. Turning on REAL outreach (only with owner approval)
All of these must be true or the service refuses to send:
- `GROWTH_DELIVERY_PROVIDER=resend`, `GROWTH_RESEND_API_KEY` (Resend account),
- sender domain verified at the provider (SPF/DKIM) → `GROWTH_SENDER_DOMAIN_VERIFIED=true`,
- `GROWTH_SENDER_ADDRESS=contact@fantasymmadnesscom.com`,
- `GROWTH_UNSUBSCRIBE_BASE_URL=https://<isolated-domain>/api/growth/unsubscribe`,
- `GROWTH_REAL_OUTREACH_APPROVED=true` and `GROWTH_OUTBOUND_ENABLED=true` (owner decision).
Each individual email still requires the owner's approval in the review queue.

## E. Still blocked (need credentials or decisions, not code)
- Atlas run of the acceptance checks from this session: Vercel authorization for team `team_YE6Qw7cYL85CvuigfUXsH1lq` or GitHub secret `GROWTH_TEST_ATLAS_URI` (being handled by ChatGPT).
- Settled test card payment: Authorize.net **sandbox** `AUTHORIZE_NET_API_LOGIN_ID`, `AUTHORIZE_NET_TRANSACTION_KEY`, `AUTHORIZE_NET_SIGNATURE_KEY`.
- Real outreach: section D (business sender verification + owner approval).
- Social auto-posting: no social provider integrated; approved marketing posts are published manually.
- Back-office screens in fmm-ver2: API ready; UI not built (website untouched by request).

## F. Rollback
- Turn off scheduling: remove the `/api/growth/cron/tick` cron or unset `CRON_SECRET` (tick returns 401).
- Stop all delivery instantly: `GROWTH_DELIVERY_PROVIDER=none` (approved emails are held).
- Remove the service: redeploy the previous branch commit (`df2a1aa`) in the isolated project. No production system depends on it.
- Before any merge of this branch into a production branch, remove the `/api/growth/cron/tick` cron entry from `vercel.json` (the route is inert outside the isolated project, but the cron would call it).

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

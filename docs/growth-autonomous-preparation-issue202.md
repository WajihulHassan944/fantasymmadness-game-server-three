# Isolated autonomous preparation — Issue 202

This extends the Issue 198 integration and supersedes its original pre-worker readiness note. It does not activate production, outbound delivery, publishing, payments or automatic approval.

## Boundaries and records

The worker requires the isolated Vercel project, Preview environment, pinned MongoDB host, `fmgrowthtest`, `preview198_` business collections, sandbox capture provider and outbound disabled. The original `growth_social_accounts` and `growth_connections` remain outside the department namespace and use their original encryption keys and ownership. No credential migration or key rotation is part of this change.

The first-party issuer-confirmed administrator binding is pinned. Later successful administrator logins do not expand the owner allowlist. Approval, emergency stop, requeue and resume require that owner. Workers use server-side authority and do not depend on website sessions.

## Durable execution

A release handoff uses a compare-and-set from the previous generation when no global lease is active. The active deployment is pinned. Every cycle uses a random lease fence; an obsolete worker cannot advance replacement execution counters. Existing delayed invocations from the old generation terminate when they observe the new generation. A sleeping old Workflow can briefly remain visible without being an active worker.

The Workflow runs an initial bootstrap, two 65-second verification timers, then 15-minute timers. After 96 iterations it starts the next uniquely hooked segment. Bootstrap is not scheduled-execution proof. Generation counters, last scheduled generation, errors and heartbeat age all contribute to health. A successful build or worker activation is not a healthy timer run.

Marketing, PR and Affiliate Recruitment each have a durable preparation job. Completed 15-minute buckets deduplicate across process recreation. Recoverable failures receive bounded retries; exhausted failures have a one-hour cooldown and an audited owner requeue. Individual unavailable PR sources are held and retried without disabling unrelated work. Dead final-attempt leases become visible failures. Stop and pause are checked before activities and receipt writes.

## Receipts and approval backlog

`growth_preparation_receipts` hold content-version evidence snapshots, never copies of recipient addresses or message text. They explicitly record no send, publication, owner approval, delivery attempt or delivery network use. Read-only source research is distinguished from delivery. These receipts are distinct from sandbox captured-message receipts and real delivery receipts.

The dashboard separately reports scheduled executions, durable job states, current owner-review backlog, prepared receipts, ready/held drafts and source holds. Paying conversions remain unknown while live attribution ingestion is disabled; neither preparation nor sandbox receipts count as paid conversions.

Draft gates require real verified contacts, grounded personalization, a generic greeting unless a personal name is verified, rendered text entities, source provenance, suppression checks, tracked affiliate onboarding and reviewed affiliate terms. Marketing requires fresh published-fight eligibility, matching content fingerprint, valid event metadata, original artwork and verified QR destinations. Missing eligible events in a sport do not authorize invented campaigns. Existing owner-approved content is preserved.

## Connection lifecycle

TikTok and X use encrypted, compare-and-set rotation and distributed refresh locks. Returned rotated tokens are encrypted in quarantine before identity verification; they become active only after matching the original account and required scopes. Failures retain the prior active credentials and create bounded retry metadata. Owner-confirmed reconnection clears stale pending rotation and retries so an old grant cannot replace a newly confirmed one.

Refresh is scheduled before the earlier access/known-refresh expiry. Effective expiry is computed from the encrypted provider response and original access issuance time when available; legacy stored metadata is not blindly trusted. Unknown refresh lifetime remains unknown. Expired refresh grants produce actionable alerts without forcing exchange or revoking still-valid access. The UI displays its actual timezone. Meta Page/Instagram validation is read-only; no generic refresh token or indefinite validity is assumed.

## Safe recovery and rollback

1. Use the owner emergency-stop control if processing must stop. It persists a paused policy and disables the managed scheduler. Verify disabled status and inspect in-flight leases; do not delete records or encryption keys.
2. To resume the currently pinned repaired worker, use **Resume preparation** and type `RESUME PREPARATION`. Policy version checking and a fresh generation prevent reuse of a completed Workflow hook. The UI remains verification-pending until an actual scheduled timer succeeds. Live automation approval remains disabled.
3. To roll back presentation only, assign the verified prior frontend Preview deployment to `fmm-ver2-growth-social-preview.vercel.app`. Do not alter a production alias.
4. To roll back backend code, first stop the worker, then select a prior verified isolated backend Preview and preserve callback host, environment bindings and database records. Do not automatically restart an older worker: its predecessor and generation fence must be reviewed against the persisted scheduler state. Reverting a Git commit alone is not a safe worker rollback.
5. Do not reset namespace, encryption keys, OAuth records, approved drafts or audit history. There is no destructive schema migration. Retain the latest deployment evidence and inspect source/provider holds before closing alerts.

Local real-MongoDB tests exercise stop/resume/version conflicts, stale-generation and stale-lease rejection, retry exhaustion/recovery, duplicate callbacks, account/permission mismatch, failed exchange, encrypted rotation, browser logout, process recreation and non-delivering preparation. A live rollback or emergency stop is deliberately not performed as a test because it would interrupt the working scheduler. Actual staging timer and read-only provider evidence belongs in Issues 202/198 and PRs 114/201; those records distinguish observed execution from long-term uptime.

## Owner acceptance

Open Administration → Growth in a fresh browser, sign in normally, confirm all four connection cards, inspect both real fight campaigns and all four poster images/QR destinations, and review source/affiliate-term holds. Do not approve delivery or publication for this acceptance. Fresh-browser owner acceptance and all-poster visual acceptance remain open until explicitly confirmed.

# Growth Engine — seven-check acceptance evidence (2026-11-01)

Branch `test/growth-unattended-controller`, commit `7f97fa4` (draft PR #102, not merged).
Run: https://github.com/WajihulHassan944/fantasymmadness-game-server-three/actions/runs/41326318148
Result: **54 PASS · 0 FAIL · 6 BLOCKED** (evidence artifact `growth-acceptance-evidence`, 30 days).

Environment: throwaway GitHub Actions machine. MongoDB 7 replica set and Mailpit
sandbox SMTP on loopback; backend under test with loopback-only networking and a
local staging database; read-only Apple Podcasts public search. No repository
secrets, production data, real recipients, payment gateway or deployment.

| # | Check | Result | Blocked item (exact missing access) |
|---|-------|--------|--------------------------------------|
| 1 | Database | PASS on real MongoDB 7 (CRUD, isolation, real restart, lease recovery, no double completion) | Atlas `store_5mRLkf9U8eKGIaaO` / `fmgrowthtest`: the Vercel connection cannot open, log or run deployments of `fantasymmadness-growth-isolated-test` (team `team_YE6Qw7cYL85CvuigfUXsH1lq`). Needs Vercel authorization for that team, or GitHub secret `GROWTH_TEST_ATLAS_URI`. |
| 2 | AI marketing | PASS (real discovery for 5 sports, 25 scheduled workstreams persisted, approval gate, 5 sandbox emails verified via Mailpit, no resend, reporting) | Live social posting: requires owner approval and production launch. |
| 3 | AI public relations | PASS (real outlet discovery, no invented contacts, personalized drafts, approval control, sandbox delivery verified, follow-up stop rules) | Real media contacts/consent and authenticated business sender `contact@fantasymmadnesscom.com`. |
| 4 | Affiliate recruitment | PASS (real creator discovery, qualification, opt-out exclusion, 5/5 sandbox invitations, consent+approval before link; attribution in check 5) | — |
| 5 | Payment attribution | PASS for signup → referral → paid FM COIN entry → affiliate report credit, no cross-affiliate leak, fail-closed cash proof | Settled TEST card payment: Authorize.net **sandbox** `AUTHORIZE_NET_API_LOGIN_ID`, `AUTHORIZE_NET_TRANSACTION_KEY`, `AUTHORIZE_NET_SIGNATURE_KEY` as GitHub secrets. Live keys must never be used. |
| 6 | 24/7 automation | PASS (real timer, SIGKILL + restart resume, duplicate cron invocations skipped, 16 minutes × 25 results persisted, retry/backoff, retry limit, one owner alert not repeated) | Live scheduler: Vercel Cron runs only on the isolated project's production deployment (inaccessible); GitHub schedules run only from `main`. Needs owner approval for a scheduled trigger. |
| 7 | Security & launch readiness | PASS (no live credentials, loopback-only DBs, outbound flags off, 0 outbound attempts, all 17 emails sandbox-captured to reserved domains, npm audit clean, unified suite, rollback rehearsal) | Launch gate NOT ready: `conversionVerified` (needs check 5 card sandbox) and `ownerApproved` are false. |

Defects found and fixed during acceptance:
1. No failure-alert path existed → `growth-failure-alerts.js` (+ tests).
2. Reviewed PR/affiliate drafts could never reach the sandbox (review queue required a dotted domain; sandbox sender accepted only `@localhost`) → sender accepts `*.localhost` loopback subdomains, still rejects lookalikes (+ tests).

Launch decision: **NO GO for real outreach or payments** until the blocked items above are provided and the owner approves. Rollback: no production change was made; the branch is unmerged and the rollback rehearsal passed.

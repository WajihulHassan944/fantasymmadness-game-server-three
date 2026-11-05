# Isolated autonomous Growth worker acceptance evidence

Code commit: `d054d52aee7923bacab5dbee64f23a73cb328294` on PR #114.
No production merge. Frontend PR #201 remains the existing integrated back office.

- Worker Preview: `dpl_9zQXRw3pmnv8HHkAQSCMd137Hark`
  (`https://fantasymmadness-growth-isolated-test-nw6o13obp.vercel.app`).
- Back-office Preview: `dpl_7AZe9ZtwiPoHVQrxnz4LTdBV5rhv`.
- Owner entry: https://fmm-ver2-growth-social-preview.vercel.app/administration/growth
- Managed Workflow: `wrun_41M6P3MDAN0GZGJWKFDKFX67PC`.
- Actual bootstrap completed 2026-11-05T15:01:04.152Z (not counted as scheduled).
- Actual durable timer steps completed 15:02:10.612Z and 15:03:17.499Z UTC.
- Health evidence at 15:03:19.181Z: scheduledExecutions=2, healthy=true,
  ownerAllowlistConfigured=true, approvalMode=owner_required, lastError=null,
  database=fmgrowthtest, collectionPrefix=preview198_, outboundEnabled=false,
  publishingEnabled=false. Next regular timer: 15:18:17 UTC.
- No website administrator login/session was used to execute or verify timers.

CI run https://github.com/WajihulHassan944/fantasymmadness-game-server-three/actions/runs/42050551525
passed the real MongoDB OAuth/SSO cases, Connections browser check, integrated
back-office/affiliate QR/poster/sandbox receipt regressions (58 grouped tests),
three additional managed scheduler safety tests, deployed back-office smoke and
two real durable timer executions. Root backend and worker production dependency
audits each report zero vulnerabilities. Worker transitive advisory overrides
are pinned in its separate lockfile; the existing root dependency set is unchanged.
The local legacy suite passed (169 legacy routes preserved), as did contest and
original-image poster regressions. PR quality/security checks also passed.

The deployed back-office smoke independently verified the existing Facebook and
Instagram identities with credentialsChanged=false. TikTok/X remain configured,
callback routes are unchanged, and X reports no configuration blockers. No new
provider consent, token replacement or provider publishing was performed.

Production aliases were read-only checked: website remains
`dpl_DMr4WzuVzfcq8xjgRTcbBQ54QJgQ`, production Growth remains
`dpl_ALUdU4vPfa3zXQtcfqR1UGsegpUt`. Global isolated project root/framework/build
settings remain unchanged. Only separate Preview deployments were requested.

This establishes real scheduled operation, not a claim of 24 hours of historical
uptime. See the main Preview runbook for stop, generation, monitoring and rollback.
The owner still accepts the final UI using their normal secure website sign-in.
Live publishing, external messages, payments and automatic campaign approval remain
outside this activation.

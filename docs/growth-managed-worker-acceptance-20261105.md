# Isolated autonomous Growth worker acceptance evidence

Worker code: `d054d52aee7923bacab5dbee64f23a73cb328294`; final back-office monitoring/UI code: `671c6b655d76259a80ee0f14d30abc6746bf3faf`, on PR #114.
No production merge. Frontend PR #201 remains the existing integrated back office.

- Worker Preview: `dpl_9zQXRw3pmnv8HHkAQSCMd137Hark`
  (`https://fantasymmadness-growth-isolated-test-nw6o13obp.vercel.app`).
- Back-office Preview: `dpl_9GaD8S9C4A21yRUhgDnfzRdWz6Um`.
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

## Full regular-period and final deployed verification

The same managed Workflow completed its regular 15-minute timer step at
**2026-11-05T15:18:22.595Z** (step `step_01M6P3MDANEKRYAFDAB0CFZW9P`).
The previous step completed at 15:03:17.499Z. During the full-period observation,
only read-only Workflow metadata was polled; no worker-health request or website
session triggered execution. Bootstrap plus three scheduled cycles completed.

Final deployed/security/browser/MongoDB run:
https://github.com/WajihulHassan944/fantasymmadness-game-server-three/actions/runs/42053723534
passed on final code `671c6b655d76259a80ee0f14d30abc6746bf3faf`. At
15:20:29.015Z it confirmed scheduledExecutions=3, healthy=true, lastError=null,
verified administrator allowlist configured, next wake-up 15:33:22.413Z,
`fmgrowthtest` / `preview198_`, approvalMode=owner_required, publishing=false,
outbound=false and websiteSessionUsed=false. All 61 grouped tests passed; both
production dependency audits are clean. Expanded tests include expired-process
lease recovery, simultaneous timer exclusion, error/stale monitoring, the active
Automation UI and the authenticated owner's stop disabling the generation.

Facebook and Instagram were independently verified again at 15:20:18.774Z with
credentialsChanged=false. TikTok/X configuration and callbacks remain intact.
No new provider OAuth consent was performed. Production aliases remain unchanged.
There are no observed unresolved infrastructure or credential blockers for this
staging activation. Owner UI acceptance is still required before closing Issue
#198; no production merge or live outbound action is authorized.

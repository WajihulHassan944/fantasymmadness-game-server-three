# Growth Engine — affiliate retry and owner-review launch preparation

The exact November 5 dashboard remains locked and unchanged. The staging retry repair and captured-only delivery milestone passed. **No live campaign is authorized or launched.** Production preparation, website, payments and four original connections are preserved.

## Deployed source and verification

- Application commit: `8e0930405c3e5519e00b8af07d866bdc111479ab` in existing backend PR #114 and isolated worker branch.
- CI verification-only pin: `a10e3834e912fd6ee6cb078760ac8c13b1def34d`; no unnecessary application redeployment for this script change.
- Isolated worker: `dpl_6Cgkqx3w1KVUtUyK8UUJ4gb9tmRS`, https://fantasymmadness-growth-isolated-test-qyz7f9cck.vercel.app ; release `affiliate-discovery-isolated-v5`.
- Isolated back office: `dpl_9g9R3d6NkDDpQ6Cb9Txvwu6krTfV`, https://fantasymmadness-growth-isolated-test-h669q3crl.vercel.app ; existing callback alias preserved.
- Frontend stays on `3bd65b1b0aca341c491e137c818f0bf32b1e0515` / `dpl_2fSE4HREbWeHhfsmE1uPMo8Yk3Eh`. No frontend source change or redeployment in this milestone.
- [Owner dashboard](https://fmm-ver2-growth-social-preview.vercel.app/administration/growth?engine=marketing). Original component/CSS/embed helper still match `6c21ced`; all three console assets still match `9b181672` byte for byte. `growth-dashboard-lock.test.js` enforces the console lock.
- All work uses `fmgrowthtest` / `preview198_`; delivery QA has its own `preview198_launch_qa_` collections. Production remains `fmgrowthproduction` / `production_preparation_` on the existing shared Atlas cluster. No production records or aliases were migrated.

## Retry repair and actual unattended execution

A failed public discovery classification previously returned a top-level error, failed the whole affiliate preparation job and held its receipts even if unrelated research succeeded. Its cursor could remain stuck on the unavailable sport/role. The repair stores per-classification failure counts, sanitized errors and earliest retry times; exponential backoff is 15/30/60/120/240 minutes, capped at six hours. Due retries alternate with new classifications so neither queue starves the other. Individual publisher/source errors stay visible as source holds. Existing recipient, terms, artwork and approval gates still apply.

Actual source/DB/preparation failures retain bounded job retries, terminal failures and cooldowns. Only a successful retry of the same discovery classification acknowledges that source alert. Marketing and PR do not inherit an affiliate discovery warning. No exception payload, token or authorization code is logged.

The original queued retry recovered on its real scheduled cycle at **November 6, 8:31:59 AM EST**, before the new release. The tested repair prevents the same failure from poisoning later preparation. The old staging Workflow `wrun_41M6PH56QS0GJA6SEV1J8DQD3N` subsequently exited naturally at the database generation fence. It was not force-stopped.

New Workflow `wrun_41M6RJFMJ70GHK0HBBK3WY34B4` completed bootstrap at **8:59:12 AM EST**, and actual timer steps at **9:00:23** and **9:01:30 AM EST**, with zero errors. At 9:00, Marketing, PR and Affiliate jobs all completed; the twelve unresolved affiliate campaign receipts stayed held. The initial 65-second rollout warm-up is the existing worker behavior; its continuing schedule remains every 15 minutes. Next recorded wake was 9:16:30 AM EST. No browser session was used.

Production preparation kept its original deployment `dpl_7pM53Xz63j2p24ue6DG6jUQrnYHC`, commit `57afb435`, generation `production-preparation-5a99b6f4-d62f-4274-bc12-ad6411896065`. It advanced from **56/55** completed/scheduled cycles before this work to **58/57** at **9:03:59 AM EST**, healthy=true, lastError=null, zero observed real sends/posts. Four connections remained freshly verified.

## Specific campaigns prepared for owner review

These are existing **staging** drafts, still `needs_owner_review`, not automatically approved. Complete bodies, recipients and original artwork remain in the owner console. Private recipient addresses are omitted here. Current primary research is within the existing 14-day policy; its dates and feed URLs are in the evidence. No assertion of new recipient consent is made.

| Department | Draft ID | Campaign / recipient publication | First live-channel eligibility |
|---|---|---|---|
| Marketing | `mkt-6ad629a60df141df46931a8b-49d793654a` | BOXING: ELIF NUR TURHAN vs ALYCIA BAUMGARDNER — Sunday, November 8 · event start time unconfirmed | Facebook candidate; X copy passes QA but write scope missing |
| Marketing | `mkt-6adfcba7ee2996e566885594-e498620c94` | MMA/UFC: CIRYL GANE vs JOSH HOKIT — Saturday, November 14 · event start time unconfirmed | Facebook candidate; X copy passes QA but write scope missing |
| PR | `pr-p-f956478203419e11` | Boxing with Mannix and Mora: a round-by-round angle on ELIF NUR TURHAN vs ALYCIA BAUMGARDNER | Email candidate after recipient/final-copy and sender approval |
| PR | `pr-p-a593138355c14ed9` | 6th Round RETRO Podcast: a round-by-round angle on CIRYL GANE vs JOSH HOKIT | Email candidate after recipient/final-copy and sender approval |
| PR | `pr-p-4c35a814b6618fce` | Budocast: MMA, UFC & Martial Arts News Podcast: a round-by-round angle on CIRYL GANE vs JOSH HOKIT | Email candidate after recipient/final-copy and sender approval |
| PR | `pr-p-874920d814aee9a0` | Going In Raw: A Pro Wrestling Podcast: a story idea for pro wrestling fans | Email candidate after recipient/final-copy and sender approval |
| PR | `pr-p-cafd139ff66ea487` | The Last Round Boxing Podcast: a round-by-round angle on ELIF NUR TURHAN vs ALYCIA BAUMGARDNER | Email candidate after recipient/final-copy and sender approval |

Marketing is based on the published Fight Registry records: **ELIF NUR TURHAN vs ALYCIA BAUMGARDNER, November 8, 2026 (MVP)**, and **CIRYL GANE vs JOSH HOKIT, November 14, 2026 (UFC 334)**. Event start times are unconfirmed; registry entry cutoffs are separate and are not presented as event start times. Four actual portrait/story poster images decoded to the exact tracked fight destinations; no affiliate identity is implied by these ordinary fight posters.

PR source publications: Boxing with Mannix and Mora; 6th Round RETRO Podcast; Budocast; Going In Raw; The Last Round Boxing Podcast. Their verified public-feed contact provenance and subject/body drafts are available for owner review. Budocast has specific Ciryl Gane episode evidence; no audience numbers, endorsements or financial terms are invented.

**Production Marketing remains held for production-applicable original artwork/QR proof.** Successful staging QA does not clear that production hold or authorize moving test receipts/campaigns into production. Existing production PR preparation is also not an approved send.

## Captured staging delivery and replay tests

Workflow `wrun_41M6RJ8P110GHSAM6NRNHFDN5D` at **8:55:24 AM EST** captured five PR messages to `growth-qa@fixture.invalid` and four Facebook/X social simulations. No real recipient address was used as a delivery destination. Copies are explicitly synthetic; original campaign approval flags remain unchanged. Captured messages include unsubscribe headers and a labelled non-functional QA-only unsubscribe URL, not a real subscription action.

Replay Workflow `wrun_41M6RJD5QM0GHF6C39P6NN298T` at **8:57:51 AM EST** reused all nine existing captures: five email records and four social records remained, with zero new captures. Instagram/TikTok attempts stayed HOLD for unverified profile destinations. Actual platform outbound APIs were not called. Sandbox preflight can use read-only image checks; it does not establish real delivery, actual account posting permission or conversion.

Local tests exercise owner approval refusal, wrong database/provider refusal, opt-outs/replies, idempotency, safe refresh rotation, concurrent lease behavior, emergency stop and department-independent holds. Every original draft remained unapproved; no campaign was dispatched.

## Connected accounts and actual publishing permission

| Provider | Existing verified account | Current permission / hold |
|---|---|---|
| Facebook | Fantasy MMAdness Page | Connected; verified `pages_manage_posts`. Still no owner authorization to publish. |
| Instagram | `@fantasymmadness` | Connected; `instagram_content_publish` verified. These campaigns require a verified supported profile destination before this channel is eligible. |
| X | `@FMmadness2024` | Connected with `tweet.read`, `users.read`, `offline.access`; **`tweet.write` is not granted**. A sandbox PASS does not authorize X publishing. |
| TikTok | Provider-verified FANTASY MMADNESS profile | Connected with `user.info.basic` only. Owner-intended account is `@fantasy.mmadness`; this grant does not return a username. Posting requires supported video permissions/assets and separate provider/owner authorization. |

No connection was disconnected, revoked, regenerated or overwritten. No wider scopes were requested. Existing encryption keys, original account ownership and callback URLs remain in place. X refresh expiry remains unknown rather than assumed unlimited.

## Tests, holds and exact final authorization

- [Full isolated CI 42230115167](https://github.com/WajihulHassan944/fantasymmadness-game-server-three/actions/runs/42230115167): **192 passed, zero failed, zero skipped**, including deployed Preview and worker timer smoke checks, actual posters/QRs and dependency audits.
- [Quality/security 42230115152](https://github.com/WajihulHassan944/fantasymmadness-game-server-three/actions/runs/42230115152): passed. Application commit 8e09304 also passed full CI 42228799430 and security 42228799538 before handoff.
- Focused local checks: 13 retry/review/capture/appearance tests and 21 scheduler/connection/receipt/approval-safety regressions passed; worker production bundle built successfully.
- Twelve affiliate campaign receipts stay held for unresolved source/terms gates. Previously excluded media-derived prospects and withdrawn posters remain excluded; Liam attribution and commercial promoter agreement holds remain. None blocks the seven independently eligible staging review drafts.

Before any live action, the owner must approve each exact final copy/poster/QR, named recipient or connected account, channel and schedule in the existing approval workflow. A separate explicit authorization must cover the production-safe release and the specific posting/sending actions. Production creative gates and verified email sender/provider readiness must pass first; a captured message does not verify live SPF/DKIM, sender-domain ownership or production email transport. X/TikTok require additional provider-supported scope consent only if those channels are selected. Until then, all publishing, emails, DMs/outreach, automatic approvals and payment mutations remain disabled.

## Rollback and deployment checks

Rollback affects staging only. Keep the original data/credentials. Use the existing staging emergency stop if needed; deploy the previous known-good worker code to a fresh isolated Preview with an explicit new rollback generation and `GROWTH_WORKER_PREVIOUS_RELEASE=affiliate-discovery-isolated-v5`, then hand off with the existing lease/generation CAS and verify timers. Do not reuse completed generation/ordinal IDs or merely point an old worker URL at a new binding. Do not stop or redeploy production preparation for a staging rollback.

An unused SHA-ref back-office candidate `dpl_2wPVPaMvvticAiPeoAhhe1GVDFeY` lacked the required branch-scoped Preview settings. It was identified before any owner/staging alias was routed to it and deleted. The active replacement uses the explicit isolated branch. Project build settings and production routing remained unchanged.

[Sanitized complete evidence](evidence/issue203-launch/milestone.json) includes campaign IDs/source URLs, decoded poster destinations, scope evidence, actual Workflow executions, captured/replay receipts and production before/after health. No tokens, codes, passwords, private keys or private recipient addresses are published.

# Production repair checkpoint — November 8, 2026 Eastern

Status: repair implemented and locally verified; **not deployed and not fully live**. No production data, campaign decisions, provider credentials, protection settings, payments, Registry records, website navigation or existing affiliate records were changed during this session.

## Repair

The shared Marketing / PR / Affiliate / Campaign Approvals card now places controls immediately below its title, before long posters and captions. Held fights display an eligibility hold instead of a contradictory green verified badge. Approval withdrawal remains enabled. Repeated approval of the same already approved content version returns the existing decision without appending duplicate history. Exact delivery authorization remains separate when destinations or schedules have not been approved.

All campaign views receive actual matching distribution entries, receipts and failures, retaining per-channel outcomes rather than incorrectly changing an entire campaign to published after one channel. Only queue entries matching the current content version count as authorized. API requests time out with an actionable error instead of leaving loading pending indefinitely. The original site shell and navigation are unchanged.

The mail client now targets the existing immutable private backend Preview `fantasymmadness-game-server-three-khx99a42p.vercel.app/api/mail`, verified READY as `dpl_DAQ2vSy5vpmspNupxhDhVdWNFYi5`. The old client contacted the protected backend Production alias before rewriting to Preview. The authorized Trusted Sources pair is Growth Production → backend Preview; the initial Production alias could therefore be rejected before that rule applied. This is a code-level diagnosis; actual signed production access and SMTP delivery remain unverified until release. No extra grant, secret transfer, password regeneration or protection bypass was introduced.

Meta receipts now retain provider response IDs and verified destination identity, and perform a read-only lookup for the provider's actual public permalink and publication time. Failure to read back a successful mutation never causes a duplicate publish. Permission verification errors preserve the provider's actual reason, including rate limiting, instead of falsely reporting a missing scope.

## Evidence and remaining gates

See `docs/evidence/growth-final-activation-checkpoint-20261108.json` for the recorded live health response subset.

- Preparation: healthy, last observed unattended timer completion November 8 at 6:47:50 PM Eastern, no website session, zero errors / automatic approvals / payment mutations.
- Distribution: native cron completed at 6:45:28 PM Eastern, `dpl_34Q9jeuS2wbsb9qB9HP4CQR59axD`, served application `7f2748960bc368cab06545d388e698952fd94a11`; unpaused, empty queue, zero accepted/published messages.
- Email: `mail_service_access_401`; controlled application test record absent. No test was sent this session. Earlier Gmail connector delivery documented in the existing issue is distinct from this pending application test and must not be represented as new SMTP acceptance.
- Meta: expected account identities present; fresh permissions check reports `provider_rate_limited`. Stored grants include publishing scopes but are insufficient to claim fresh readiness. No posts or provider receipts were created.
- X: existing @FMmadness2024 grant lacks `tweet.write`. TikTok: existing account grant contains only `user.info.basic`, lacking `video.publish`. Legitimate provider approval/consent remains required.
- Browser: real production navigation redirects to `/administration/login`; this environment has no authenticated administrator session. Historical server acceptance is not current browser verification.
- Vercel: connected account lists Growth project `prj_Hpe9UjGrBBJOm3boxHsL9lHesWLl`, but inspecting it by name and ID returns 404; listing its deployments returns 403. Known Growth deployment inspection also returns 404. Same-team backend inspection and routing reads succeed. CLI fallback has no saved authentication. Restore access to the existing Growth project; no new project or service is needed.

The exact requested general brand campaign is preserved in `growth-general-brand-campaign-pending-20261108.json`. It remains a preparation manifest, not a production campaign record or an approval. Exact content/destination approval was requested; no answer was received at this checkpoint. An existing approved brand artwork identity must still be verified before ingestion or publication. Held fights and affiliate invitations remain ineligible.

## Validation and release

24 targeted real-Mongo, browser, protected-HTTP, provider, review, queue, routing and SMTP tests passed, with zero failures/skips. Existing backend `npm test` passed. Dedicated worker build passed. The new browser regression is included in existing Growth CI. Provider IDs in test fixtures are synthetic and are not production activity.

When access is restored, inspect the latest Growth production deployment and routing before releasing. Test an isolated Preview with production delivery disabled; then use the existing production project, preserve its settings, and change only the exact Growth route target. Keep the existing preparation generation on `dpl_4BZK9Zo9XV2Be4dwXCAEHNYziBxH` running; this repair does not require a new preparation generation. Verify READY, authenticated owner controls, signed private Preview access, and existing controlled test deduplication before one authorized application test. SMTP acceptance and recipient delivery require separate evidence. Publish only the specifically approved brand campaign after approved-art verification and fresh account/scope checks.

Rollback checkpoint from the live response: Growth serving `dpl_34Q9jeuS2wbsb9qB9HP4CQR59axD` / `7f2748960bc368cab06545d388e698952fd94a11`; prior recorded Growth routing version `a56d303d-3c41-4266-bdad-f09f0f87ecca`. Re-read and export the current production route version before any mutation; the prior recorded version was not reverified because Growth access is blocked. Restore that freshly verified target/version if necessary. Never roll back/restart the independently healthy preparation generation blindly. Queue decisions, claims and receipts remain persistent.

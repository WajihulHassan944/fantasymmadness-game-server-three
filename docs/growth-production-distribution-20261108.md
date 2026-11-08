# Growth production distribution repair — issue #121 / frontend #198

This repair keeps the existing 15-minute preparation worker and adds a separate production distribution queue. It does not mount the game backend, change Registry records, generate replacement affiliate identities, alter payment handlers, or auto-approve campaigns.

## Implemented

- Exact owner approval binds the complete delivery preview (including production unsubscribe), draft content version, recipient or provider destination, artwork and future schedule.
- Facebook and Instagram use the original selected encrypted Page connection. Each attempt verifies provider identity, Page/Instagram linkage and actual permission grants. Credentials are never copied or replaced.
- Gmail REST adapter uses app-owned OAuth for the existing `contact@fantasymmadnesscom.com` mailbox. It requires `gmail.send` and `gmail.metadata`, verifies `/users/me/profile`, and fails closed for a different sender. ChatGPT connector credentials cannot be exported into the application.
- Independent Vercel Cron every 15 minutes dispatches only authorized queue entries. Preparation remains independently scheduled. Unique content/destination keys prevent duplicate dispatch across campaigns and concurrent processes. Explicit 429 rejections receive at most three attempts with backoff; unknown POST outcomes and interrupted sends require inspection and never retry automatically.
- Owner pause/resume is persistent and provider-verified. Preparation emergency stop also blocks distribution. Each provider mutation rechecks the stop and approval. In-flight provider requests may finish after stop.
- Initial resume is permitted only by a protected Cron call pinned to an exact owner-authorized release, with verified Meta readiness and no existing pause decision/emergency stop. It never creates campaign approvals or queue entries.
- Gmail message IDs are **acceptance**, not delivery confirmation. Meta post IDs are publication evidence. Queue receipts, attempt outcomes, approvals, cancellations, pauses and resumes are audited.
- A separate production unsubscribe path writes only production Growth suppressions; existing unsubscribe/tracking/callback/poster services remain on their original routes.

## Actual controlled mailbox test

One owner-authorized test was sent through the authorized ChatGPT Gmail connector (not the deployed application adapter) from `CONTACT@fantasymmadnesscom.com` to `facester1@gmail.com` on November 8, 2026 at 8:34 AM Eastern. Gmail send ID `1a1bb5da8a7f8025`; recipient inbox ID `1a1bb5db10ce276b`; recipient headers confirm Delivered-To, SPF pass and DKIM pass for the business domain. Exact evidence: `docs/evidence/growth-controlled-email-20261108.json`. This consumes the single test authorization. Do not resend the test without a new explicit authorization.

## External authorization still required

- **Production Gmail adapter:** securely configure `GROWTH_GMAIL_CLIENT_ID`, `GROWTH_GMAIL_CLIENT_SECRET`, and `GROWTH_GMAIL_REFRESH_TOKEN` on the dedicated Growth project, production only, as sensitive variables. Use an owner-controlled Google OAuth client and have the existing mailbox grant `https://www.googleapis.com/auth/gmail.send` plus `https://www.googleapis.com/auth/gmail.metadata` with offline access. Do not paste these values into GitHub issues or chat. Gmail API must be enabled for that client. The app verifies the authenticated mailbox before it can send. Connector success is not production credential provisioning.
- **X:** existing @FMmadness2024 grant contains `tweet.read users.read offline.access`, without `tweet.write`. Owner must enable Read and Write permission for the existing X application and complete a new provider consent request explicitly containing `tweet.write`. A token refresh alone cannot add permission. Existing OAuth service currently requests read scopes; its publishing-consent request remains a separate integration gate, not a claimed success in this release.
- **TikTok:** existing FANTASY MMADNESS grant contains only `user.info.basic`. Owner must obtain Content Posting API / Direct Post access with `video.publish` for the existing app, then complete explicit account consent. Product review, account eligibility, verified source domain, supported assets and any public-post audit must pass. No scope is inferred or bypassed. This release does not enable X/TikTok dispatch.
- **Marketing:** Turhan–Baumgardner and Gane–Hokit both fail `registry_public_entry_state_conflict` in the live read-only feed. They remain held; exact fight entry deadlines continue to apply. No campaign approval is inferred from this implementation assignment.
- **Affiliate:** nine production invitations remain held for current recipient suitability, contact provenance, owner terms and verified attribution. The gateway blocks affiliate sends pending those checks. No bulk invitation is authorized or sent.

## Rollback and verification

Original API/worker: `dpl_GWTN1uS21eCjwS25k6UqPfg46KAq`, commit `dc803fea3fbbe3b0ef2b37ca8b9c3138f2d55b9b`; routing version `52e97a14-7d2f-4125-8093-fb30250fd5fe`. Original immutable API origin is `https://fantasymmadness-growth-isolated-test-kjnxthj0u.vercel.app`. Preserve the second fallback rule to `https://fantasymmadness-growth-isolated-test-hqzhea8w0.vercel.app` exactly. Restoring routing does not migrate or delete records. Disable distribution and inspect worker ownership before any scheduler rollback; do not blindly restart an old generation. Queue state/receipts remain for inspection.

Local verification uses a real loopback MongoDB and Chromium. Coverage includes provider identity/scope mismatch, missing consent/credentials, header injection, exact preview binding, concurrent sends, persistent approvals across restart, duplicate protection, holds, changed recipients, emergency stop, bounded retries, unknown outcomes, existing SSO/owner browser flows, production database guards, rollback fencing and payment/Registry route isolation. Mocked provider IDs are tests, not production receipts.

Production deployment IDs and acceptance evidence are appended after release; this document alone does not establish that any campaign channel is fully live.

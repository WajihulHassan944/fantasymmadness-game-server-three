# Issue #198: integrated isolated back office

This combines the existing Growth console/department APIs (coordinated with PR #102 and the existing Issue #198 implementation) with PR #114's secure TikTok/X authorization. It does not merge or deploy the isolated service into the production game server.

Owner entry: `https://fmm-ver2-growth-social-preview.vercel.app/administration/growth?engine=connections`. Marketing, PR, Affiliate Recruitment, approvals, posters, receipts, analytics and attribution remain sections of the same embedded console. The original Fight Launch Desk and **Prepare affiliate alerts** action remain available. Fight context is retained across Growth navigation. There is one verified website-admin session; raw website credentials never reach the engine. OAuth setup opens the same console in a top-level secure window when needed for first-party cookies, not a second back office.

## Data and credential boundaries

- The existing `growth_social_accounts`, pending OAuth, candidate, revocation and SSO collections are reused without migrations, credential regeneration, or reconnecting accounts. No key or token was exported. Existing confirmation, identity pins and encrypted refresh handling are preserved.
- Every department runtime collection is wrapped with prefix **`preview198_`** in `fmgrowthtest`, including drafts, approvals, reports, settings, receipts, attribution and posters. No fallback to unprefixed business records is permitted. Tests assert the original OAuth credential documents remain byte-identical and unprefixed campaign records remain unchanged.
- Runtime construction is allowed only on the dedicated isolated Vercel project and Preview environment. The existing early bootstrap exits before loading the game server. Production website, payment routes, database and deployments are unchanged.
- Initial authenticated department use prepares drafts from the real read-only Fight Registry feed if staging has no marketing drafts. Failed discovery is recorded; fight facts are never fabricated. No approval, external message or real publication happens during initialization.

## Delivery and reporting

Preview requires `GROWTH_BACKOFFICE_INTEGRATED=true`, `GROWTH_DELIVERY_PROVIDER=sandbox-capture`, `GROWTH_SOCIAL_PROVIDER=sandbox`, `GROWTH_OUTBOUND_ENABLED=false`. Real outreach/publishing and live automation approval flags remain false. Cron, live social test, manual live-publication marking and event ingestion are blocked at the Preview boundary. Owner approvals still gate draft scheduling/delivery. PR/affiliate receipts are captured messages with `sent:false`, `network:false`; marketing sandbox receipts do not contact a social provider. Each department links its receipts to reporting. Sandbox email rows explicitly say **not sent**.

The read-only fight source is pinned to the existing authority. The two existing approved Preview Cloudinary clouds are preserved; cloud `dq2fwh1ui` was added only after reading the current public Registry feed and confirming it is the exact referenced account (20 public records at inspection). This uses the owner's prior explicit approval for that cloud. No other image account is authorized. The original, unstretched photograph and personalized QR safeguards are retained.

Affiliate campaigns require explicit active account mappings and an approved personalized poster. Unknown/missing/remapped identities are held; there is no owner fallback. Regression tests decode the actual QR image for same-name affiliates and check the destination against each account's link/referral ID. Synthetic attribution is kept separate from settled-entry reporting; no payment operation is exposed by this Preview.

## Verification and limits

Local verification uses disposable loopback MongoDB and explicit fixture data only. The composed suite exercises real Express/MongoDB APIs and Chromium across ten console sections, website SSO/logout, approvals, sandbox receipts, original OAuth record preservation and namespace isolation. Separate frontend Chromium checks exercise normal Administration → Growth login, rejected/unauthorized sessions, department/Connections navigation and selected-fight context. Existing affiliate/poster, attribution, OAuth failure/replay, registry refresh, signup/payment-adjacent and legacy route regressions also run. Fixture provider authorization is not claimed as real provider consent.

The read-only deployed smoke checks inspect the real namespace/isolation flags, connected pinned DB, callback routes, API authorization gates, publishing-disabled flags and website-login CORS. The frontend retains Vercel Deployment Protection; authenticated Vercel checks verify its real page/configuration. Owner acceptance must use the normal administrator account to verify personal connection status and real staging drafts. No password or session token is requested in chat.

## Monitoring and unresolved infrastructure

Existing owner-only status, audit, alerts, runs, jobs, receipts and reporting APIs are active. Integrated request failures produce a bounded event/path/error type without credentials or raw provider bodies. There is no persistent worker or automatic cron enabled by this integration. The Automation page reports actual run history; it must not be interpreted as proof of unattended execution. A persistent runner, its schedule/monitoring and explicitly configured automation owners remain release requirements if unattended processing is desired. Live email DNS/provider approval, settled-payment event integration and production rollout are separate gates; nothing here enables them.

## Rollback

Before this rollout the backend stable OAuth Preview alias pointed to `dpl_4v8KAnzUF7Ykd8oC1YwtrFQQidR6` (application commit `c31a1ac60462289ed3df8d4ba3f3daa0b1170edd`) and the frontend dedicated Preview alias to `dpl_DUPcV3iQ2BSHHYdt4JuQWg1igF3D` (commit `bfe5bf1f9d2fc9a91937f5fded8bd82c85944b27`). Both were inspected before rollout. Restore only those dedicated Preview aliases to roll back. Their immutable environment snapshots restore the prior OAuth-only UI without modifying credentials or production aliases. Alternatively disable the integration flag and redeploy the tested prior Preview source; do not redeploy the new full UI against legacy auth.

No destructive migrations are required. Leave the `preview198_` collections and all OAuth records intact during rollback. Production aliases are never part of this procedure. A real rollback was not executed merely to test it, because that would interrupt working owner OAuth sessions; readiness consists of verified prior READY deployments, alias scope and zero migration dependency.

## Existing Facebook/Instagram recognition repair

The initial namespace isolation hid the already-authorized Meta connection from the new UI. History includes `737e66a` (Meta sign-in) and `b18ff23` (Login for Business config); the prior safe owner API snapshot recorded the existing selected Facebook Page and linked Instagram account as connected. App configuration was stored encrypted in `growth_connections`, not necessarily in `GROWTH_META_APP_ID` environment variables. Missing app environment variables are therefore not proof that setup was never completed.

The integrated Preview now uses `growth-existing-meta-readonly.js` to read the original isolated owner record without moving it into the department namespace. It reuses `GROWTH_TOKEN_ENCRYPTION_KEY` only on the server. It opens only the existing selected Page token, never exchanges/renews a token, and verifies Facebook via the token's `/me` Page identity. Instagram is checked independently against its stored account ID and current Page relationship. A partial failure remains separate from the other platform's successful verification. Known legacy environment bindings are supported without creating another Meta application. A missing/different original encryption key is reported as a recovery blocker, not a request to replace the app.

Only bounded GET requests to the fixed Meta Graph origin are made; tokens travel in Authorization headers, never URLs or API output. Public health exposes only sanitized status/reason booleans, without account IDs or names. Five-minute sanitized health caching uses `preview198_meta_connection_health`; no credential ciphertext is copied there. Owner-only Connections shows the verified account identities and a read-only recheck button. Meta app creation, reconnect, selection, disconnect and callback mutation are blocked in this Preview; publishing credentials are never released to the publishing subsystem. Original Meta and TikTok/X credential documents remain unchanged. Tests compare their original records byte-for-byte and reject mismatched provider identities.

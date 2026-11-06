# Issue #203 — exact November 5 dashboard restoration

The previous integrated presentation is restored in **isolated Preview**. Owner fresh-browser visual acceptance is still pending. Production dashboard routing/assets were not changed. Production campaign activation remains HOLD; publishing and external delivery remain disabled.

## Identified version and cause

The verified November 5 acceptance record identifies frontend `6c21ced7961c3b5ae1f3f642d0d9b01c791e01d6`, deployment `dpl_5dcxvo2peJEjcSe8oGZS2vh9LXnj`, and backend `9b181672c18202c2f8af95536c29a7a9f3f37c87`, deployment `dpl_5WyotJUWM9siSVLCViRMZYkcnzkm`. The prior integrated screenshot shows the FANTASY MMADNESS administration shell, its original department tabs and the light embedded console.

The production preparation release `57afb435` introduced a reduced diagnostic-style console instead of that departmental interface. The initial Issue #203 repair then introduced a dark replacement theme and different frame/navigation behavior. The owner rejected that replacement. It has now been removed from staging. This report does not describe the rejected theme as accepted or restored.

Restoration copies only the original presentation: the frontend component, CSS and embed helper from `6c21ced`, and all three existing departmental console assets from `9b181672`. All six are **byte-identical** to those historical versions; [SHA-256 evidence](evidence/issue203/nov5-presentation-parity.json) records each file. The original frame sizing and embedded-navigation behavior are retained, including the original inner viewport. No new palette, cards, navigation layout or replacement console is introduced.

Current OAuth, administrator allowlists/session verification, production preparation, signup persistence, QR attribution, campaign drafts, source gates and encrypted records are retained. No database rollback or campaign deletion occurred. The additional read-only production receipt/status reader remains in source; no production release of it occurred.

## Exact staged releases

| Component | Commit | Deployment |
|---|---|---|
| Frontend restoration, PR #201 | `3bd65b1b0aca341c491e137c818f0bf32b1e0515` | `dpl_2fSE4HREbWeHhfsmE1uPMo8Yk3Eh` |
| Backend presentation restoration, PR #114 | `c543c6b087fefd3bdbf6a62ae959f15e3342e629` | `dpl_6NabGrz4Mizq2TeUQyes1fLHoynV` |

Owner Preview: https://fmm-ver2-growth-social-preview.vercel.app/administration/growth?engine=marketing

Immutable frontend: https://fmm-ver2-7cfkbw1jy-kelly-davis-projects-6c108d0b.vercel.app

Immutable backend: https://fantasymmadness-growth-isolated-test-jmv5j1zhd.vercel.app

Both targets are Preview. The existing staging OAuth alias is unchanged in spelling and points to the restored backend. The exact callback URLs, encryption keys, account ownership and credentials were not changed. The frontend session configuration endpoint returned HTTP 200, Preview, existing staging key ID `6fed666f6d72a111`, expected backend alias and approved frontend site origin. A public page response or READY state is not authenticated owner acceptance.

## Visual comparisons and functional checks

- [Historical integrated reference](evidence/issue203/historical-integrated-reference.png): existing screenshot, retained without claiming its capture date is November 5. The November 5 deployment and source identities above are independently recorded.
- [Rejected replacement fixture](evidence/issue203/rejected-replacement-fixture.png): before-restoration comparison only.
- [Exact restored desktop](evidence/issue203/exact-nov5-restored-desktop.png) and [exact restored mobile](evidence/issue203/exact-nov5-restored-mobile.png): real Chromium rendering of the actual Next administration shell and historical console assets with explicitly local API fixtures. These are not screenshots of the owner's private session or live campaign counts.
- All requested sections load: Marketing, PR, Affiliate Recruitment, Connections, Automation and Analytics/Reports. Existing approvals, posters, social publishing and attribution sections remain available under their original navigation labels.
- Eleven frontend browser tests passed, including normal administrator handoff, unauthorized/rejected sessions, department navigation, stop/resume confirmation/version gates, fight-context preservation, mobile signup attribution and screenshots of the restored presentation.
- Eight current backend dashboard/production-adapter tests passed. Actual UI buttons were exercised for editing a new local QA draft, cancelling approval, explicitly approving it, rejecting another QA draft, and loading department/connection/reporting controls. HTTP tests exercise 401/403 boundaries and preserve original fixture records. No dispatch follows the added UI approvals.
- The first screenshot-CI run found an asynchronous two-spinner locator race. It was corrected to wait for all department panels. The subsequent isolated CI run passed. The final source restoration is tested independently.

The broader current isolated set ran 69 checks: 68 initially passed, one evidence-navigation check failed, and that check passed after correction. This is not an all-suite claim. Additional historical standalone console/Meta harnesses remain incompatible with newer platform-link/fixture expectations; the Meta harness also lacks its old tracked `growth-acceptance/fake-meta.js` dependency on the current branch. A temporary historical fixture confirmed its obsolete expectations that unverified Instagram destinations can publish. Those harnesses are not counted as passing, and no publishing/profile gates were relaxed. Issue #203 remains open for full activation acceptance.

## Deployed isolated campaign and QR evidence

Existing acceptance Workflow `wrun_41M6RF70770GQ41FZR511GPAVN` completed November 6 at **8:02:12 AM EST** against the repaired staging alias, using `fmgrowthtest` and the isolated HTTP signup backend. It revalidated the persisted, idempotent November 5 acceptance journeys for both published fights; it did not create real affiliates or claim new real conversions.

- Signup attribution, verified mapping, distinct league destinations, actual served league QR PNG decoding, TEST entry/credit replay and cross-affiliate refusal passed. Four league QR images still decode to their exact persisted links. Real charges: zero. Verification notifications are captured.
- Original affiliate/poster records remained unchanged. Staging worker `autonomous-preparation-v4`, deployment `dpl_3Fzc4Vz8nvWz3EincK2Q5WiTxctC`, continued independent scheduled cycles.
- Fresh read-only QR audit `wrun_41M6RFNMZA0GNC6VS8GAP5NW00`, November 6 **8:10:08 AM EST**, decoded actual stored artwork and followed destinations. Four current fight posters passed; eight withdrawn posters remain excluded. Both current fights retain their IDs and complete campaign attribution, with affiliate identity correctly not applicable to ordinary fight posters.
- Across the full inventory of 28 sources: 4 PASS, 1 FAIL, 23 HOLD. The FAIL is the retained legacy Liam Tuffs link: `campaign_parameters_lost`, `legacy_namespace_not_modified`, `recipient_affiliate_suitability_requires_evidence`, `affiliate_terms_not_verified`. The isolated redirect repair remains available; the live redirect is not fixed or deployed by this work.
- All 20 original HOLD items retain individual dispositions: 8 withdrawn exclusions, 4 unsuitable/unverified media-derived exclusions, 3 replaced only by approved staging QA evidence, and 5 commercial-terms holds. These dispositions are not permission to contact anyone.

[Sanitized complete evidence](evidence/issue203/restoration-and-acceptance.json) includes all source items, actual decoded URLs, observed destinations, identity matches, attribution decisions, test league links and individual holds.

## Preserved production and remaining gates

Production stays on commit `57afb435fcec624dedfe4afeb9cd79e1fff7750c`, deployment `dpl_7pM53Xz63j2p24ue6DG6jUQrnYHC`, database `fmgrowthproduction` / `production_preparation_`. No production asset/routing change, website/game deployment, payment mutation or scheduler stop was performed. The original production generation is preserved.

Read-only checks during repair grew from 53 completed / 52 scheduled cycles to 55 / 54, healthy=true, lastError=null. All four social accounts remained connected with fresh existing-service evidence. TikTok access is valid; X access is valid with renewal expiry unknown, not unlimited. Facebook and Instagram were independently verified. Observed real deliveries, live social posts, synthetic production affiliates, production affiliate mappings and attribution events are zero. The unchanged original Growth affiliate hash is in the evidence; this is not a separate direct audit of the live game database.

Production preparation currently has 2 held Marketing drafts, 23 PR drafts eligible for review and 7 held affiliate drafts, plus 17 affiliate source holds. Marketing holds remain `verified_original_artwork_and_qr_required`: staging poster success does not by itself release a production draft. Affiliate source failures and commercial terms remain held. The five independent terms reviews are Alania Fighting Team, American Kickboxing Academy, Golden Belt Club, Chicago MMA and AMC Kickboxing/Pankration. Actual owner-approved promoter agreement/version is required; no invented commission or league is claimed.

Owner gates:

1. Fresh/private-browser acceptance of the exact restored Preview, using the normal existing website administrator login. Do not approve, connect/disconnect, stop, send or publish for this visual check.
2. Separate explicit authorization before any production dashboard routing/assets release. Current production UI is intentionally unchanged by the Preview restoration.
3. Production-applicable artwork/QR proofs, recipient/source suitability, real affiliate authority mappings and actual approved commercial terms before affected campaign approval.
4. Separate explicit channel/recipient-specific outbound activation authorization. All publishing, emails, DMs, automatic approvals and payment mutations remain off.

## Rollback

Only staging aliases moved. The prior original approved frontend deployment is `dpl_5dcxvo2peJEjcSe8oGZS2vh9LXnj`; the prior original integrated backend is `dpl_5WyotJUWM9siSVLCViRMZYkcnzkm`. If a staging release must be reverted, reassign only its staging alias after verifying the desired code compatibility. Keep database records, credentials and both worker generations intact. Do not promote a Preview or touch production aliases as rollback for a staging UI issue. The production emergency-stop and routing rollback procedure remains in `growth-controlled-production-launch-20261105.md`; it was not invoked for this restoration.

Final production timer observation: **November 6, 8:18:25 AM EST** (`2026-11-06T13:18:25.363Z`), 55 completed / 54 scheduled cycles, same generation, healthy, no error, zero observed sends/posts. All four connection statuses were freshly checked around 8:16 AM EST.

Final CI: [frontend quality/security](https://github.com/WajihulHassan944/fmm-ver2/actions/runs/42223901750), [frontend isolated affiliate acceptance](https://github.com/WajihulHassan944/fmm-ver2/actions/runs/42223901673), [backend quality/security](https://github.com/WajihulHassan944/fantasymmadness-game-server-three/actions/runs/42223892956), [backend full isolated suite](https://github.com/WajihulHassan944/fantasymmadness-game-server-three/actions/runs/42223892877). Exact final conclusions are recorded in the accompanying evidence update.

### Final CI limitation — do not report all-green activation

Frontend quality/security **42223901750**, frontend affiliate acceptance **42223901673**, and backend quality/security **42223892956** succeeded. Backend run **42223892877** reported **187 tests passed, zero test failures**, passed real Preview/OAuth/poster checks and dependency audits, then failed its final external staging worker-health smoke. Read-only execution history identifies the cause: at **8:16:48 AM EST**, affiliate preparation returned `preparation_source_temporarily_unavailable`, state `retry`, while Marketing and PR completed. The original worker remains running and credentials/Meta scopes remain verified. Its health check correctly stays unhealthy until recovery; this is not a production failure or a restored-dashboard test failure. No scheduler restart or forced campaign dispatch was performed to hide the failure. Full operational activation remains HOLD until a subsequent real scheduled recovery is verified.

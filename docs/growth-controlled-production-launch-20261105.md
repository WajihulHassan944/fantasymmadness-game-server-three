# Controlled production preparation launch — November 5, 2026 (EST)

Production **preparation only** is deployed, independently scheduled and routed into the existing administration. This is distinct from isolated staging. Publishing, email, DM/outreach, automatic campaign approval and payment-related mutations remain disabled. Owner-browser acceptance remains pending; no interactive owner login is claimed by the service checks.

## Exact release and live verification

- Production application commit: `57afb435fcec624dedfe4afeb9cd79e1fff7750c` (PR #114 remains unmerged).
- Production preparation deployment: `dpl_7pM53Xz63j2p24ue6DG6jUQrnYHC`; immutable URL https://fantasymmadness-growth-isolated-test-7q1o9lp3a.vercel.app . Target is **production**, not Preview. No automatic domain assignment was used.
- Existing owner entry: https://www.fantasymmadness.com/administration/growth-engine . Production Growth API: https://fantasymmadness-growth-isolated-tes.vercel.app/api/growth/health .
- Only reviewed preparation endpoints on the production Growth hostname are rewritten to the new deployment. Active routing version: `1ba2b27e-3c93-4922-8cba-c2c679fc8de1`; rule `30d62adf-0ff3-45e2-91aa-cc0ce51d84ea`.
- The original Growth deployment `dpl_ALUdU4vPfa3zXQtcfqR1UGsegpUt` remains in place for legacy callbacks, verified attribution ingest, unsubscribe and original poster URLs. The rule excludes these paths and every staging host. Original Meta callback JavaScript was verified HTTP 200 after routing.
- The website remains `dpl_DMr4WzuVzfcq8xjgRTcbBQ54QJgQ`, commit `2f58dde8f48478b168aa39f29e16fa90e90449a7`. No frontend release, main merge, game deployment or payment change occurred.
- The public production health and console returned HTTP 200; anonymous administrator APIs returned 401. Production smoke assertions passed against the live routed URL, including actual scheduled execution, database identity, disabled-action gates and console CSP.

## Real unattended execution

Workflow: `wrun_41M6Q13HCK0GXVGA5ZQVN1BM8Q`. Generation: `production-preparation-5a99b6f4-d62f-4274-bc12-ad6411896065`. Activation workflow: `wrun_41M6Q136460GJA57YZ8N03PJ9T`.

| Ordinal | Trigger | Completed, owner time | Errors | Website session used |
|---|---|---|---|---|
| 1 | workflow_timer | Nov 05, 2026 06:51:34 PM EST | 0 | False |
| 0 | bootstrap | Nov 05, 2026 06:36:24 PM EST | 0 | False |

The full 15-minute timer, not just bootstrap or a READY build, was observed. Continuous rollover is implemented; these checks do not claim 24 hours of historical production uptime. Jobs have duplicate claims, lease fencing, bounded retries, source backoff and dashboard/log monitoring. Emergency stop was exercised on the actual production candidate before activation (`wrun_41M6Q0ZX1Y0GT4YNKKTACW17T4`); it disabled preparation and changed the generation. Health requests and administrator sign-in do not reactivate a stopped worker.

## Data isolation and credentials

Production business data uses database **`fmgrowthproduction`** and namespace **`production_preparation_`**. Staging remains `fmgrowthtest` / `preview198_`. Both databases share the existing approved Atlas cluster and existing sensitive credential binding; they are logically separate databases/namespaces, not separate physical clusters or independent credentials. Read-only privilege inspection confirmed that the existing binding permits the new database. No additional credential was retrieved, disclosed or regenerated.

The production namespace was empty before initialization. The runner refuses unknown pre-existing campaign, affiliate or attribution data without its production schema marker. No staging campaigns, synthetic affiliates, test credits, acceptance accounts, approvals or contact research were copied. Production synthetic affiliates, mapped real affiliates and attribution events are all zero. No real conversion, commission, league ownership or revenue is claimed. Original Growth affiliate records have an unchanged count and SHA-256 snapshot.

A single administrator was verified from 16 existing signed production-origin SSO logins and bound privately in a sensitive Production environment variable. Existing production Ed25519/public-key configuration and original private keys were preserved. The existing website signs first-party assertions; production sessions use a distinct audience/derived key, nonce consumption, bounded expiry and revocation. The response contract matches the existing frontend bridge, including numeric expiry. No second Growth password was introduced. Real fresh-owner browser acceptance is still separate from signed local browser fixtures and authorized service checks.

All four existing accounts remain connected according to the existing independently operating connection service: Facebook and Instagram independently verified, TikTok access valid, X access valid. Tokens, provider account IDs, scopes, original encryption key/AAD and callback configuration remain in their original store. Production reads safe status only; it does not copy credentials or acquire publishing authority. X refresh-grant expiry remains unknown rather than being described as unlimited. Stale provider verification is reported explicitly.

## Active production operations and holds

At the verified scheduled cycle: two marketing drafts, six PR drafts and six completed preparation jobs; zero automatically approved drafts, zero real deliveries and zero live social posts. Non-delivering preparation receipts are evidence snapshots, not delivery receipts or conversions. Discovery covers Boxing, MMA/UFC, Bare-Knuckle, Kickboxing and Pro Wrestling; only the two actually eligible published contests generated campaigns. No fight was created, reopened or changed.

Marketing remains held for both source fights (`6ad629a60df141df46931a8b` and `6adfcba7ee2996e566885594`) with exact blocker `verified_original_artwork_and_qr_required`. New production rendering has not been enabled. The verified staging render pipeline and original production poster URLs remain intact; no withdrawn image was reactivated.

Affiliate discovery/research is running and preserves unverified candidates as holds, not approved recipients or active affiliates. Current source holds:

- `ap-a3a2e4d579589f8bfc7fcb` / Wikidata source `Q205953`: `http_526`; no verified contact/draft or affiliate mapping was asserted.
- `ap-e1782f01e695b55f9dabf9` / Wikidata source `Q2605547`: `external_source_unavailable`; no verified contact/draft or affiliate mapping was asserted.

HTTP 526 is the publisher's origin-certificate failure; TLS verification was not bypassed. The second source could not complete its public-source/contact verification; the stored error body was redacted, so no unsupported underlying cause is invented. Research retries use bounded backoff while other work continues.

The earlier 20-source audit remains individually recorded: eight withdrawn posters excluded, four media-derived recipients excluded for missing independent affiliate suitability, three old synthetic proofs replaced only by approved staging QA journeys, and five independent recruitment drafts still held for the actual approved promoter agreement/version. These staging QA results are not real conversions or commercial affiliate approval. The Liam Tuffs redirect and isolated signup-to-entry-to-unique-TEST-credit flow passed in staging. Its public-website redirect/signup persistence fix was not promoted, and Liam remains held for suitability/terms and actual approved mapping before any outreach. No existing league is claimed.

## Automated evidence and limitations

- Production release full CI: [42129470889](https://github.com/WajihulHassan944/fantasymmadness-game-server-three/actions/runs/42129470889), job `127602105421`: **186 reported tests, zero failures, zero skips**. Release quality/security [42129471028](https://github.com/WajihulHassan944/fantasymmadness-game-server-three/actions/runs/42129471028) succeeded. Backend and worker dependency audits report zero vulnerabilities.
- Final local combined regression set passed 38 checks; the added production pre-existing-data guard passed separately with all seven production-profile tests. Actual embedded-browser tests used a signed fixture, not a fabricated real owner session.
- The read-only observer is commit `3acb3ae5ecf392c06457b118622394a14fd31d65`, Preview `dpl_BhmkvWAWNyXFaCwm29L5yw6tp6sY`. Observer CI [42131803283](https://github.com/WajihulHassan944/fantasymmadness-game-server-three/actions/runs/42131803283) and quality [42131803342](https://github.com/WajihulHassan944/fantasymmadness-game-server-three/actions/runs/42131803342) succeeded. This did not replace the production worker.
- The exact live smoke script passed through the approved inherited proxy. GitHub dispatch of its new workflow returned 404 because the workflow is not registered on the default branch; no merge was performed merely to register it.
- Live game API deployment metadata is denied (403) to the connected Vercel identity. No game deployment was attempted. Read-only published Fight Registry access works; no real checkout, charge or financial action was performed or claimed as tested.
- No tokens, authorization codes, secret values, recipient emails, private owner IDs or artwork bytes are attached.

## Rollback and emergency stop

1. In the existing production Growth console, use **Emergency stop preparation**. Authorized service control can instead execute `stopProductionPreparation` against production deployment `dpl_7pM53Xz63j2p24ue6DG6jUQrnYHC` using the authenticated Vercel Workflow control plane. The underlying generation is fenced and automatic approval stays off.
2. Restore Growth project routing baseline **`012c758a-2ec5-4364-9cea-1a1e9ae6008e`** with `POST /v1/projects/prj_Hpe9UjGrBBJOm3boxHsL9lHesWLl/routes/versions`, body `{"id":"012c758a-2ec5-4364-9cea-1a1e9ae6008e","action":"restore"}`. This is the reviewed empty rule set. The original legacy deployment is still READY and keeps all prior endpoint ownership.
3. Do not alter website/game aliases, original keys, provider records or payment settings. Do not delete the new production database; keep preparation records as audit/owner work. Staging worker `autonomous-preparation-v4` remains independent and should stay running.
4. Verify legacy Growth health after rollback, check the worker is stopped, and confirm no publishing/outbound action. Resume requires explicit owner/service confirmation; health or login alone cannot restart it.

Owner acceptance: open the normal back office in a fresh/private browser, confirm automatic connection and the **Production Growth preparation** view. Do not approve or publish. The technical production preparation launch is verified; fresh owner-browser acceptance and the stated creative/recipient/terms holds remain open.

## Final post-routing observation

A second real production timer completed **Nov 5, 2026, 7:06:46 PM EST** (`2026-11-06T00:06:46.659Z`). Production now has three completed cycles (bootstrap plus two unattended scheduled cycles), healthy=true, lastError=null. It has **2 marketing drafts, 8 PR drafts, 9 completed preparation jobs**, no approvals or real sends, and the same explicit creative/source holds. All four connections were freshly verified by the existing service at approximately **7:04 PM EST** without credential changes. This also confirms the preserved isolated connection-maintenance worker continued after production routing was published. Fresh-owner browser acceptance remains pending; no interactive owner session was fabricated.

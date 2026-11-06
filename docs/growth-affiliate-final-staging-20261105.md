# Affiliate final staging acceptance — 5 November 2026

Technical staging journey passed. Owner acceptance and five commercial-terms reviews remain pending. These are isolated QA accounts, not commercial affiliate accounts. No live signup handler, real gateway, email or publisher was used.

## Deployed versions

- Backend: `9b181672c18202c2f8af95536c29a7a9f3f37c87`; Preview `dpl_5WyotJUWM9siSVLCViRMZYkcnzkm`.
- Workflow helper: same commit; `dpl_9fGXz7GTcj5guAFcc9osfb9y2nMT`.
- Frontend: `6c21ced7961c3b5ae1f3f642d0d9b01c791e01d6`; Preview `dpl_5dcxvo2peJEjcSe8oGZS2vh9LXnj`.
- Owner URL: https://fmm-ver2-growth-social-preview.vercel.app/administration/growth?engine=affiliates
- Acceptance Workflow: `wrun_41M6PX10Z00GJR2M3T36Y3R65R`, completed 22:25:10 UTC (17:25:10 EST).
- Existing worker preserved: `dpl_3Fzc4Vz8nvWz3EincK2Q5WiTxctC`, release `autonomous-preparation-v4`; independently completed 21:47, 22:02 and 22:17 UTC with zero errors. No website session.

## Actual deployed journey

Both published fights were tested separately through the isolated HTTP signup endpoints. Four new approved staging accounts received four distinct verified league links. Four actual served QR PNGs decoded to those exact links. Each fight has one accepted TEST entry and one unique TEST credit; retries reused the same entry/credit, and cross-affiliate credit was refused. Notifications were captured, not delivered. Test payment gateway is `none`, charged amount zero. No normal Affiliate records were changed.

Source fight verification must be fresh and published; unverified accounts cannot create a mapping or claim an existing league. All new account/payment/entry records use the dedicated acceptance namespace in `fmgrowthtest`. Test terms do not approve commercial recruitment agreements.

The Liam Tuffs legacy URL was retested in a 390×844 browser against the real Next staging route and real isolated signup core. The redirect retains its campaign parameters. A missing invitation stops signup instead of invoking the live handler. Production retains its pre-existing redirect defect; this fix was not deployed there.

## Every original HOLD

| Source item | Disposition | Result |
|---|---|---|
| `affiliate-p-1756c6710e383d26` | EXCLUDED_UNVERIFIED_AFFILIATE_SUITABILITY | Resolved by exclusion or approved staging evidence; no delivery approval |
| `affiliate-p-69fc82b0cae2bb89` | EXCLUDED_UNVERIFIED_AFFILIATE_SUITABILITY | Resolved by exclusion or approved staging evidence; no delivery approval |
| `affiliate-p-dfcf83a1e2a04eeb` | EXCLUDED_UNVERIFIED_AFFILIATE_SUITABILITY | Resolved by exclusion or approved staging evidence; no delivery approval |
| `affiliate-p-22505d8dff73cec0` | EXCLUDED_UNVERIFIED_AFFILIATE_SUITABILITY | Resolved by exclusion or approved staging evidence; no delivery approval |
| `affiliate-ap-d4c8ec180e1bda642e1da3` | HOLD_OWNER_TERMS_AGREEMENT | HOLD: owner-approved promoter agreement/version not provided |
| `affiliate-ap-af07a546ad07dc91d200ee` | HOLD_OWNER_TERMS_AGREEMENT | HOLD: owner-approved promoter agreement/version not provided |
| `affiliate-ap-4dd4aa5d41adf65a3fc982` | HOLD_OWNER_TERMS_AGREEMENT | HOLD: owner-approved promoter agreement/version not provided |
| `affiliate-ap-bd96b034cd5a0a7341e991` | HOLD_OWNER_TERMS_AGREEMENT | HOLD: owner-approved promoter agreement/version not provided |
| `affiliate-ap-e17bd9b8e7a56e9f099425` | HOLD_OWNER_TERMS_AGREEMENT | HOLD: owner-approved promoter agreement/version not provided |
| `0d293833a235d214a8bb-portrait` | EXCLUDED_WITHDRAWN | Resolved by exclusion or approved staging evidence; no delivery approval |
| `0d293833a235d214a8bb-story` | EXCLUDED_WITHDRAWN | Resolved by exclusion or approved staging evidence; no delivery approval |
| `5e380f3626308e2f7fa2-portrait` | EXCLUDED_WITHDRAWN | Resolved by exclusion or approved staging evidence; no delivery approval |
| `5e380f3626308e2f7fa2-story` | EXCLUDED_WITHDRAWN | Resolved by exclusion or approved staging evidence; no delivery approval |
| `bbb25e548fcbcf78d25e-portrait` | EXCLUDED_WITHDRAWN | Resolved by exclusion or approved staging evidence; no delivery approval |
| `bbb25e548fcbcf78d25e-story` | EXCLUDED_WITHDRAWN | Resolved by exclusion or approved staging evidence; no delivery approval |
| `c324a0c7b19423230dcd-portrait` | EXCLUDED_WITHDRAWN | Resolved by exclusion or approved staging evidence; no delivery approval |
| `c324a0c7b19423230dcd-story` | EXCLUDED_WITHDRAWN | Resolved by exclusion or approved staging evidence; no delivery approval |
| `syn-affiliate` | REPLACED_BY_APPROVED_STAGING_SIGNUP_TEST | Resolved by exclusion or approved staging evidence; no delivery approval |
| `syn-affiliate:6ad629a60df141df46931a8b` | REPLACED_BY_APPROVED_STAGING_SIGNUP_TEST | Resolved by exclusion or approved staging evidence; no delivery approval |
| `syn-affiliate:6adfcba7ee2996e566885594` | REPLACED_BY_APPROVED_STAGING_SIGNUP_TEST | Resolved by exclusion or approved staging evidence; no delivery approval |

Eight withdrawn posters remain excluded with no active campaign references. Four media-derived prospects remain excluded from affiliate approval because episode relevance is not independent suitability evidence; their research and drafts were preserved. Three old synthetic sources were replaced as technical evidence by fight-specific approved staging journeys; the old fixtures were not converted into real affiliate accounts.

The five remaining prospects are Alania Fighting Team, American Kickboxing Academy, Golden Belt Club, Chicago MMA and AMC Kickboxing/Pankration. Their official role/contact sources were rechecked successfully. Published Terms §12 delegates the rate to each promoter agreement. No approved agreement/version has been supplied or invented. The owner-only review UI records a sourced staging review; automatic service authority cannot approve it.

## Security and regression evidence

- Local core: 9 tests passed, including concurrent workers and service recreation.
- HTTP security: 1 integration passed, covering unauthorized access, service authentication, wrong campaign, captured verification, approval gate and logout persistence.
- HOLD/terms review: 6 passed, including rejection of automated terms approval and evidence from the wrong fight.
- Expanded local recruitment/approval/autonomy suite: 27 passed before the additional concurrency/fight-specific cases.
- Real mobile Next + isolated Mongo/signup core: passed locally and in frontend CI `42120760159` / job `127572179661`.
- Frontend quality/security CI `42120759972`: success; local build passed, lint zero errors (61 existing warnings).
- Backend quality/security CI `42121056120`: success. Full security/OAuth/poster/worker CI `42121056138` / job `127573200882`: **success, 175 reported tests, zero failures, zero skips**. Earlier complete run `42120535191` also succeeded.
- Backend root and worker dependency audits: zero vulnerabilities. No secrets or image bytes attached.
- Original four fight poster QRs: 4/4 actual images decoded correctly, plus 4/4 new personalized staging league QR PNGs; all 8 withdrawn images remain excluded.

All four social accounts remain connected in the original worker’s latest read-only/provider validation: TikTok access valid, X access valid, Facebook and Instagram independently verified; permissions verified. X refresh-grant expiry remains unknown rather than being presented as unlimited. No credentials, account IDs, scopes, original encryption key or provider settings were replaced.

## Owner-only acceptance

Use a fresh/private browser and normal administrator sign-in. At the owner URL choose Affiliates, type `RUN STAGING ACCEPTANCE`, and run. Expect `passed`, authority `owner_session`, verified league links and no real charges. Automated authority `authorized_staging_acceptance` is explicitly not a claim of fresh owner acceptance. No password or session token is requested. Review the existing approved promoter agreement/version separately; do not approve campaigns, send or publish during this test.

## Rollback — Preview only

1. Set frontend branch-scoped `FMM_GROWTH_AFFILIATE_ACCEPTANCE_ENABLED=false` and `NEXT_PUBLIC_GROWTH_AFFILIATE_ACCEPTANCE_ENABLED=false`; set backend branch-scoped `GROWTH_AFFILIATE_SANDBOX_ENABLED=false`. Do not change secrets.
2. If needed reassign only `fmm-ver2-growth-social-preview.vercel.app` to `dpl_8jDX9beKjT9H7AbpYm8DCX8ib6Sb` and only the isolated OAuth Preview alias to `dpl_HuzcNKQXznGVFzZoLoR3on9q8Zy6`. Do not assign production domains.
3. Leave existing 15-minute worker `autonomous-preparation-v4` running. Preserve emergency stop. Retain acceptance records as audit evidence; no destructive rollback or affiliate-record deletion is necessary.
4. Production IDs were checked unchanged: website `dpl_DMr4WzuVzfcq8xjgRTcbBQ54QJgQ`, Growth `dpl_ALUdU4vPfa3zXQtcfqR1UGsegpUt`. No merge or production approval is implied.

Detailed source URLs, expected destinations, account/fight IDs, per-source dispositions and replacement league destinations are in [the safe JSON evidence](evidence/growth-affiliate-final-staging-20261105.json). The earlier full public redirect inventory remains separately preserved.

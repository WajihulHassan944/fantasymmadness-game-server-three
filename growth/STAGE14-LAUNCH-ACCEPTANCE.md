# Stage 14 — Real-service acceptance and launch gate

Status: BLOCKED until actual independent evidence exists. Offline CI passing is not evidence of live service integration.

## Required verification, in order
1. **Official FM logo:** locate the existing approved logo asset in frontend or media storage, confirm it is publicly loadable over HTTPS, and render it in a received email. Do not invent or replace brand artwork.
2. **Business Gmail sender:** verify the actual authenticated sending account is contact@fantasymmadnesscom.com. ChatGPT Gmail connector currently reports an account-selection error despite two accounts being connected in UI. Do not fall back to personal Gmail.
3. **Dedicated staging database:** provision isolated database with unique credentials and no shared production URI. Record a safe, redacted isolation attestation.
4. **Sandbox mail:** provision non-production provider, test branded email HTML and plain text, capture receipt and opt-out behavior without contacting outside prospects.
5. **Controlled workflow:** run prospect discovery → verified public relevance → personalized draft → dedupe/opt-out → owner approval → sandbox send → delivery receipt → follow-up stop conditions → report. Demonstrate scheduling and recovery, not just pure helper functions.
6. **Real pilot:** only after explicit owner approval, verify lawful outreach, sender authentication and deliverability, recipient review, and metrics. Preserve production website/payment behavior.

## Current known blockers
- Official logo URL not independently verified.
- Business sender account selection fails in ChatGPT connector.
- Separate staging DB and mail sandbox not confirmed.
- Existing draft/queue code not demonstrated wired to persistent runtime or real scheduler.
- No external campaign or real attributed paying-player results verified.

## Launch decision
NO GO for unattended real outreach. GO for continued isolated development and evidence collection. Never merge or deploy to production without explicit owner approval.

# Campaign 001 — Prospect discovery and scheduling specification

**Status:** DRAFT_ONLY. No actual prospect discovery or outreach has been executed by this document.

## Target categories and criteria
1. **Combat sports media:** boxing/MMA/BKFC news outlets, interview shows, podcasts, event coverage accounts. Validate current editorial relevance and public business contact channels.
2. **Promoters and event organizers:** verified organizations with upcoming publicly confirmed combat sports events. Confirm event dates, permissions and existing partner relationships.
3. **Fighters, managers and affiliates:** publicly listed professional business contacts interested in audience engagement. Never scrape private contact information.
4. **Influencers:** combat sports creators with an identifiable professional contact route and appropriate audience.

## Prospect record contract
Each prospect requires:
- organization or public professional name
- category, public source URL, source observation date
- publicly offered business contact channel and basis for outreach
- personalized relevance note, campaign id, owner approval status
- deduplication key, suppression/opt-out flag, last contacted timestamp
- next-action time, delivery receipt, reply status, audit history

Do not store secrets or private/sensitive data in GitHub.

## Daily proposed run (not enabled)
- 08:00 local: discover public prospects and relevant confirmed fights; mark unverified records for review.
- 09:00 local: prepare tailored PR and affiliate drafts, campaign assets and event citations.
- 10:00 local: deduplicate, screen suppressions and queue eligible drafts for owner approval.
- 14:00 local: report queued campaigns and exceptions.
- Follow-up: only after verified initial delivery and within approved cadence, with a maximum of two respectful follow-ups; stop on reply or opt-out.

## Outbound fail-closed gates
- Gmail connector must authenticate as the approved business sender contact@fantasymmadnesscom.com; do not use personal Gmail as fallback.
- Verify separate non-production staging database and mail sandbox before end-to-end automation tests.
- External outbound stays disabled until recipient list, messaging, unsubscribe/opt-out handling, legal compliance and owner authorization are reviewed.
- No payment charges, production DB writes, production deployment or changes to live website.
- No unverified claims of earnings, prize pools, endorsements, fighter involvement or events.

## Reporting contract
Separate counts for discovered, validated, drafted, approved, sent, delivered, bounced, replied, meetings, affiliates onboarded, and independently verified attributed registrations and paid entries. Never equate drafted with sent, or sent with delivered.

## Next execution acceptance
1. Demonstrate a dry-run producing queue entries with synthetic prospect data.
2. Confirm queue does not send emails or touch production resources.
3. Resolve business Gmail account-selection error.
4. Run staging-only provider delivery and receipt tests after isolation.
5. Seek explicit owner approval for a small real outreach batch.

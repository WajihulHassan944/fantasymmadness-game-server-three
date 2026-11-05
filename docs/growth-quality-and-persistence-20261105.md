# Isolated Growth quality, recruitment and OAuth persistence refinement

Work continues on backend PR #114 and frontend PR #201 / Issue #198. All
business collections remain in fmgrowthtest under preview198_. Original social
connection collections, encryption keys, identities and ownership are reused.
No production merge, website/payment change or real outreach is included.

## Platform captions and timing

Five independent caption drafts are generated: Instagram (3–5 relevant tags),
Facebook (2–4), TikTok (3–5), X (1–2), YouTube Shorts (3–5). These hashtag budgets
are editorial constraints, not assertions of undocumented provider limits.
Only brand, actual sport, fighter and verified promoter names become hashtags.
X uses the provider-recommended twitter-text weighted counter (280, including
23-unit URL handling and Unicode/emoji). TikTok video captions use a 2,200
UTF-16-unit ceiling. Shorts descriptions use 5,000 UTF-8 bytes and titles 100
Unicode characters, with no < or >. Instagram/Facebook use a conservative
2,200-unit application budget. Facebook's application budget is not presented as
its provider maximum. No YouTube account/publishing connection is invented.

Provider documentation checked November 5, 2026:
- https://docs.x.com/fundamentals/counting-characters
- https://help.x.com/en/using-x/how-to-use-hashtags (two recommended, not a hard hashtag limit)
- https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post
- https://developers.google.com/youtube/data/reference/rest/v3/videos
- https://support.google.com/youtube/answer/6390658 (more than 60 tags ignored)
- https://support.google.com/youtube/answer/13748639 (Shorts description URLs are not clickable)
- Meta IG media reference / Help hashtag reference / Pages posts reference were
  requested but returned HTTP 429 or inaccessible/login pages. Current Meta
  numerical limits could not be independently revalidated from those primary
  pages. The conservative application budgets are enforced; no live publishing
  is enabled or claimed verified by this documentation check.

Instagram profile-link claims require the actual provider-observed website on
the already verified Instagram identity, a successful trusted-site read and an
exact fight+campaign destination (or a hub containing that exact tracked link).
Configuration alone never verifies a bio link. Redirects remain on the approved
FANTASY MMADNESS website. A wrong, stale, unreachable or untracked destination
holds that platform. TikTok user/info documents profile_deep_link (the profile
itself), not a clickable outbound website field: it is not misused as website
proof. Instagram/TikTok/Shorts get no raw caption URLs or unverified bio claims;
Facebook/X retain tracked clickable fight URLs. Missing supported destinations
remain visible owner-acceptance items rather than fabricated configuration.

Registry matchTime is used by the existing entry-cutoff helper; it is never
assumed to establish a confirmed event start. Confirmed event timing additionally
requires an explicit timezone-bearing eventStartAt, verified flag, source URL and
valid timezone/date. Entry cutoff after event start, invalid dates/timezones or
contradictory fields block approval. Owner-added unsupported clocks/dates are
checked too. Posters omit an unverified event clock. Approved or owner-edited
content is not regenerated; safety gates hold stale/invalid work for review.

## PR and affiliate email quality

Default greeting is Hi,. Hi [First Name], requires explicit verified-person
metadata and a source. No mailbox, organization, show title or author inference.
Named/numeric HTML entities are decoded to text before one safe HTML escape;
subjects are single-line and plain text, never double-escaped. Sourced episode
metadata says “I came across”, never “I listened”. No unsupported free setup,
commission percentage, guaranteed earnings or personal familiarity is generated.
The approved brand logo and existing founder contact are preserved.

Existing untouched unapproved auto-researched drafts are regenerated with content
history; owner edits, approvals, contact research and attribution are preserved.
The Cami invitation receives the same verified-name rule; an RSS owner label
alone cannot substantiate Hi Camilla,. Podcasts require independent suitability
before an affiliate invitation can be approved.

## Independent recruitment

The new affiliate_prospects collection separates structured partner discovery
from PR podcast research. Public Wikidata APIs/query service identify professional
roles and official websites, with source URLs, timestamps and confidence. The
scheduler rotates all five sports and fighter/wrestler/trainer/gym/manager/
promoter/creator/commentator categories. No gender filter excludes women or men;
unknown country, audience, engagement and conversion ability remain unknown.
Existing active affiliates' explicitly sourced opportunities are also supported.
Public official-site contact research respects robots, rejects private networks,
pins DNS, follows only bounded same-site HTTPS redirects with fresh DNS/publisher-policy checks, limits responses and extracts only explicitly
published business email links with MX validation. No address is guessed.
Wikidata data-access/licensing references: https://www.wikidata.org/wiki/Help:Data_access
and https://www.wikidata.org/wiki/Wikidata:Licensing .

Scores are disclosed heuristics, not predicted revenue. Deduplication spans
source IDs, websites and recipient history, including rejected/opted-out drafts.
New contacts remain drafts. Sandbox captures are not invitations sent; responses,
onboarding and conversions require evidence. Financial attribution remains
unconnected in staging and is not invented. Approved current affiliate terms
must be supplied/reviewed before external invitations; no rate or free setup
claim is made. The existing /affiliate-create-account redirect drops UTM tags,
so new invitations use the already supported /auth?mode=signup&role=affiliate
route directly, with preserved campaign parameters and readable HTML link text.
No live signup/payment/credit implementation was changed.

## Persistence and renewal

Original AES-GCM OAuth records remain outside the department namespace. Session
logout/revocation affects browser authorization, not provider connections. TikTok
and X renew only when due (30-minute lead), with an expiring distributed lease,
backoff, encrypted rotation and revision CAS. A rotated response awaiting an
identity retry is quarantined encrypted, never activated before the same account
and required scopes are verified; retry does not exchange a one-time token twice.
Refresh expiry is tracked when provided and never presumed infinite. Failure
preserves active credentials and creates an actionable sanitized alert. Revoked,
expired, refresh-needed and insufficient-permissions states are distinguished
when provider evidence establishes them.

TikTok/X reference: https://developers.tiktok.com/docs/en/oauth-user-access-token-management
and https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code .
Facebook Page authorization has no generic OAuth refresh token: working Page
credentials are retained and checked read-only; stored expiry and provider
permission evidence are reported without promising indefinite authorization.
No Meta token is exchanged or replaced by this change.

The worker calls the isolated backend's service-authenticated maintenance route
using its existing server-side CRON_SECRET. Provider client secrets and the OAuth
vault key are not copied into the worker, UI, GitHub or logs. Emergency stop skips
renewal as well as research. A new release generation takes over only when the
old generation has no active lease; old durable runs exit on their next wake.
No public health request can reset a stop or roll a generation backwards.
The original worker remains running until a tested replacement is deployed.

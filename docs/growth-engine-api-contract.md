# Growth Engine API contract (backend ↔ website admin)

This is the contract between the Growth Engine backend (owned by Claude) and the website admin, Growth Engine dashboard and poster/social UI (owned by Codex). It is stable for the November 2026 staging release.

The backend lives in `WajihulHassan944/fantasymmadness-game-server-three`, branch `test/growth-backoffice-console`, and is deployed only to the isolated Vercel project `prj_Hpe9UjGrBBJOm3boxHsL9lHesWLl`.

- **Staging base URL:** `https://fantasymmadness-growth-isolated-tes.vercel.app/api/growth`. The website reads it from `NEXT_PUBLIC_GROWTH_ENGINE_URL`.
- **Isolation:** the isolated project serves **only** `/api/growth/*`. Every other path returns 404 `{service:"growth-engine-isolated"}`, so the legacy game server is not reachable there.
- **Data:** the database is `fmgrowthtest`, pinned to `fmgrowthtest.zxhtsfa.mongodb.net`.
- **Never sent:** no real email, post or charge goes out unless the owner explicitly authorizes it (see "Fail-closed switches").

## Authentication

| Call | Body | Returns |
|---|---|---|
| `POST /admin/login` | `{password}` (the Growth Engine owner password, not the live admin password) | `{token}`: a console token, 12 h |
| `GET /admin/session` | | `200` while the token is valid |

- Send `Authorization: Bearer <token>` on every `/admin/*` call.
- `401` means sign in again. Tokens issued before a password change are refused.
- CORS allows `https://www.fantasymmadness.com`, `https://fmm-ver2*.vercel.app` previews and the staging origins only.

## Embedding the console (the command center iframe)

- **URL:** `GET /console?embed=1#/<section>`. Sections: `overview`, `approvals`, `marketing`, `pr`, `affiliates`, `publishing`, `automation`, `analytics`, `revenue`, `connections`.
- **Who may frame it:** framing is allowed only for the origins in `GROWTH_CONSOLE_EMBED_ORIGINS` (CSP `frame-ancestors`; no `X-Frame-Options` when origins are set). It currently lists:
  - `www.fantasymmadness.com`
  - `fantasymmadness.com`
  - `fmm-ver2-git-test-growth-e-7c8860-…vercel.app`
  - `fmm-ver2-jh3er1j0x-…vercel.app`
- **New preview origin:** to use a different website preview, add its exact origin to that variable. Wildcards are not supported.
- **postMessage, website → console:** `{type:'fmm-growth-session', token}`. The target origin must be the engine origin, and the console accepts the message only from an allowed embedding origin.
- **postMessage, console → website:** `{type:'fmm-growth-console', section}`. Check that `event.origin` equals the engine origin.

## Fight campaigns (marketing)

| Call | Notes |
|---|---|
| `GET /admin/drafts?kind=marketing&status=needs_owner_review\|approved\|published\|rejected` | Each campaign has the fields described below. |
| `POST /admin/marketing/refresh` | Re-reads the published contests, updates campaigns and generates missing posters. |
| `GET /admin/marketing/coverage` | Verified, created, active and rejected counts per sport, plus rejection reasons. |
| `POST /admin/drafts/:id/approve` | Re-verifies the contest first. With posters on, it builds the poster first if needed (`409 poster_not_ready_try_again` on failure). |
| `POST /admin/drafts/:id/reject` `{reason}` / `POST /admin/drafts/:id/edit` `{headline,text}` | Edits go through the safeguard again. |

Fields on each campaign:
- `contest`: verified facts, `cleanUrl` (fighter-name address) and `contestUrl` (ID address).
- `posts.{facebook,instagram,x,tiktok}`: platform captions with hashtags.
- `poster`: see the next section.

Campaigns are created **only** from contests published in the FANTASY MMADNESS public feeds, in the five sports: `boxing`, `mma-ufc`, `kickboxing`, `bare-knuckle` and `pro-wrestling`. Each contest must also pass `verifyContest`: real fighter names, an open contest, a future date within the horizon, not a shadow or unpublished record, and not a media or podcast name. Auto-discovered candidates are excluded until the owner publishes them.

## Posters

`draft.poster` has this shape:

```json
{
  "portrait": { "id": "<20hex>-portrait", "url": "https://…/api/growth/posters/<id>.jpg", "width": 1080, "height": 1350 },
  "story":    { "id": "<20hex>-story",    "url": "https://…/api/growth/posters/<id>.jpg", "width": 1080, "height": 1920 },
  "art": { "used": true, "url": "<official contest art>", "basis": "Official artwork published by FANTASY MMADNESS on this contest (fightPosterImage)", "sha256": "…" }
       | { "used": false, "reason": "no_official_artwork_on_this_contest | artwork_blocked_by_owner | artwork_host_not_a_fantasy_mmadness_asset_host | artwork_not_on_the_fantasy_mmadness_cloud | artwork_http_404 | …" },
  "qrUrl": "<contest link>?utm_source=fan_acquisition&utm_medium=partner_outreach&utm_campaign=combat_fans_gs_<sport>&utm_content=poster_qr",
  "generatedAt": "ISO"
}
```

| Call | Notes |
|---|---|
| `GET /posters/<id>.jpg` | **Public** (the platforms fetch it). Returns `image/jpeg` with the `X-Image-Width` / `X-Image-Height` headers. HEAD is supported. Withdrawn versions return 404. |
| `GET /admin/posters?draftId=` | Metadata only: facts, layout, artwork status. Never returns image bytes. |
| `POST /admin/posters/generate` `{draftIds?}` | Generates up to 20 posters. |
| `POST /admin/art-rights/:contestId` `{status:'blocked', note}` or `{status:'allowed'}` | A reason is required to block. The poster is rebuilt. An approved campaign goes back to review, and its scheduled or held posts are cancelled. |

Poster rules:
- The fighter artwork is the official contest art from FMM asset hosts only: Cloudinary clouds `daflot6fo` and `dqi6vk2vn`, and `fantasymmadness.com`.
- The artwork is placed whole and unaltered, scaled uniformly with no crop, recolour or overlay.
- Without approved art, the poster is text only.
- The facts come only from the verified contest.
- The QR code encodes `qrUrl` exactly.

**UI guidance for Codex:**
- Show `poster.portrait.url` for Facebook, Instagram and X, and `poster.story.url` for TikTok.
- Show the `art.used` / `art.reason` chip.
- Do not crop the images in CSS. Use `object-fit: contain`.

## Social publishing

| Call | Notes |
|---|---|
| `GET /admin/social?status=` | Posts with `channel`, `status`, `imageUrl`, `scheduledAt`, `attempts`, `lastError`, `sandbox`, `history` and `affiliate`. |
| `POST /admin/drafts/:id/schedule` `{channels:[…], scheduledAt, affiliateId?}` | Results are reported per channel. A channel is refused with `already_scheduled`, `duplicate_of_*_post`, `channel_needs_a_fight_poster_image` or `time_is_after_the_fight`. |
| `POST /admin/social/:id/cancel` · `POST /admin/social/:id/retry` `{confirmNotPublished}` | A `needs_check` post (interrupted mid-publish) needs `confirmNotPublished:true`. |
| `POST /admin/social/pause` `{paused}` | |
| `GET /admin/social/capabilities` | What each platform can actually do here, and what it requires. See below. |
| `POST /admin/social/live-test` | Disabled unless the owner sets `GROWTH_SOCIAL_LIVE_TEST_APPROVED=true`. |

Post status values: `scheduled` → `publishing` → `published`, `held`, `failed`, `cancelled` or `needs_check`.

Dispatch behaviour:
- Every 15-minute run re-verifies the contest before posting.
- Duplicates are refused using a fingerprint of channel, caption and image.
- Retryable errors back off as 5, 10 and 20 minutes, up to 3 attempts.
- Interrupted publishes are flagged `needs_check` and are never reposted automatically.

Sandbox receipts are kept in `growth_social_sandbox`, with the platform pre-checks recorded in `preflight.problems` and `preflight.notes`.

What each platform can do (`GET /admin/social/capabilities`):

| Platform | Media | Links in captions | Requires |
|---|---|---|---|
| Facebook | Poster photo | Clickable | Page connected |
| Instagram | Poster (JPEG, 4:5) | **Not clickable** (the QR carries the link) | IG professional account linked to the Page |
| X | **Text and link only** (poster not attached) | Clickable | `tweet.write` user token. Attaching media needs the media upload scope (not enabled). |
| TikTok | Poster photo (9:16, PULL_FROM_URL) | **Not clickable** | Content Posting API scopes. The poster domain must be **verified in the TikTok developer portal**. Until TikTok audits the app, posts go to the inbox as drafts. |

## Departments, analytics and attribution

| Call | Returns |
|---|---|
| `GET /admin/executive` | Six departments (`marketing`, `pr`, `affiliates`, `publishing`, `automation`, `revenue`), each with `status` (`ok`, `attention`, `blocked` or `off`), `headline`, `facts` and `next`. Also `exceptions[]` and `autonomy.{automatic,needsOwner,notConnected}`. |
| `GET /admin/research?track=pr\|affiliate&genre=` | Researched shows: published contact (with source), evidence, outcome and `draftId`. |
| `GET /admin/email/sandbox` | Sandbox outbox. Every message has `sent:false` and `network:false`. |
| `POST /admin/synthetic/journey` · `GET /admin/attribution` | Synthetic test lane: click → registration → test payment → entry → exactly one credit. Real payments are not connected. |
| `GET /admin/overview`, `/admin/status`, `/admin/funnel`, `/admin/analytics`, `/admin/alerts`, `/admin/jobs`, `/admin/runs`, `/admin/reports`, `/admin/audit` | Unchanged. |

## Fail-closed switches (isolated project environment)

| Variable | Staging value | Effect |
|---|---|---|
| `GROWTH_SOCIAL_PROVIDER` | `sandbox` | Posts are simulated, with receipts. Real posting needs `live` **plus** owner approval flags and per-channel credentials. |
| `GROWTH_DELIVERY_PROVIDER` | `sandbox-capture` | Emails are built and stored, never sent. |
| `GROWTH_POSTERS` | `on` | Generates posters. |
| `GROWTH_ART_CLOUDINARY_CLOUDS` | `daflot6fo,dqi6vk2vn` | The only clouds fighter art is taken from. |
| `GROWTH_SOCIAL_LIVE_TEST_APPROVED` | (unset) | The controlled live test stays off. |

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
| `POST /admin/logout` | none; `Authorization: Bearer <Growth session>` | `{ok, revoked}`; ends that session on the server |
| `GET /admin/session` | | `200` while the token is valid; includes `method` (`website_admin` or `console_password`) and `scope` |

- Send `Authorization: Bearer <token>` on every `/admin/*` call.
- `401` means sign in again. Tokens issued before a password change are refused.
- **Website administrator sign-in (no second password): see "First-party administrator session" below.** The website administrator token is never sent to this engine.
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
| `GROWTH_SSO` | (unset = on) | `off` turns website-administrator sign-in off (rollback). The Growth Engine password keeps working. |
| `GROWTH_SSO_SITE_PUBLIC_KEY` | Ed25519 public key (PEM or base64 PEM) | Verifies the website server's assertions. Not secret. Without it, website sign-in is off. |
| `GROWTH_SSO_SITE_ORIGINS` | (unset = `GROWTH_CONSOLE_EMBED_ORIGINS`) | Website origins an assertion may name. |
| `GROWTH_SSO_ALLOWED_ADMINS` | (optional) | Comma-separated admin emails or ids allowed into the Growth Engine. |
| `GROWTH_SOCIAL_LIVE_TEST_APPROVED` | (unset) | The controlled live test stays off. |

## First-party administrator session (website sign-in, no second password)

The website administrator token never leaves the website and its live backend. The flow:

1. **Browser → website (same origin).** The back-office page sends `POST /api/admin/growth-session` with body `{}`, its usual `Authorization: Bearer <website admin token>`, `credentials: same-origin` and redirects forbidden.
2. **The website server** (fmm-ver2 `src/server/growthSessionBridge.cjs`):
   - refuses any request whose `Origin` is not the site itself (403 `cross_origin_refused`), any `Sec-Fetch-Site` other than `same-origin`, non-JSON bodies (415) and other methods (405);
   - rate-limits to 20 per address per minute (429);
   - checks the admin token's shape and age (HS256, `{id, email}`, ≤ 12 h, not expired, no `aud`/`role`/`scope`);
   - asks the live admin authority whether it accepts the token right now: read-only `GET /api/admin/matches/<all-zero id>` must return `404`, not `401`. With `JWT_SECRET_ADMIN` set on the website, the signature is also checked;
   - applies the optional allow-list.
3. **Website server → engine (server to server)** `POST /api/growth/admin/sso/assertion` with `{assertion}`. The assertion is an Ed25519-signed compact JWS:
   - header `{alg:'EdDSA', typ:'fmm-admin-assertion+jwt', kid}`;
   - claims `{iss:'fmm-admin-site', aud:'fmm-growth-engine', purpose:'session', sub:<admin id>, email, site:<website origin>, jti:<random>, iat, exp:iat+60, adminExp, verifiedBy:'live-admin-authority'}`.
   It contains no administrator token.
4. **The engine:**
   - refuses browser-originated calls (an `Origin` header gives 403 `server_to_server_only`);
   - checks the signature with `GROWTH_SSO_SITE_PUBLIC_KEY`, plus issuer, audience, purpose, site origin, lifetime ≤ 120 s and expiry;
   - **consumes the nonce once.** Nonces are stored in `growth_sso_nonces` with a TTL, so a replay gets `assertion_replayed`;
   - applies the allow-list and audits `sso_login`;
   - returns `{ok, token, expiresAt (ms), expiresInSeconds, admin:{email}, method:'website_admin'}`.
5. **Website → browser:** `{ok, token, expiresAt (epoch ms), engineOrigin, admin:{email}, method}`. The Growth session has:
   - `aud fmm-growth-console`, `scope growth` and its own key, so it is useless on the live backend;
   - a lifetime of at most 30 min, never past the website session;
   - a revocable session id `sid`.

Refusals:

| Status | Website endpoint | Engine |
|---|---|---|
| 401 | `administrator_session_required`, `not_an_administrator_session`, `administrator_session_expired`, `administrator_session_too_old`, `administrator_session_rejected` | `assertion_*`, `website_admin_session_expired` |
| 403 | `cross_origin_refused`, `admin_not_allowed_for_growth_engine` | `server_to_server_only`, `admin_not_allowed_for_growth_engine` |
| 429 | `too_many_attempts` | |
| 503 | `growth_session_bridge_not_configured`, `admin_authority_unreachable`, `admin_authority_unexpected_<n>`, `growth_engine_unavailable` | `sso_not_configured` |

The earlier direct route `POST /admin/sso` now answers `410 direct_admin_token_exchange_removed` and does not read the header.

**Logout and revocation**
- **Back-office logout.** The browser sends:
  - `POST /api/growth/admin/logout` to the engine with the Growth session only, which revokes that `sid`;
  - `DELETE /api/admin/growth-session` to the website. The website verifies the admin as above and sends a signed `purpose:'revoke'` assertion to `POST /api/growth/admin/sso/revoke`, which ends every Growth session of that administrator issued up to that millisecond.
- **Console sign-out** revokes its own session.
- Revoked sessions get `401` with reason `session_revoked` or `signed_out_of_website`. Revocations are stored in `growth_session_revocations` with a TTL.

**Console messages (iframe ↔ back office)**
- Parent → child, sent only to the exact engine origin:
  - `{type:'fmm-growth-session', token}`;
  - `{type:'fmm-growth-logout'}`, which makes the console revoke and forget its session.
  The child accepts these only from `window.parent` and only from an origin on its embed list.
- Child → parent: `{type:'fmm-growth-console', section, signedIn, event?, reason?, expiresAt?}`, where `event` is one of:
  - `session-ready` (with `expiresAt` in ms);
  - `session-expired` (with a reason): the parent renews from the administrator session, at most once per 30 s;
  - `signed-out`: the parent stays signed out.

**Settings**
- **Website, server-only:**
  - `GROWTH_SSO_SITE_PRIVATE_KEY` (secret, Ed25519);
  - optional: `GROWTH_ENGINE_SERVER_URL`, `FMM_ADMIN_VERIFY_URL` (must be an FMM backend host), `GROWTH_SITE_ORIGINS`, `GROWTH_SSO_ALLOWED_ADMINS`, `JWT_SECRET_ADMIN`, `GROWTH_SSO=off`.
- **Website, public:** `NEXT_PUBLIC_FMM_GROWTH_SESSION_PATH=/api/admin/growth-session`.
- **Engine:** `GROWTH_SSO_SITE_PUBLIC_KEY` and the website origin in `GROWTH_CONSOLE_EMBED_ORIGINS`.

**Rollback:** `GROWTH_SSO=off` on either side, or unset the session path. The Growth Engine password keeps working.

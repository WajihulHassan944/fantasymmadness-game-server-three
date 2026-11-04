# Isolated TikTok + X OAuth Preview

This branch is Preview-only. Do not merge or promote it to production. The existing Vercel entry point delegates immediately to `growth-social-oauth-preview.js` only for the isolated project, Preview environment, and explicit feature flag. It exits before loading the legacy game server or scheduling any jobs. The default Vercel configuration is preserved. Only `/api/growth/*` is reachable. The runtime verifies the dedicated Vercel project, Preview environment, pinned Atlas configuration, and database `fmgrowthtest`.

## Back office and callbacks

Open the stable Preview alias (not an immutable deployment hostname):

`https://fantasymmadness-growth-git-585652-kelly-davis-projects-6c108d0b.vercel.app/api/growth/console`

Register these **exact** redirect URLs in the provider developer consoles:

- TikTok: `https://fantasymmadness-growth-git-585652-kelly-davis-projects-6c108d0b.vercel.app/api/growth/social/tiktok/callback`
- X: `https://fantasymmadness-growth-git-585652-kelly-davis-projects-6c108d0b.vercel.app/api/growth/social/x/callback`

Provider dashboard registration and a real account owner's consent cannot be inferred from an HTTP 200, a build, or the presence of credentials.

## Branch-scoped Vercel Preview configuration

Preserve all production settings. Scope the following to Preview / branch `feature/growth-social-oauth-isolated`:

- `GROWTH_SOCIAL_OAUTH_ENABLED=true`
- `GROWTH_SOCIAL_PUBLIC_ORIGIN=https://fantasymmadness-growth-git-585652-kelly-davis-projects-6c108d0b.vercel.app`
- `GROWTH_SOCIAL_PROVIDER=none`, `GROWTH_DELIVERY_PROVIDER=none`, `GROWTH_OUTBOUND_ENABLED=false`
- `GROWTH_SOCIAL_TOKEN_KEY`: existing 32 random bytes, base64, server-only secret.
- `GROWTH_TIKTOK_CLIENT_KEY` and `GROWTH_TIKTOK_CLIENT_SECRET`: existing isolated TikTok app credentials; never expose the secret in browser code.
- `GROWTH_X_CLIENT_ID` and `GROWTH_X_CLIENT_SECRET`: confidential X OAuth 2.0 application credentials. Missing values produce an explicit disabled Connect control. No credentials are invented.
- Optional `GROWTH_TIKTOK_REDIRECT_URI`: must equal the exact derived callback, otherwise authorization is refused.
- Optional verified `GROWTH_TIKTOK_EXPECTED_OPEN_ID` / `GROWTH_X_EXPECTED_USER_ID`: extra pins; an Open ID is **not required before the first TikTok authorization**.

Existing isolated runtime configuration is still required: `GROWTH_STAGING_MODE=isolated`, isolated `MONGODB_URI`, `GROWTH_TEST_ATLAS_HOST`, `JWT_SECRET_ADMIN`, `CRON_SECRET`, `GROWTH_UNSUBSCRIBE_SECRET`, and the existing `GROWTH_ADMIN_PASSWORD_HASH` for the administrator console. No password or secret should be pasted into an issue or chat.

## Security and confirmation flow

1. Sign into the isolated connection back office with the existing Growth console administrator credential. Only dedicated audience/issuer/role-bound Growth sessions are accepted. Raw website administrator or player JWTs are rejected. Login is rate limited; logout revokes that session and cancels its unfinished authorizations.
2. Connect issues a random, hashed, ten-minute, single-use state bound to that session and an HttpOnly / Secure / SameSite=Lax host-only browser cookie. X additionally uses S256 PKCE and confidential-client Basic authentication.
3. The callback atomically consumes the matching state and browser binding. It exchanges the authorization code using a fixed provider endpoint, exact callback, timeout, and redirect refusal.
4. TikTok **must** supply a valid `open_id` in both the token response and authenticated user-info response. They must match; no fallback accepts an unverified identity. X must return a valid account ID and username `FMmadness2024` (case-insensitive exact match).
5. No credentials enter MongoDB before administrator confirmation. Provider-verified credentials travel in a five-minute AES-256-GCM encrypted HttpOnly cookie; Mongo stores only candidate identity metadata and a digest of that sealed transport. Oversized responses fail closed rather than persisting unconfirmed credentials.
6. The initiating administrator confirms the displayed provider profile and ID. Only then are credentials AES-GCM encrypted into `growth_social_accounts`. The confirmed identity is pinned for future reconnects. Unconfirmed legacy records are not trusted as verified connections.
7. X refresh tokens are rotated (or retained when rotation omits one), with a fresh identity/username check before encrypted storage changes. Refresh is administrator-triggered, concurrency-locked and cannot resurrect a disconnected account. Disconnect removes credentials and invalidates unfinished flows while preserving the verified account pin.

TikTok identity-only scope: `user.info.basic`. Its basic user-info response does not establish the public handle by itself: the administrator must select `@fantasy.mmadness` at TikTok and confirm the returned profile/Open ID. X scopes: `tweet.read users.read offline.access`; **no write scope**. Both return `publishingEnabled:false`. This Preview exposes no publishing, payment, legacy user-directory or scheduler endpoints, and does not pass OAuth tokens to publishing workers.

## Verification

Run against a fresh loopback-only MongoDB, never the remote database:

```
npm ci --ignore-scripts
GROWTH_TEST_MONGO_URI=mongodb://127.0.0.1:27017/fmgrowthtest node growth-social-oauth-isolated.test.js
GROWTH_TEST_MONGO_URI=mongodb://127.0.0.1:27017/fmgrowthtest node growth-social-oauth-preview.test.js
npx playwright install chromium
GROWTH_TEST_MONGO_URI=mongodb://127.0.0.1:27017/fmgrowthtest node growth-social-oauth-console.browser.test.js
```

These tests use real local MongoDB and a real browser, with provider responses mocked. They do not constitute real TikTok/X authorization. CI runs the same isolation, security and browser checks without provider secrets. Real provider consent, callback allowlisting and X developer credentials must be verified separately before claiming real accounts connected.

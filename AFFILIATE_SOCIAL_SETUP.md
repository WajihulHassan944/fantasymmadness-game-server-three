# Affiliate social publishing setup

The affiliate fight share kit supports account connection and direct publishing after the following backend settings are configured. No platform credentials or tokens are sent to the browser.

| Setting | Purpose |
| --- | --- |
| `SOCIAL_TOKEN_ENCRYPTION_KEY` | 32 random bytes encoded as 64 hex characters; keep stable across deployments. |
| `SOCIAL_CALLBACK_BASE_URL` | Public HTTPS origin of the game API, without a trailing slash. |
| `PUBLIC_APP_URL` | Public HTTPS origin of the website; defaults to `https://www.fantasymmadness.com`. |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | X OAuth 2.0 application credentials. Request `tweet.read tweet.write users.read offline.access`. |
| `META_APP_ID`, `META_APP_SECRET` | Meta application credentials with reviewed Pages and Instagram permissions. |

Register these exact callback URLs in the respective developer applications:

- `${SOCIAL_CALLBACK_BASE_URL}/api/affiliates/social/x/callback`
- `${SOCIAL_CALLBACK_BASE_URL}/api/affiliates/social/facebook/callback`
- `${SOCIAL_CALLBACK_BASE_URL}/api/affiliates/social/instagram/callback`

For Facebook, a member connects a Page they manage. Meta does not offer general direct publishing to personal timelines. For Instagram, the member connects a professional account linked to a Facebook Page, and the fight must have a public HTTPS poster image. The direct Instagram post uses that poster with the tracked link in its caption; caption links are generally not clickable. For a QR image on Instagram, the existing download and manual post flow is available.

The backend records a publication per affiliate, fight, and platform. A confirmed post cannot be published twice. If the platform response is ambiguous, the delivery enters `review` so the affiliate checks their social account before another attempt. Publishing permissions depend on the external app review and account eligibility. X API usage may carry platform charges.

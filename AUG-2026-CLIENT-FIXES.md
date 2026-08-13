# August 2026 client fixes

## Production changes

- Calendar-only combat dates now retain an explicit `matchDateKey` such as `2026-08-15`. New and edited fight dates are normalized without shifting the day for viewers in another time zone.
- Public fight payloads now expose the saved contest fee, saved prize pool, submitted-entry count, round count, exact date key, venue, and available fight/fighter artwork. No pool, fee, or entry count is invented by the API.
- The public leagues endpoint returns database leagues and members only. Empty and error states no longer substitute demo leagues.
- New-user registration and first Google sign-in grant the specified one-time 500 FM welcome balance on the server.
- The FM coin cart supports only the three server-priced packs: 1,000 FM / $0.99, 5,000 FM / $3.99, and 15,000 FM / $9.99.
- Checkout creation requires an idempotency key, ignores all client-reported pricing, and creates an Authorize.Net Accept Hosted form token. The signed webhook verifies the authoritative transaction and paid amount before a MongoDB transaction credits the wallet.
- A player's first confirmed coin purchase receives a one-time server-enforced 2× coin credit. A logged-out purchaser gets a player account, the 500 FM welcome credit, and a single-use password-set email only after confirmed payment.
- Apparel is deliberately excluded from the FM cart. Merchandise continues to link to Etsy.

## Deployment requirements

Set `AUTHORIZE_NET_ENVIRONMENT`, `AUTHORIZE_NET_API_LOGIN_ID`, `AUTHORIZE_NET_TRANSACTION_KEY`, `AUTHORIZE_NET_SIGNATURE_KEY`, `PUBLIC_APP_URL`, `JWT_SECRET`, and working SMTP credentials. Register `POST /api/webhooks/authorize-net` for `net.authorize.payment.authcapture.created`. Keep live secrets only in the deployment host's encrypted environment settings.

The wallet settlement uses a MongoDB transaction and therefore requires a replica-set deployment such as MongoDB Atlas.

## Fight-information ingestion status

The repository includes controlled UFC event discovery, feed quality checks, and swarm automation hooks. It is not a complete, autonomous scraper for every promotion or every live statistic. Deploying this backend does not by itself guarantee all new fight information: source credentials/jobs must be configured, discovered records must pass validation, and sources with access/licensing restrictions still require an approved integration.

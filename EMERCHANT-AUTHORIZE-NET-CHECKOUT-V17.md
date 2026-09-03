# eMerchant Authority / Authorize.Net checkout update (v17)

The existing payment gateway was identified as Authorize.Net. The new cart now
uses Authorize.Net Accept Hosted, so payment-card data is entered on the hosted
processor page and is never submitted to or stored by Fantasy MMAdness.

## Deployment configuration

Copy the variable names from `.env.authorize-net.example` into the backend host's
encrypted environment settings. Do not commit live gateway credentials.

Create an Authorize.Net webhook for
`net.authorize.payment.authcapture.created` pointing to:

`POST https://YOUR-BACKEND-HOST/api/webhooks/authorize-net`

The webhook verifies `X-ANET-Signature`, fetches the authoritative transaction,
checks invoice and amount, and credits the wallet idempotently.

## Compatibility and safety

- Billing name/address fields remain supported for the client account form.
- Legacy raw-card routes return HTTP 410 and cannot charge or reuse stored cards.
- Coin pack prices and credits are calculated on the server.
- The 30-day FM+ pass works through hosted checkout.
- FM+ monthly auto-renew is displayed as coming soon until recurring billing is
  explicitly enabled and implemented for this merchant account.
- The former Kurv webhook remains only for already-created legacy orders; new
  orders are always created with `provider: authorize-net`.

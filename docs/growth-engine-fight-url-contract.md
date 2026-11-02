# Growth Engine ↔ website: fighter-name fight URLs

The Growth Engine does **not** build fighter-name URLs itself. It asks the website for each
verified fight's address and uses whatever the website says. Implemented in
`growth-fight-urls.js` (branch `test/growth-backoffice-console`).

## What the Growth Engine reads (any one is enough, in this order)

1. **Feed field (optional):** `canonicalUrl` or `canonicalPath` on a fight in the public contest
   feeds (`/api/public/prediction-fights`, `/api/public/pro-wrestling/matches`).
2. **Redirect:** `GET https://www.fantasymmadness.com/fight/<id>` answers `301/308` with
   `Location: /fight/<fighter-name-path>` (pro wrestling: `/pro-wrestling/play/<id>`).
3. **Canonical tag:** the `/fight/<id>` page contains
   `<link rel="canonical" href="https://www.fantasymmadness.com/<fighter-name-path>">`.

## What the website needs to keep true

| Requirement | Why |
|---|---|
| `GET <clean URL>?play=1` returns **200** with the fight's contest | The engine verifies this before using a clean URL |
| The clean URL keeps every query parameter: `play=1`, `ref=<affiliate id>`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` | Affiliate credit and campaign attribution |
| `ref=` **with** `play=1` stays on the fight (only `ref=` **without** `play=1` goes to the affiliate league, as `/fight/<id>` does today) | Affiliate player links |
| `/fight/<id>` and `/pro-wrestling/play/<id>` keep working (redirect is fine) | Fallback, and posts already published |
| The clean URL is on `https://www.fantasymmadness.com` (or the bare domain), and is not `/league`, `/affiliate`, `/login` | Anything else is ignored |

## How the Growth Engine uses it

- Facebook, Instagram and X posts use `<clean URL>?play=1&utm_…` (pro wrestling: no `play=1`).
  TikTok shows the readable `fantasymmadness.com/<path>` (TikTok captions are not clickable).
- Affiliate-credited posts: `<clean URL>?play=1&ref=<live affiliate id>&utm_…`.
- Addresses are re-checked every 6 hours. Open campaigns switch automatically when a clean
  URL appears, and switch back to the ID address if it stops loading. Scheduled posts get the
  current address when they are sent.
- `GROWTH_FIGHT_URL_DISCOVERY=off` keeps ID addresses only.

# Rotating the leaked secrets

The old `JWT_SECRET` and `JWT_SECRET_ADMIN` were committed to git. Every clone of
the repository contains them, and deleting the file does not help — git keeps
every version of every file. Anyone holding those values can forge a valid
session for any account, including admin, without a password.

Replacement values were generated and handed over in chat, not written to any
file in this project. **If they were pasted anywhere shared, generate your own
instead** (see step 1).

---

## 1. Generate values (only if you need fresh ones)

```bash
# run five times, once per secret
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Five separate secrets, all different from one another:
`JWT_SECRET`, `JWT_SECRET_ADMIN`, `JWT_SECRET_OWNER`, `CRON_SECRET`,
`ACTION_LINK_SECRET`.

## 2. Set them in the hosting platform — not in a file

Vercel: **Project → Settings → Environment Variables**, scope Production.
Never in `.env`, never in the repo. `.env.example` in this folder documents the
full list with no values; it is safe to commit.

## 3. Redeploy

The boot guard verifies the result. In production the server refuses to start if
any required secret is missing, shorter than 32 characters, a known placeholder,
or if `JWT_SECRET` and `JWT_SECRET_ADMIN` are identical. A clean start is the
confirmation that rotation worked.

## 4. Expect everyone to be signed out once

Every existing session was signed with the old secret, so all of them stop
working the moment you deploy. That is the objective, not a side effect: any
session signed with a leaked secret should be treated as untrustworthy.

**Do this at a quiet hour, never during a fight card.** Players will simply log
in again. Admins too — and the owner view will ask for a fresh email code.

## 5. Update the scheduler

Whatever runs your cron jobs must now send the new `CRON_SECRET` as an
`x-cron-secret` header. Until it does, those endpoints correctly return 503.

## 6. Confirm

- Server started with no `FATAL:` line
- `GET /api/health/db` returns 200
- Log in as a player, an admin, and at `/owner`
- Trigger one cron endpoint and confirm it is no longer 503

---

## Optional: purge the old values from git history

Rotation makes the leaked values worthless, so this is housekeeping rather than
urgent. If you want them gone from the history anyway, `git filter-repo` (or the
BFG) can strip the file, but it **rewrites history** — every collaborator must
re-clone. Do not attempt it during launch week. Rotating is what actually closes
the hole.

## Going forward

- Secrets live in the hosting platform's environment settings, nowhere else.
- `.gitignore` in this folder already excludes `.env` and `.env.*`.
- If a secret is ever pasted into a chat, ticket, or email, treat it as leaked and rotate it.

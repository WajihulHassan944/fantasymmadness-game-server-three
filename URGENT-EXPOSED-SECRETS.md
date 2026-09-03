# URGENT — exposed secrets in the backend repo

`.env` (2,616 bytes) is **committed** to `WajihulHassan944/fantasymmadness-game-server-three`. Anyone with repo access — now or in the past — has every credential in it.

I've updated `.gitignore` (in this folder) to stop it happening again. **The rest only you can do**, because it needs git history rewriting and access to your hosting dashboard.

---

## Why gitignore alone is not enough

Adding `.env` to `.gitignore` stops *future* commits. It does **not** remove the file from the repo, and it does **not** remove it from git history. The secrets stay readable in every past commit until you rewrite history — and even then, assume they've been seen.

**The only thing that truly protects you is rotating the secrets.** Everything else is cleanup.

---

## Step 1 — stop tracking the file

```bash
cd fantasymmadness-game-server-three
# copy the new .gitignore from this folder over yours first
git rm --cached .env
git commit -m "Stop tracking .env"
git push
```

Your local `.env` stays; git just stops watching it.

## Step 2 — rotate every secret in it

Do this even if the repo is private. Based on what `server.js` reads, at minimum:

| Variable | Where to rotate | Effect of rotating |
| --- | --- | --- |
| `JWT_SECRET` | Generate a new random string | **All users are logged out** — they sign in again |
| `JWT_SECRET_ADMIN` | Generate a new random string | Admin sessions end |
| MongoDB connection string | Atlas → Database Access → edit password | Update the app immediately or it drops offline |
| Payment processor keys | Processor dashboard | Old keys stop working |
| Mail credentials | Mail provider | Old credentials stop working |
| Cloudinary / ImgBB keys | Their dashboards | Uploads fail until updated |
| `GOOGLE_CLIENT_ID` / secret | Google Cloud Console | Google sign-in breaks until updated |

Generate a strong secret:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**`JWT_SECRET` matters most here** — it signs the tokens the new authenticated entry endpoint depends on. If someone has it, they can mint a token for any user and enter fights as them.

Rotating logs everyone out. That's the correct trade, and doing it during a quiet period is the only scheduling decision.

## Step 3 — move the values into your host

Set them as environment variables in your hosting dashboard (Vercel → Settings → Environment Variables) rather than in a file. Redeploy.

## Step 4 — commit a template, not the values

```bash
# .env.example — safe to commit, names only, no values
JWT_SECRET=
JWT_SECRET_ADMIN=
MONGODB_URI=
```
The updated `.gitignore` already allows `.env.example` through.

## Step 5 (optional) — purge from history

```bash
npx git-filter-repo --path .env --invert-paths
git push --force
```

Rewrites history for everyone with a clone. **Do Step 2 first regardless** — if the secrets are rotated, what's in the history is worthless.

---

## Order that matters

1. Rotate the secrets (Step 2) — this is the actual fix
2. Update your host's env vars and redeploy (Step 3)
3. Then the git cleanup (Steps 1, 4, 5) at your own pace

If you only do one thing today, rotate `JWT_SECRET`.

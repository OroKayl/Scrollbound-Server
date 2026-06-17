# Scrollbound — Deploy Guide (word-for-word, no terminal needed)

Goal: get the server live on a public URL using **GitHub** (to hold the code) + **Railway** (to run it). ~20 minutes. Cost: Railway Hobby is ~$5/month for always-on.

---

## PART 1 — Put the code on GitHub

1. Go to **github.com** and sign up (or log in).
2. Click the **+** (top-right) → **New repository**.
3. Repository name: `scrollbound-server`. Leave it **Public** (or Private, your call). Click **Create repository**.
4. On the next page, click the link **"uploading an existing file"** (it's in the line "…or push an existing repository… / uploading an existing file").
5. Open your `Desktop\Eclipse new\server` folder on your PC.
6. Select these and **drag them into the GitHub upload box**:
   - `server.js`
   - `package.json`
   - `Dockerfile`
   - `README.md`
   - `.gitignore`
   - the **`public`** folder (drag the whole folder — it contains `index.html`, the game)
7. Wait for them to finish uploading (the `public/index.html` is ~165 KB, takes a few seconds).
8. Click the green **Commit changes** button.

> If dragging the `public` folder doesn't bring `index.html`: open the repo, click **Add file → Upload files**, then drag the `public` folder again, or create it manually (Add file → Create new file → type `public/index.html` → paste the game's contents).

---

## PART 2 — Run it on Railway

1. Go to **railway.app** → **Login** → choose **Login with GitHub** (easiest). Approve access.
2. Click **New Project** → **Deploy from GitHub repo**.
3. If asked, click **Configure GitHub App** and give Railway access to your `scrollbound-server` repo, then come back.
4. Pick **scrollbound-server** from the list. Railway starts building automatically (it sees Node and runs `npm start`).
5. While it builds, click the service box → **Variables** tab → **New Variable**, add:
   - Name `INVITE_CODE`  Value `pick-a-secret-word` (this is what friends type to log in)
   - Name `SIEGE_MINUTES`  Value `60`  (use `10` while testing so sieges happen often)
6. Go to the **Settings** tab → **Networking** → **Generate Domain**. Railway gives you a public URL like `scrollbound-server-production.up.railway.app`.
7. Open that URL in your browser — the game should load. 🎉
8. If it asks you to add a plan: choose **Hobby ($5/mo)** for always-on (the free trial sleeps/expires).

---

## PART 3 — Share with friends

- Send friends the **URL** + the **invite code** you set.
- (Right now the game still plays solo on that URL — the multiplayer login/shared-world wiring, "Phase B", lands next. Once Claude finishes it, you re-do Part 1 step 6–8 with the new `index.html` and Railway auto-redeploys.)

---

## Updating later (after Phase B or any change)

1. In your GitHub repo, open the file you changed (e.g. `public/index.html`) → click the **pencil** (Edit) → or use **Add file → Upload files** to replace it → **Commit changes**.
2. Railway auto-redeploys within a minute. Done.

## Heads-up: saves reset on redeploy
The server stores data in a file on the container, which Railway wipes when it redeploys. Fine for early testing. To keep saves permanently we'll add a Railway **Volume** (or a database) — ask Claude when you want that.

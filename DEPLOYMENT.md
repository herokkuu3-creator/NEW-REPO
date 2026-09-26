# Deploying the LeetCode Daily Agent to Render's Free Tier

A complete, from-scratch procedure: fresh clone → running, self-scheduling automation service on Render's Hobby plan at **zero monthly cost**.

- **Target platform:** Render Hobby (free)
- **Service type:** Free Web Service (Docker)
- **Database:** Render Postgres (free) or an external free Postgres
- **Solution source:** walkccc.me C++ solutions — **no LLM key required** by default
- **Estimated time:** 45–60 minutes, mostly waiting on builds

> Limits and endpoints in this guide were verified against [Render's free-tier docs](https://render.com/docs/free) in September 2026. If a value ever disagrees with the current docs, the docs are right — and the only place to change it is `render.yaml`.

## Contents

1. [What you are deploying, and why it looks this way](#1-what-you-are-deploying-and-why-it-looks-this-way)
2. [Prerequisites and accounts](#2-prerequisites-and-accounts)
3. [Step 1 — Get the repository onto GitHub](#3-step-1--get-the-repository-onto-github)
4. [Step 2 — Collect the three secrets](#4-step-2--collect-the-three-secrets)
5. [Step 3 — Create the authenticated session locally](#5-step-3--create-the-authenticated-session-locally)
6. [Step 4 — Deploy with the Render Blueprint](#6-step-4--deploy-with-the-render-blueprint)
7. [Step 5 — Enter the secret environment variables](#7-step-5--enter-the-secret-environment-variables)
8. [Step 6 — Confirm the service booted and migrated](#8-step-6--confirm-the-service-booted-and-migrated)
9. [Step 7 — Upload the session to the database](#9-step-7--upload-the-session-to-the-database)
10. [Step 8 — Smoke-test a full run](#10-step-8--smoke-test-a-full-run)
11. [Step 9 — Wire up the daily scheduler](#11-step-9--wire-up-the-daily-scheduler)
12. [Step 10 — Verify end to end](#12-step-10--verify-end-to-end)
13. [Ongoing maintenance: the 30-day database expiry](#13-ongoing-maintenance-the-30-day-database-expiry)
14. [Troubleshooting reference](#14-troubleshooting-reference)
15. [Go-live checklist and free-tier limits](#15-go-live-checklist-and-free-tier-limits)

---

## 1. What you are deploying, and why it looks this way

The application is a long-lived Node service that wakes on a schedule, drives a headless Chromium browser against your already-authenticated LeetCode session, finds today's Daily Challenge through LeetCode's own GraphQL, fetches the curated C++ solution from walkccc.me by question number, and — depending on one flag — either fills the editor or submits and records the judge's verdict.

Render's free tier dictates the shape of the deployment in four specific ways:

| Free-tier reality | How this repository responds |
|---|---|
| Background Workers and Cron Jobs are **paid-only**. Free accounts get web services, Postgres, Key Value, static sites. | The service is a **free Web Service** that binds `$PORT` and runs its own internal cron scheduler. |
| Free web services **cannot attach persistent disks** and have **no shell access**. | Every durable byte lives in **PostgreSQL** — including the browser session, uploaded over HTTPS. |
| Free web services **spin down after 15 idle minutes** and lose their filesystem on spin-down. | A free external monitor keeps it awake (or wakes it once a day); all run state is in Postgres. |
| Free Postgres **expires 30 days after creation**. | Recovery is documented in §13, plus an optional switch to a non-expiring external free Postgres. |

> **Cost.** The Blueprint provisions one free web service and one free Postgres database. Everything stays inside the free plan; no payment method is required. With the default `SOLUTION_SOURCE=walkccc`, there is no LLM bill either — the only thing you ever provide is your LeetCode login, once.

## 2. Prerequisites and accounts

| Requirement | Notes |
|---|---|
| Node.js 22+ | Only on your own machine, for the one-time login step. Check with `node -v`. |
| Git | To push the repository somewhere Render can read. |
| GitHub or GitLab account | Render deploys from a connected repository. |
| Render account (Hobby, free) | Sign up with GitHub so the repository connection is immediate. |
| Your LeetCode account | You log in interactively, once. |
| Telegram bot (strongly recommended) | Two minutes to set up, and it is your only alerting channel on a headless free service. |
| Docker Desktop | Optional — only for testing the full stack locally first. |

## 3. Step 1 — Get the repository onto GitHub

Unpack the archive and initialise a repository. The bundled `.gitignore` already excludes secrets and the browser session artifacts, so a careless `git add -A` cannot leak your login.

```bash
unzip leetcode-daily-agent.zip
cd leetcode-daily-agent

git init
git add -A
git commit -m "Initial commit: LeetCode daily agent"
```

Create the remote repository and push — with the GitHub CLI, one command:

```bash
gh repo create leetcode-daily-agent --private --source=. --push
```

Without the CLI, create an empty **private** repository in the GitHub web UI, then:

```bash
git remote add origin https://github.com/<your-username>/leetcode-daily-agent.git
git branch -M main
git push -u origin main
```

> **Keep it private.** A public repo leaks no secrets by itself, but your automation's existence and run history don't need to be public.

Confirm nothing sensitive was tracked:

```bash
git ls-files | grep -E "\.env$|storage-state|browser-profile" || echo "clean - no secrets tracked"
```

## 4. Step 2 — Collect the three secrets

Render's Blueprint marks these as `sync: false` — Render deliberately does not read them from the repo; you type them into the dashboard once. With the default walkccc solution source, **no LLM key is needed** — only these three.

### 4.1 Telegram bot token and chat ID

Open **@BotFather** in Telegram, send `/newbot`, follow the prompts. BotFather returns a token like `123456789:AA...`. Then send your new bot any message and read back the chat ID:

```bash
curl -s "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"
```

`result[0].message.chat.id` is your `TELEGRAM_CHAT_ID`. If the array is empty, send the bot another message and retry — a bot can't see a chat until someone speaks in it.

> **Why this matters more on the free tier.** The service runs headless and on-disk diagnostics evaporate at the next spin-down. The Cloudflare screenshot is therefore pushed to Telegram — it is the one piece of evidence that survives.

### 4.2 SETUP_TOKEN

A long random string protecting the admin endpoints:

```bash
openssl rand -hex 32
```

Store it somewhere reachable — you'll use it in Steps 7, 8 and 9.

### 4.3 (Optional) Gemini API key — only if you switch to LLM solving

Skip this entirely for the default setup. If you later set `SOLUTION_SOURCE=llm`, get a free key from [Google AI Studio](https://aistudio.google.com/apikey), and check which models it can access:

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY" \
  | grep -o '"name": "models/[^"]*"' | sort
```

## 5. Step 3 — Create the authenticated session locally

The only step on your own machine, and the only time your password is involved anywhere. It happens in a browser window you control; the script never sees or stores credentials.

```bash
npm install
npx playwright install chromium
npm run auth:setup
```

A headed Chromium window opens on the LeetCode login page. Log in as you normally would — password, Google, passkey. The script polls LeetCode's own status endpoint from inside the page; the moment you're signed in it prints your username, writes two artifacts, and closes:

| Artifact | Role on the free tier |
|---|---|
| `local-auth/storage-state.json` | **The credential that matters.** Small JSON (~10–50 KB), uploaded in Step 7; the service re-saves a fresh copy to the database after every successful run, so rotated cookies are captured automatically. |
| `local-auth/browser-profile/` | Convenience for local/paid use. On the free tier the filesystem is ephemeral — the database copy is authoritative. Do not upload this. |

> **Window timed out?** Nothing is lost — the profile directory persists. Run `npm run auth:setup` again and finish logging in. Ten minutes per attempt.

Sanity-check the artifact (prints counts only, never values):

```bash
node -e "const s=require('./local-auth/storage-state.json'); console.log('cookies:', s.cookies.length, '| origins:', s.origins.length); console.log(s.cookies.some(c=>c.name==='LEETCODE_SESSION') ? 'LEETCODE_SESSION present' : 'WARNING: session cookie missing');"
```

You want `LEETCODE_SESSION present`. If the warning fires, the login didn't complete — rerun this step.

## 6. Step 4 — Deploy with the Render Blueprint

1. Render dashboard → **New** → **Blueprint**.
2. Connect GitHub if prompted, select the `leetcode-daily-agent` repository.
3. Name the Blueprint, keep branch `main`, click **Apply** (or **Create**).

Render reads `render.yaml` and provisions:

| Resource | Configuration from the Blueprint |
|---|---|
| **Web service** (`type: web`) | `plan: free`, Docker runtime, health check on `/health`, single instance |
| **Postgres** (`plan: free`) | 1 GB, wired into the service as `DATABASE_URL` automatically |
| **Public variables** | Schedule, timezone, `LEETCODE_LANGUAGE=cpp`, `SOLUTION_SOURCE=walkccc`, and the rest — preset |
| **Secret variables** | Left empty on purpose; you fill them in Step 5 |

The first build takes several minutes: the Dockerfile is based on Microsoft's official Playwright image because it already contains Chromium and every system library Chromium needs. That size is the price of not fighting missing shared libraries in production — let the build finish rather than assume it hung.

> **Region.** The Blueprint sets `region: frankfurt`. Singapore is also offered and may be closer to you. If you change it, do so before the first deploy and keep the service and database in the same region.

## 7. Step 5 — Enter the secret environment variables

Open the new service → **Environment**. Fill in and save (Render restarts the service):

| Variable | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | From BotFather |
| `TELEGRAM_CHAT_ID` | The numeric chat ID from `getUpdates` |
| `SETUP_TOKEN` | The random string you generated |
| `GEMINI_API_KEY` | **Leave empty** with the default walkccc source. Only set it if you switch `SOLUTION_SOURCE` to `llm`. |

Two settings worth a deliberate decision while you're here:

| Variable | Guidance |
|---|---|
| `AUTO_SUBMIT` | Defaults to `false`. Read the warning below before leaving it there. |
| `RUN_ON_BOOT` | Defaults to `true` — a cold start caused by an external trigger becomes the daily run. Leave it on for the wake-on-trigger pattern (Step 9); harmless either way since the database deduplicates by date. |

> **⚠ `AUTO_SUBMIT=false` does not mean what it means on your laptop.** With `false`, the service fills the editor but never presses Submit — meant to let you review first. On Render, that editor lives inside a headless browser on someone else's machine: you cannot see it, and it is destroyed at the next spin-down. The run will honestly report `SUCCESS` / `EDITOR_FILLED`, but **no challenge will actually be completed**.
>
> Use `false` while validating the pipeline. Once you trust it, set `AUTO_SUBMIT=true` — with walkccc's curated solutions, correctness risk is low, and the judge's verdict is reported to you on Telegram either way.

## 8. Step 6 — Confirm the service booted and migrated

Migrations run automatically in the container's start command, before the app starts — a healthy boot means the schema exists.

```bash
curl -s https://<your-service>.onrender.com/health
```

On a cold start this may take about a minute (Render is spinning the instance up). Give it time before concluding anything is wrong. Healthy:

```json
{
  "status": "ok",
  "service": "leetcode-daily-agent",
  "now": "2026-09-26T07:20:00.000Z",
  "runInProgress": false,
  "authentication": { "status": "unknown", "username": null },
  "lastRun": null,
  "lastError": null
}
```

`authentication: "unknown"` is correct here — the service hasn't looked for a session yet. If the build failed, check the service's **Logs** tab for the migration output.

## 9. Step 7 — Upload the session to the database

This replaces the disk upload a paid tier would use. Free services have no shell, so the session arrives over HTTPS through the protected admin endpoint and lands in Postgres, where it survives every spin-down and redeploy.

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_SETUP_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @local-auth/storage-state.json \
  https://<your-service>.onrender.com/admin/storage-state
```

Success answers with a cookie count matching Step 3's check:

```json
{"ok":true,"stored":"database","cookies":14,"origins":3}
```

> **Do not forget `--data-binary`.** Plain `-d` can mangle the payload. The endpoint validates strictly: a malformed file returns `400`, an absent/wrong token returns `401`. The content is never logged.

## 10. Step 8 — Smoke-test a full run

Trigger the pipeline by hand rather than waiting for the schedule:

```bash
curl -X POST \
  -H "Authorization: Bearer YOUR_SETUP_TOKEN" \
  https://<your-service>.onrender.com/admin/run-now
```

`202 {"started":true}` means the run began; `409` means one is already in progress (the guard working, not an error). Wait a minute or two, then poll:

```bash
curl -s https://<your-service>.onrender.com/health
```

You're looking for `lastRun` to populate, with `authentication.status` flipping to `ok` plus your username. A healthy first run with `AUTO_SUBMIT=false`:

```json
{
  "authentication": { "status": "ok", "username": "your-handle" },
  "lastRun": {
    "date": "2026-09-26",
    "problemSlug": "two-sum",
    "title": "Two Sum",
    "state": "SUCCESS",
    "submissionStatus": "EDITOR_FILLED (AUTO_SUBMIT=false)"
  }
}
```

Every invocation ends in exactly one terminal state, always persisted — nothing fails silently:

| State | Meaning and first action |
|---|---|
| `SUCCESS` | Pipeline completed. With `AUTO_SUBMIT=true` this means the judge accepted the submission. |
| `AUTHENTICATION_REQUIRED` | Stored session missing/expired. Repeat Steps 3 and 7. |
| `CLOUDFLARE_VERIFICATION_REQUIRED` | Verification page appeared (screenshot in Telegram). Complete it once in a normal browser, then repeat Steps 3 and 7. |
| `DAILY_PROBLEM_NOT_FOUND` | LeetCode returned no active daily challenge. Usually transient; retry later. |
| `PROBLEM_PARSE_FAILED` | LeetCode changed a payload shape. Inspect `src/leetcode/parser.ts` and the GraphQL schemas in `src/leetcode/dailyChallenge.ts`. |
| `LLM_ERROR` | Only possible with `SOLUTION_SOURCE=llm` — check key, model name, quota. |
| `SOLUTION_VALIDATION_FAILED` | With walkccc (default): the problem isn't on walkccc yet (brand-new or premium), or its signature mismatched LeetCode's C++ starter. With `llm`: the model failed local validation within `MAX_SOLUTION_RETRIES`. Details are on the run row. |
| `SUBMISSION_ERROR` | The submit interaction failed — usually a LeetCode UI change. Selectors live in `src/leetcode/selectors.ts`. |
| `SUBMISSION_REJECTED` | The judge ran and returned a non-accepted verdict; verdict, runtime and memory are recorded. |

## 11. Step 9 — Wire up the daily scheduler

Free web services sleep after fifteen idle minutes; the internal cron only fires while the process is alive, so something outside Render must bring it back. Pick one pattern (cron-job.org or UptimeRobot are free). Both coexist safely because the database deduplicates by date.

### Pattern A — Keep the service awake, let internal cron fire

A monitor that requests the health endpoint every ten minutes. The service never sleeps, so its own scheduler fires at the configured hour.

- **URL:** `https://<your-service>.onrender.com/health`
- **Method:** `GET`
- **Schedule:** every 10 minutes
- **Expected response:** `200`

Render grants 750 free instance-hours per workspace per month; one always-on service uses at most 744 (24 × 31), so this fits — with no headroom. It buys the simplest mental model: the internal cron at `DAILY_RUN_HOUR:DAILY_RUN_MINUTE` in `TIMEZONE` is the single scheduling source.

### Pattern B — Let it sleep, wake it once a day

One daily job that triggers the run directly. The ping cold-starts the service, and because `RUN_ON_BOOT=true`, boot immediately performs the run; afterwards it idles back to sleep, using almost no instance hours.

- **URL:** `https://<your-service>.onrender.com/admin/run-now`
- **Method:** `POST`
- **Header:** `Authorization: Bearer YOUR_SETUP_TOKEN`
- **Schedule:** daily at 09:00 Asia/Kolkata (match `DAILY_RUN_HOUR` and `TIMEZONE`)
- **Request timeout:** **raise to 120 seconds** — the default is shorter than a cold start and reports a false failure
- **Expected response:** `202`

> **A 202 is the trigger being accepted, not the run finishing.** A full run takes a few minutes — browser launch, session check, solution fetch. Confirm outcomes through `/health` or Telegram, not the trigger's response code.

## 12. Step 10 — Verify end to end

Don't declare success on one green response. Confirm all four signals:

- [ ] **Health endpoint reports authenticated** — `authentication.status` is `ok` with a username.
- [ ] **The run row completed** — `lastRun.state` is a terminal state (`SUCCESS` if all is well) with the expected problem slug and title.
- [ ] **Telegram delivered the summary** — problem, difficulty, language, status, runtime, and the problem link.
- [ ] **The daily trigger is armed** — your cron job shows a recent successful execution, and tomorrow's run is scheduled.

With `AUTO_SUBMIT=true`, the strongest confirmation is LeetCode's own submission history showing an accepted solution for today — the only signal that proves the challenge was genuinely completed.

## 13. Ongoing maintenance: the 30-day database expiry

Free Render Postgres databases expire thirty days after creation (14-day grace, then deletion). The one scheduled chore the free tier imposes.

**Option A — Recreate monthly (stay inside Render).** When Render emails you, delete the expired database, create a fresh free one, re-point `DATABASE_URL`. Migrations recreate the schema on next boot; repeat Step 7 to reload the session. You lose run history, nothing else. Five minutes.

**Option B — Non-expiring external free Postgres (recommended).** Create a free database at a provider whose free tier doesn't expire (e.g. Neon), set its connection string as `DATABASE_URL`, and remove the Render database. Daily traffic is a handful of small queries — comfortably within any free tier — and the monthly chore disappears.

> Whichever you choose, never restore an old database over a newer schema. The container runs `prisma migrate deploy` on boot — migrate forward, never backward.

**Session refreshes** are only needed when the session genuinely dies. Every successful run writes a refreshed session back to Postgres, so ordinary cookie rotation is captured automatically.

## 14. Troubleshooting reference

| Symptom | Cause and action |
|---|---|
| First request hangs, then works | Normal free-tier cold start (~1 minute). Raise the external monitor's timeout to 120 s. |
| Container exits with an invalid-configuration message | The Zod startup check names the offending variable. Fix it in the dashboard — the service refuses to boot on bad config by design. |
| Build takes many minutes | The Chromium base image is large. Let it finish; builds count against monthly pipeline minutes. |
| `401 unauthorized` from an admin endpoint | Missing/mismatched `Authorization: Bearer` vs `SETUP_TOKEN`. |
| `400 invalid storageState payload` | Use `--data-binary`; upload the file exactly as written — never hand-edit it. |
| `authentication_required` after it worked | Session expired. Repeat Steps 3 and 7. Expected occasionally, not a defect. |
| `cloudflare_verification_required` | LeetCode served a verification page (screenshot in Telegram). Complete it once in a normal browser, then Steps 3 + 7. The system never attempts to solve it. |
| `SOLUTION_VALIDATION_FAILED` every day | With the default source, the daily problem likely isn't on walkccc yet (very new or premium). Check `https://walkccc.me/LeetCode/problems/<number>/` manually. If you need same-day coverage for brand-new problems, switch `SOLUTION_SOURCE` to `llm` and set a Gemini key. |
| Chromium crashes mid-run, `Target closed` | The 512 MB ceiling. V8's heap is already capped; if it persists, set `CHROMIUM_SINGLE_PROCESS=true` and redeploy. |
| Everything reset about a month in | Free Postgres expired — §13. |
| Service suspended by Render | Instance-hours exhausted or unusually high outbound traffic. Reduce testing bursts; let the schedule do the work. |
| Editor fill / Submit broke after a LeetCode UI update | Every selector is in `src/leetcode/selectors.ts` with ordered fallbacks. Patch that one file and push — Render redeploys automatically. |

## 15. Go-live checklist and free-tier limits

- [ ] Repository pushed to a private GitHub repo; no secrets tracked.
- [ ] Blueprint applied: one free web service + one free Postgres provisioned.
- [ ] Secrets set in the dashboard: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SETUP_TOKEN` (`GEMINI_API_KEY` left empty unless `SOLUTION_SOURCE=llm`).
- [ ] `/health` returns `status: ok` after a cold start; schema migrated.
- [ ] Session uploaded via `/admin/storage-state`, acknowledged with a cookie count.
- [ ] A smoke-test run reached a terminal state; Telegram delivered the summary.
- [ ] External cron configured: keep-alive every 10 min, or a daily authenticated trigger with a 120 s timeout.
- [ ] Decision recorded on `AUTO_SUBMIT` — `false` only while validating.
- [ ] A reminder exists for the Postgres expiry, or an external non-expiring database is in use.

| Free-tier limit | Value as of September 2026 |
|---|---|
| Web service RAM | 512 MB, single instance, no scaling |
| Idle spin-down | After 15 minutes without inbound traffic; ~1 minute to wake |
| Instance hours | 750 per workspace per calendar month |
| Filesystem | Ephemeral — wiped on spin-down, restart, redeploy |
| Persistent disk | Not available on free |
| Shell access | Not available on free |
| Postgres | 1 GB, expires 30 days after creation |

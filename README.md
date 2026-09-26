# LeetCode Daily Challenge Autonomous Assistant

A personal automation system that completes **your own** LeetCode Daily Challenge every day, unattended — running entirely on **Render's FREE tier (Hobby, $0/month)**.

**Free-tier architecture:** Render **Free Web Service** (Docker) + Render **Free Postgres** + Playwright headless Chromium + the authenticated session stored **in Postgres** (free tier has no persistent disks and no shell access) + solutions fetched from **[walkccc.me](https://walkccc.me/LeetCode/)** (curated C++ by question number — **no LLM key needed**) + internal node-cron, kept awake (or woken) by a **free external monitor** (cron-job.org / UptimeRobot). Total cost: **$0**. An LLM provider (e.g. a free Gemini key) remains available as an opt-in via `SOLUTION_SOURCE=llm`.

📘 **New here? Follow the step-by-step deployment runbook: [DEPLOYMENT.md](./DEPLOYMENT.md)** — it takes you from a fresh clone to a running service on Render's free tier, including the Gemini key setup, the session upload, and the external scheduler.

> **Why not a Background Worker + persistent disk?** Render's free tier only supports **web services, Postgres, Key Value, and static sites** — Background Workers and Cron Jobs are paid-only, and Free web services **cannot attach persistent disks and have no shell access** ([Render docs](https://render.com/docs/free)). This repo is therefore built as a free web service that runs its own scheduler, with the browser credential stored in the database instead of on a disk.

> **Scope & ethics.** This system operates exclusively on *your own authenticated account*. It contains **no** password automation, CAPTCHA/Turnstile solving, Cloudflare bypassing, fingerprint spoofing, proxy rotation, `cf_clearance` harvesting, or any anti-bot evasion. Authentication is a session **you** create by logging in manually, once. When LeetCode presents a verification page, the worker detects it, saves diagnostics, notifies you, and **stops**.

---

## Table of contents

1. [Local installation](#1-local-installation)
2. [Environment variables](#2-environment-variables)
3. [Running auth setup](#3-running-auth-setup)
4. [Creating the authenticated browser session](#4-creating-the-authenticated-browser-session)
5. [Getting the session onto Render (no shell, no disk)](#5-getting-the-session-onto-render-no-shell-no-disk)
6. [Creating the Render service (free)](#6-creating-the-render-service-free)
7. [Storage on the free tier (no persistent disk)](#7-storage-on-the-free-tier-no-persistent-disk)
8. [Database setup — and the 30-day free Postgres expiry](#8-database-setup--and-the-30-day-free-postgres-expiry)
9. [Scheduler behavior on a service that sleeps](#9-scheduler-behavior-on-a-service-that-sleeps)
10. [AUTO_SUBMIT configuration](#10-auto_submit-configuration)
11. [Authentication expiration recovery](#11-authentication-expiration-recovery)
12. [Cloudflare verification handling](#12-cloudflare-verification-handling)
13. [Troubleshooting](#13-troubleshooting)
14. [Failed submission recovery](#14-failed-submission-recovery)

---

## 1. Local installation

Requirements: Node.js 22+, npm, Docker (optional, for the local database).

```bash
git clone <your-repo-url> leetcode-daily-agent
cd leetcode-daily-agent
npm install
npx playwright install chromium   # needed once, for local auth:setup
cp .env.example .env              # then edit .env
```

Local database (easiest path):

```bash
docker compose up db -d
export DATABASE_URL="postgresql://leetcode:leetcode@localhost:5432/leetcode_agent"
npx prisma migrate deploy
```

Useful commands:

| Command | Purpose |
|---|---|
| `npm run auth:setup` | One-time manual login, creates the browser session artifacts |
| `npm run dev` | Run the service locally (watch mode) |
| `npm run run:now` | Execute the full daily pipeline immediately, then exit |
| `npm test` | Unit tests (parser, validator, submission classification) |
| `npm run build` | TypeScript compile to `dist/` |

## 2. Environment variables

All variables are validated with Zod at boot; the process refuses to start on invalid config.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — (required) | PostgreSQL connection string. Render free Postgres works; a free **external** Postgres (e.g. Neon) avoids the 30-day expiry — see §8 |
| `BROWSER_PROFILE_PATH` | `./local-auth/browser-profile` | Chromium profile dir. On Render free tier this is scratch (`/tmp/browser-profile`) — the durable credential is the storageState in Postgres |
| `STORAGE_STATE_PATH` | `./local-auth/storage-state.json` | storageState file path (hydrated from Postgres when missing) |
| `DIAGNOSTICS_DIR` | `./diagnostics` | Failure bundles (ephemeral on free tier; the Cloudflare screenshot also goes to Telegram) |
| `HEADLESS` | `true` | Headless Chromium in production |
| `CHROMIUM_SINGLE_PROCESS` | `false` | Escape hatch if Chromium OOMs on the 512MB free instance |
| `DAILY_RUN_HOUR` / `DAILY_RUN_MINUTE` | `9` / `0` | Daily run time |
| `TIMEZONE` | `Asia/Kolkata` | IANA timezone for schedule and dedupe date |
| `RUN_ON_BOOT` | `true` on Render | Converts a cold-start (triggered by an external cron ping) into the daily run — see §9 |

| `SOLUTION_SOURCE` | `walkccc` | `walkccc` (default — fetch curated C++ from walkccc.me, **no LLM key**) or `llm` (generate with an LLM) |
| `WALKCCC_BASE_URL` | `https://walkccc.me/LeetCode` | Base URL of the walkccc site |
| `LLM_PROVIDER` | `gemini` | Only used when `SOLUTION_SOURCE=llm` |
| `LLM_API_KEY` / `GEMINI_API_KEY` | — | Only used when `SOLUTION_SOURCE=llm` |
| `LLM_MODEL` | `gemini-3.5-flash` | Only used when `SOLUTION_SOURCE=llm` |
| `LLM_BASE_URL` | — | Only used when `SOLUTION_SOURCE=llm` — override the endpoint (proxies/gateways) |
| `LLM_MAX_TOKENS` | `8192` | Only used when `SOLUTION_SOURCE=llm` |
| `LLM_REASONING_EFFORT` | — | Optional (Gemini): `minimal` · `low` · `medium` · `high` · `none` |
| `LLM_TEMPERATURE` | — | Optional; only sent when set |
| `MAX_SOLUTION_RETRIES` | `3` | Only used when `SOLUTION_SOURCE=llm` |
| `LEETCODE_LANGUAGE` | `cpp` | `cpp` (default — matches walkccc) · `javascript` · `typescript` · `python3` |
| `AUTO_SUBMIT` | `false` | `false` = fill editor only; `true` = submit automatically |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Notifications (optional but recommended — it's your alerting on a headless free service) |
| `SETUP_TOKEN` | — (required) | Bearer token protecting `/admin/*` endpoints |
| `PORT` | `3001` | HTTP port — **Render sets this automatically**; leave it alone there |
| `LOG_LEVEL` | `info` | Pino level |

### Solution source: walkccc (default) vs LLM

By default (`SOLUTION_SOURCE=walkccc`) the service does **not** call any LLM. It takes the question number that LeetCode's GraphQL returns (`questionFrontendId`) and fetches the curated C++ solution from:

```
https://walkccc.me/LeetCode/problems/<question-number>/
```

e.g. problem 15 → `https://walkccc.me/LeetCode/problems/15/`. The C++ block is extracted from the page's own `#cpp` section (with a content-based fallback), decoded, and checked for a signature match against LeetCode's C++ starter before it is ever submitted. Because the solution is curated C++, `LEETCODE_LANGUAGE` defaults to `cpp`.

Set `SOLUTION_SOURCE=llm` to generate with an LLM instead — a free-tier [Google AI Studio](https://aistudio.google.com/apikey) key under `LLM_API_KEY` (or `GEMINI_API_KEY`) works with `LLM_PROVIDER=gemini`, no code change required.

**Honest limitation:** walkccc publishes each daily solution after the author solves it — brand-new problems can briefly 404 (handled as `SOLUTION_VALIDATION_FAILED`, retried the next day), and premium problems are not covered. If you need those, use `SOLUTION_SOURCE=llm`.

## 3. Running auth setup

```bash
npm run auth:setup
```

This opens a **headed** Chromium window pointed at the LeetCode login page on your own machine. Log in manually — password, Google OAuth, passkey, whatever you normally use. The script never sees your credentials. It polls LeetCode's own `userStatus` GraphQL endpoint from inside the page and, the moment you are signed in, it:

- keeps the persistent profile at `./local-auth/browser-profile/`
- writes `./local-auth/storage-state.json`
- prints your username and closes the window

You have 10 minutes; if it times out, just run it again — the profile directory persists, so the window resumes mid-flow.

## 4. Creating the authenticated browser session

Two artifacts come out of §3:

| Artifact | Role on free tier |
|---|---|
| `local-auth/storage-state.json` | **The credential that matters.** Small JSON (~10–50 KB). Uploaded to Postgres via the admin API (§5) and re-saved automatically after every successful run, so session cookies roll forward. |
| `local-auth/browser-profile/` | Nice-to-have locally and on paid tiers. On the free tier the filesystem is ephemeral, so the profile only survives within a single boot — the DB-backed storageState is authoritative. |

At every run the service tries, in order:

1. Persistent profile (if the directory exists and still holds a valid session) → verify signed-in **username** via GraphQL `userStatus`.
2. storageState — loaded from the file, or **hydrated from Postgres** when the file is gone (spin-down wiped it).
3. Both failed → run ends in `AUTHENTICATION_REQUIRED`, Telegram fires, `/health` shows `authentication.status = "authentication_required"`.

**The service never attempts password login. Ever.**

## 5. Getting the session onto Render (no shell, no disk)

Free web services have **no SSH/Dashboard shell** — you cannot `scp` the profile up. Instead, after the service is deployed and migrated, upload the storageState through the protected admin endpoint:

```bash
curl -X POST \
  -H "Authorization: Bearer $SETUP_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @local-auth/storage-state.json \
  https://<your-service>.onrender.com/admin/storage-state
```

Expected response: `{"ok":true,"stored":"database","cookies":N,"origins":M}`

The payload is validated (Zod), stored in Postgres, and **never logged**. That's it — the next run hydrates it from the database. Repeat this exact command whenever you refresh your login (§11).

## 6. Creating the Render service (free)

Push this repo to GitHub/GitLab, then in the Render dashboard: **New → Blueprint** → select the repo. `render.yaml` provisions:

- **Free Web Service** (`type: web`, `plan: free`, Docker runtime) — single instance (free tier can't scale anyway), health check on `/health`
- **Free Postgres** (`plan: free`, 1 GB) wired into `DATABASE_URL`
- All non-secret env vars preset; secrets (`LLM_API_KEY`, `TELEGRAM_*`, `SETUP_TOKEN`) marked `sync: false` — set them once in the dashboard

Manual alternative: **New → Web Service** → connect repo → Runtime: *Docker* → Instance type: **Free** → add env vars from §2.

First-boot checklist:

1. Wait for the deploy to go live (migrations run automatically in the container's start command).
2. Upload the session: §5.
3. Set up the external trigger: §9.
4. Smoke test: `curl -X POST -H "Authorization: Bearer $SETUP_TOKEN" https://<service>.onrender.com/admin/run-now` (returns `202`; first request may take ~1 minute — that's the free-tier cold start).

## 7. Storage on the free tier (no persistent disk)

Free web services have an **ephemeral filesystem**: anything written to disk vanishes on every spin-down, restart, or redeploy. This repo is designed around that:

| Data | Where it lives durably |
|---|---|
| Run history, dedupe (`DailyRun`) | Postgres |
| Auth status, last error, health info (`SystemState`) | Postgres |
| **storageState credential** | **Postgres** (auto-refreshed after every successful authenticated run) |
| Diagnostics bundles (screenshots, logs) | Ephemeral disk + **the Cloudflare screenshot is also sent to Telegram** so the important one survives |

## 8. Database setup — and the 30-day free Postgres expiry

Prisma + PostgreSQL; migrations apply automatically at container start (`prisma migrate deploy`, idempotent). Two honest options:

**Option A — Render Free Postgres (what `render.yaml` provisions).** Zero setup, same-datacenter latency. **But it expires 30 days after creation** (14-day grace, then deletion — [Render changelog](https://render.com/changelog/free-postgresql-instances-now-expire-after-30-days-previously-90)). When it expires: delete it, create a fresh free Postgres, re-point `DATABASE_URL`, redeploy (migrations recreate the schema), and re-upload the storageState (§5 — 30 seconds). You lose run history, nothing else.

**Option B — free external Postgres (recommended for set-and-forget).** E.g. Neon/Supabase free tiers don't expire. Create the database there, set its connection string as `DATABASE_URL` in the Render dashboard, done. Daily-challenge traffic is tiny — well within Render's acceptable external-DB usage for free services.

Schema (`prisma/schema.prisma`):

- `DailyRun` — one row per day (`date` is **unique**, making duplicate submissions structurally impossible): slug, title, difficulty, language, solution, submissionId, submissionStatus, runtime, memory, `state`, error, timestamps.
- `SystemState` — key/value store: auth status, username, last error, last run summary, **and the storageState JSON**.

## 9. Scheduler behavior on a service that sleeps

Free web services **spin down after 15 minutes without inbound traffic** (~1-minute cold start on the next request), and each workspace gets **750 free instance-hours/month** — one always-on service uses at most 744 (24×31), so staying awake 24/7 fits the budget. Pick one pattern:

**Pattern 1 — keep-alive + internal cron (recommended).** Add a free [cron-job.org](https://cron-job.org) (or UptimeRobot) monitor that `GET`s `https://<service>.onrender.com/health` every 10 minutes. The service never sleeps, and the internal node-cron fires at `DAILY_RUN_HOUR:DAILY_RUN_MINUTE` in `TIMEZONE` (default 09:00 Asia/Kolkata). Keep-alive pings don't consume meaningfully against bandwidth, and `/robots.txt`-style automatic responses don't apply to `/health`.

**Pattern 2 — wake-on-trigger.** Point a daily cron-job.org job at `POST /admin/run-now` with header `Authorization: Bearer <SETUP_TOKEN>` at 09:00 IST, and set `RUN_ON_BOOT=true` (default in `render.yaml`). The ping cold-starts the service (~1 min — set the cron-job.org request timeout to 120s), boot triggers the run, and afterwards the service idles back to sleep. Uses almost no instance hours. Render holds and forwards the request once the service is up, so the trigger isn't lost.

Both patterns coexist safely: the unique `date` row makes a boot-run followed by a cron-run a no-op.

Duplicate protection (unchanged from the original design): before any work, the service checks `DailyRun` for today's date in `TIMEZONE`; a `SUCCESS` or in-flight `PENDING` row ends the run immediately, and the unique constraint is the backstop across restarts.

## 10. AUTO_SUBMIT configuration

`AUTO_SUBMIT=false` (default): the service solves, validates locally, opens the problem page, verifies slug + language, and **fills the editor — but never presses Submit**. The run finalizes as `SUCCESS` with status `EDITOR_FILLED`. You review and submit by hand.

`AUTO_SUBMIT=true`: additionally clicks Submit, captures the submission id from the network response, polls the judge via GraphQL, and classifies the verdict: `ACCEPTED`, `WRONG_ANSWER`, `TIME_LIMIT_EXCEEDED`, `MEMORY_LIMIT_EXCEEDED`, `COMPILE_ERROR`, `RUNTIME_ERROR`, `UNKNOWN`. Anything but `ACCEPTED` ends in `SUBMISSION_REJECTED`.

## 11. Authentication expiration recovery

LeetCode sessions eventually expire. When profile and storageState both fail verification:

1. The run ends as `AUTHENTICATION_REQUIRED`; `/health` shows it; Telegram notifies you.
2. Locally: `npm run auth:setup` (the same profile dir is reused, so you usually just re-confirm the login).
3. Re-upload: the one `curl` from §5. No redeploy, no disk, no shell.
4. `POST /admin/run-now`, or wait for the next scheduled trigger.

Note the auto-healing property: because every *successful* run re-saves a fresh storageState to Postgres, cookie rotation is captured continuously — manual re-uploads are only needed when the session truly dies.

## 12. Cloudflare verification handling

Detection only — there is **no** solving or bypass code in this repo. If a Turnstile/challenge/verify page is detected at any checkpoint, the service:

- saves a timestamped diagnostics bundle (timestamp, URL, page title, screenshot, browser logs)
- **sends the screenshot to your Telegram** (critical on free tier — the on-disk bundle evaporates at the next spin-down)
- finalizes the run as `CLOUDFLARE_VERIFICATION_REQUIRED` and stops gracefully

Recovery: complete the verification once from a normal browser session, then §11 steps 2–4.

## 13. Troubleshooting

| Symptom | Where to look |
|---|---|
| `Invalid environment configuration` at boot | The Zod error lists exactly which env var is wrong — fix in the Render dashboard |
| First request takes ~1 minute / cron trigger shows a timeout | Normal free-tier cold start; set the external monitor's timeout to 120 s |
| Service "stopped" in the dashboard | Free services suspend when the workspace's 750 monthly instance-hours are exhausted (rare with one service); hours reset on the 1st |
| Chromium crashes / `Target closed` mid-run | 512MB ceiling. V8 heap is already capped; if it persists, set `CHROMIUM_SINGLE_PROCESS=true` and redeploy |
| `authentication_required` in `/health` | §11 — one `curl` to fix |
| `cloudflare_verification_required` | §12 — screenshot is in your Telegram |
| Everything reset after ~30 days | Free Postgres expired — §8. Re-create or move to an external free Postgres |
| `PROBLEM_PARSE_FAILED` | LeetCode changed a payload shape — check `src/leetcode/parser.ts` and the GraphQL schemas in `src/leetcode/dailyChallenge.ts` |
| `SOLUTION_VALIDATION_FAILED` | With the default walkccc source: the problem isn't on walkccc yet (new/premium) or its signature mismatched LeetCode's starter. With `SOLUTION_SOURCE=llm`: the model couldn't pass local validation within `MAX_SOLUTION_RETRIES`; the failing code + report are in the `DailyRun` row |
| Editor fill / submit broke after a LeetCode UI update | All selectors are isolated in `src/leetcode/selectors.ts` with ordered fallbacks — patch there only |
| Run seems stuck | `GET /health` → `runInProgress`; judge polling has a 60 s cap and every browser step has a timeout |
| Logs | Structured Pino JSON in the Render log stream (free tier keeps recent logs); cookies/tokens/keys are redacted by logger config |

## 14. Failed submission recovery

When the judge rejects a submission (`WRONG_ANSWER`, `TLE`, …):

1. The run is recorded as `SUBMISSION_REJECTED` with the verdict, runtime/memory, the exact submitted code, and a diagnostics bundle.
2. The unique `date` row means the scheduler will **not** hammer LeetCode with retries.
3. To retry the same day: fix the cause (model, language, or paste a corrected solution into the DB), delete today's `DailyRun` row (`DELETE FROM "DailyRun" WHERE date = 'YYYY-MM-DD';`), then `POST /admin/run-now`.
4. For persistent quality issues, raise `MAX_SOLUTION_RETRIES`, switch `LLM_MODEL`, or keep `AUTO_SUBMIT=false` and review in the editor before submitting yourself.

---

## Repository layout

```
src/
├── main.ts                  # entry: DB → HTTP API (Render port) → cron
├── config/                  # Zod-validated env config
├── logger.ts                # Pino with secret redaction
├── browser/                 # playwright (512MB-tuned), auth, sessionCheck,
│                            # cloudflareDetector, diagnostics
├── leetcode/                # graphql, dailyChallenge, parser, editor, submission, selectors
├── ai/                      # provider abstraction, gemini, openai, solver loop, prompts
├── solutions/               # walkccc.me C++ solution fetcher (default source)
├── validator/               # pipeline, testcase generator, per-language runners
├── database/                # prisma client, models, DB-backed storageState store
├── scheduler/dailyWorker.ts # the daily pipeline + state machine
├── notifications/           # telegram (text + photo) + notifier
└── api/health.ts            # GET /health, POST /admin/run-now, POST /admin/storage-state
scripts/auth-setup.ts        # npm run auth:setup
scripts/run-now.ts           # npm run run:now
tests/                       # vitest suites
prisma/                      # schema + migrations
Dockerfile · render.yaml · docker-compose.yml
```

## Security notes

- `.env`, the browser profile, cookies, tokens, and storage state are git-ignored and must never be committed.
- Secrets live only in Render's env-var store (`sync: false`).
- The storageState in Postgres is the keys to your LeetCode session — treat the database like a password manager entry; the admin endpoint is Bearer-protected and its payload is never logged.
- Pino is configured with path-based redaction for keys, tokens, cookies, and passwords.
- The container runs as the non-root `pwuser`.

## If you ever move to a paid tier

The code is already dual-mode: attach a persistent disk at `/var/data`, set `BROWSER_PROFILE_PATH=/var/data/browser-profile` and `STORAGE_STATE_PATH=/var/data/storage-state.json`, upload the profile via the paid tier's shell, and the persistent-profile path takes over automatically with the DB storageState as its fallback.

# AI solution articles

The article workflow uses an accepted code submission as its source. Ordinary daily and sequential/parallel range submissions retain the pre-Firecrawl community 1–10 selection and Walkccc fallback from commit `5a97223`. Article credentials are stored under `config.solutionPosts` and never override `config.solution.source`. Only explicitly selected article accounts enter the 06:00 article scheduler. A failed article does not invalidate an accepted DailyRun or change normal daily/range solution selection. `SOLUTION_AI_PROVIDER=firecrawl` is the default only for solution-article generation; set `FIRECRAWL_API_KEY` to enable it. Firecrawl Agent generates prose and animation plans in separate jobs and reviews the combined draft, with at most one repair and second review. A 429 response is retried in place at most twice within the job deadline, honoring a short Retry-After when supplied; longer limits are reported rather than ignored. Existing validation, two hosted GIF requirements, and publishing checks still apply. Firecrawl reports credits per job; `FIRECRAWL_AGENT_MAX_CREDITS` defaults to 300 **per job**, so one article can use up to six jobs. Splitting work may increase request count and credit use; it cannot bypass provider quotas. General Telegram AI chat remains on the separately configured BazaarLink provider. Firecrawl Agent has a 10,000-character prompt limit; oversized requests fail explicitly. Select `SOLUTION_AI_PROVIDER=bazaarlink` to use the legacy article provider described below.

All Agent job starts in the active process share a 31-second spacing gate, including article stages and explicit inference diagnostics. Firecrawl Free allows two Agent starts per minute; status polling has a separate allowance. A provider 429 updates the shared gate using Retry-After or retry_after_seconds, with a safety margin. Safe logs record the stage, delay and classified limit without provider response bodies or API keys. Queue waiting has a ten-minute budget per stage, separate from the three-minute remote-job timeout; generation and account leases include that budget. Other processes or tools using the same Firecrawl team can still consume its allowance, so the provider cooldown remains authoritative. Read-only startup diagnostics report the server's credit balance and a short one-way key fingerprint, without starting an Agent job.

## Integration and storage

The existing `Account` owns authentication, and `DailyRun` owns the accepted code, language, and submission ID. `loadContext` requires an owned successful run with `Accepted` status, verifies the session username and judge result, and loads the problem through the existing LeetCode API. It never sends cookies or account credentials to the AI provider.

`SolutionPost` stores an immutable source snapshot and SHA-256 code hash separately from `DailyRun`. It records generation/review models, usage, attempt outcomes and durations, draft Markdown, a content hash, human approval, publication status, and URL. A unique account/problem/publication-intent constraint prevents another article for the same problem even when a different accepted submission exists. Compare-and-swap state updates and generation leases prevent concurrent article generation. `SystemState` leases serialize combined jobs across worker replicas.

When the legacy BazaarLink provider is selected, the AI router discovers exact available model IDs before generation, then tries the configured IDs in order. Transient connection errors, timeouts, HTTP 429, and server errors have bounded exponential retries. Invalid/incomplete responses move to the next model. Authentication, access, and payment failures stop the chain. Provider error bodies and secrets are not logged. Usage is recorded whenever returned, including failed validation attempts; a provider-returned numeric `cost` is recorded when present. Missing cost is unknown, never zero.

For BazaarLink free models, inference starts are spaced at least 6.5 seconds apart across router instances in the same process; a `Retry-After` cooldown is shared and honored up to a bounded 60 seconds per retry. Discovery is cached per key within an article router. A BazaarLink HTTP 429 never retires the key for a month: free RPM/daily limits and spend brakes differ from HTTP 402 balance/monthly budget failures. The last slot incorrectly retired by an older version for a free-tier 429 is restored once without reviving earlier authentication failures. Provider daily allowance still limits throughput, and paid fallback stays disabled. The pacing is process-local; additional deployment replicas and unrelated clients share the provider allowance and can still cause 429.

The server generates a readable implementation from the accepted submission and problem. It compares code structures with the accepted solution and other drafts for the same problem and language. A durable reservation prevents two workers from claiming the same structure. An independent AI review checks the entry point, edge cases, complexity, and readability before the server drafts the prose and both animations from the reviewed implementation. The implementation review and bounded rewrite can add up to four Firecrawl jobs to the prose, animation, and draft-review jobs described above.

Presentation selection considers difficulty and implementation patterns, avoids the two most recent suitable styles, and sends recent titles to the generator. Emoji titles use a concrete hook and the actual technique. Prose targets 120–170 words, with hard limits of 220/280/360 words for Easy/Medium/Hard and 45 words per paragraph. Section order, code placement, and the complexity summary vary by layout. Each draft contains one reviewed implementation block.

Every article contains exactly two original GIFs interleaved with the short explanation: one for the core idea and one for a concrete dry run. The model supplies bounded trace data, and a separate request reviews every state transition; application code draws the diagrams and encodes delayed, looping frames. Model text cannot inject executable SVG or external image URLs. Generated media is stored by content hash in the existing PostgreSQL `SystemState` table and served at `/solution-assets/<sha256>.gif`. Set `PUBLIC_URL` to a stable public HTTPS origin; Render's `RENDER_EXTERNAL_URL` is used automatically. No new media migration is required. Before public publication, the worker fetches and validates both exact HTTPS GIF URLs (route, content type, and GIF signature). If either asset cannot be rendered, stored, or fetched, the post fails with `TWO_PUBLIC_GIFS_REQUIRED`; it is never auto-published with a trace-table substitute. Local sample generation can still use trace tables as an offline preview and does not publish assets.

Deterministic validation checks structure, required concepts, code duplication, supported markup, complexity notation, incomplete content, and repeated titles. A separate AI request checks the algorithm, trace, invariants, and complexity. Publication rechecks the accepted submission and requires the Markdown code block to match the reviewed implementation. Existing drafts can be regenerated through the explicit retry command and receive a new approval hash. Set `SOLUTION_POST_AUTO_PUBLISH=false` to require human approval.

Cooldowns longer than the 60-second in-job wait budget defer generation without an early retry. Other routers in the same process observe that cooldown too; their attempt records include `deferred: true` when no new inference request is sent.

## Setup

Use Node 22+ and the existing PostgreSQL database. Set `DATABASE_URL`, `SETUP_TOKEN`, and the existing account configuration. Add the following environment variables through your normal secret manager or local ignored `.env` file (Node 22 can load it with `--env-file`). The project does not automatically load `.env` itself.

```dotenv
FIRECRAWL_API_KEY=<firecrawl-key>
SOLUTION_AI_PROVIDER=firecrawl
FIRECRAWL_AGENT_MAX_CREDITS=300
SOLUTION_POST_AUTO_PUBLISH=true
```

The following legacy settings are used only when `SOLUTION_AI_PROVIDER=bazaarlink` (and for general Telegram AI chat):

```dotenv
SOLUTION_POST_API_KEYS=<key-1>,<key-2>,<key-3>
SOLUTION_POST_BASE_URL=https://api.bazaarlink.ai/v1
SOLUTION_POST_MODELS=qwen/qwen3.7-flash:free
SOLUTION_POST_TIMEOUT_MS=90000
SOLUTION_POST_MODEL_TIMEOUTS={}
SOLUTION_POST_RETRIES=1
SOLUTION_POST_MAX_TOKENS=8192
SOLUTION_POST_AUTO_PUBLISH=true
```

`SOLUTION_POST_API_KEY` remains supported as a one-key bootstrap option. `SOLUTION_POST_API_KEYS` accepts a comma-separated pool. Keys added through the Telegram command bot are encrypted using the existing `SETUP_TOKEN` secret and persisted in PostgreSQL, so they survive restarts. Use `/addsolutionkeys key-1,key-2` to append without removing the existing pool, or `/solutionkeystatus` to view only masked slots and the active position. The service advances to the next saved key after a quota, billing, payment, invalid-key, or forbidden response; ordinary temporary rate limits and timeouts do not consume a new key. There is no provider-neutral way to measure remaining monthly quota ahead of a request.

`SOLUTION_POST_MODEL_TIMEOUTS` accepts JSON such as `{"gpt-5.6-terra":120000}`. IDs must be present in the provider's model discovery response. The bot accepts only the economical user-approved families: `gpt-5.6-terra`, `gpt-5.6-luna`, Gemini 3.7/3.8 Flash, and provider-exposed Qwen names. It does not select Sol or other higher-cost models.

Apply the additive migration before starting the new worker:

```sh
npm run prisma:generate
npm run prisma:migrate
npm run build
npm start
```

## Commands

All commands below assume the environment is already loaded. `accountId`, `runId`, and `postId` are database IDs. The account label is shown by the interactive selector; the administrator API's account listing also exposes IDs.

```sh
npm run solution:post -- daily
npm run solution:post -- schedule
npm run solution:post -- generate <accountId> <runId>
npm run solution:post -- history
npm run solution:post -- preview <postId> ./article.md
npm run solution:post -- retry <postId>
npm run solution:post -- approve <postId> <reviewedContentHash>
npm run solution:post -- publish <postId>
npm run solution:post -- reconcile <postId> <publishedURL>
```

`daily` runs once for explicitly selected accounts. `schedule` shows all eligible accounts and accepts comma-separated numbers, `all`, or `clear`, then displays the selection and asks the operator to apply it. Clearing the schedule disables all article preferences. Existing submission schedules are unchanged.

In Telegram, `/dailysolution` opens the same durable account selection used by the 06:00 IST schedule. It preselects the accounts saved on the previous use, so accounts can be added or removed before saving or running the combined daily submission and article workflow immediately. `/manualsolution` uses that saved selection and offers either the daily problem or one LeetCode question number (for example, `3820`). For a manual question, the worker submits it, retains the exact accepted source under a namespaced non-daily run key, then generates and publishes the article through the same verified-GIF path. It never overwrites the calendar-day daily run.

For provider-only testing without a database mutation or public post:

```sh
npm run solution:post -- sample ./context.json ./sample.md
```

`context.json` must contain `accountId`, `username`, `problemId`, `slug`, `title`, `difficulty`, `problem`, `submissionId`, `language`, `code`, and `challengeDate`. This command accepts a supplied context only for an offline preview; it cannot create a publishable database record. Provider-only preview is not proof of acceptance. A safe metadata sidecar records model attempts and usage, or failure.

## Administrator API

All routes require the existing `Authorization: Bearer <SETUP_TOKEN>` header and return `Cache-Control: no-store`.

| Method | Path | Body or purpose |
|---|---|---|
| GET | `/admin/solutions/accounts` | Eligible accounts and latest captured accepted run IDs; no credentials |
| GET | `/admin/solutions` | History, optionally `?accountId=...&before=<ISO timestamp>` |
| GET | `/admin/solutions/:id` | Draft, content hash, attempts, and state |
| POST | `/admin/solutions/generate` | `{"accountId":"...","runId":"..."}` |
| POST | `/admin/solutions/daily` | `{"accountIds":["..."]}` |
| GET | `/admin/solutions/schedule` | Current selections, cron, timezone |
| PUT | `/admin/solutions/schedule` | `{"accountIds":["..."]}`; an empty array disables it |
| GET | `/admin/solutions/api-keys` | Masked key slots, active slot, and storage source only |
| POST | `/admin/solutions/api-keys` | `{"apiKeys":"key-1,key-2"}` appends a comma-separated pool; plaintext keys are never returned |
| POST | `/admin/solutions/:id/retry` | Explicitly retry a failed generation, renewing an exhausted generation budget |
| POST | `/admin/solutions/:id/approve` | `{"contentHash":"<reviewed SHA-256>"}` |
| POST | `/admin/solutions/:id/publish` | Explicitly publish the approved draft |
| POST | `/admin/solutions/:id/reconcile` | `{"url":"https://leetcode.com/problems/.../solutions/.../.../"}` |

Long generation requests are synchronous. Use a client/proxy timeout that covers the configured model/review budget. A disconnected caller does not roll back a completed draft; inspect history before retrying.

Enable Coarena through `POST /admin/solutions/coarena` with `{"apiKey":"<Coarena key>"}`. The server tests the key before saving it encrypted. `GET /admin/solutions/coarena` reports the active models and the remaining free allowance. The bot uses Claude Sonnet for the implementation and article, and GPT-6.1 Sol for independent review. The article and two GIF storyboards share one request. A draft that fails local validation gets one Coarena repair before failover. Discovery defers article generation on its first rate-limit response. Both providers share a five-minute inference budget. Coarena calls are serialized and checked against the free $5 daily allowance. Discovery handles the job if Coarena is unavailable, the allowance is exhausted, or the result fails review after repair.

The Render service includes a Coarena bootstrap credential sealed with its existing setup token. `COARENA_API_KEY` or a key saved through the authenticated API can supply a replacement. `/solutionkeystatus` shows masked key identifiers, and generation progress identifies the provider and key used for that article. New drafts reserve distinct section orders and GIF positions. Each problem has one eligible optimization section, included only when the AI identifies a concrete improvement and the reviewer confirms it. Legacy drafts require regeneration and a new approval before publication.

For a live judge comparison, enable one account through `/admin/solutions/test-control` and send `{"runId":"...","verification":"judge"}` to `/admin/solutions/server-tests`. Poll the returned job ID at `/admin/solutions/server-tests/:testId`. The job submits the reviewed draft code once when available. Otherwise it runs the article implementation generator and submits the reviewed result. The job reports which source it used, plus the original and new verdict, runtime, and memory.

## Scheduling and recovery

The new article cron is `0 6 * * *`, explicitly interpreted in `Asia/Kolkata`. Recovery checks every ten minutes after 06:00 IST and on startup. They process only explicitly selected accounts whose current UTC challenge day has no completed article. With the default `SOLUTION_POST_AUTO_PUBLISH=true`, a successfully generated and independently reviewed article is automatically approved and posted through the configured publication adapter (authenticated API by default). Set the flag to `false` to retain drafts for manual approval.

Each account authenticates independently and checks LeetCode's challenge date and slug. A stale pointer gets three bounded checks. Before invoking the existing submission worker, combined mode supplies the expected challenge date and selected account IDs; the worker checks the date again before submitting. An existing local accepted run is reused. One failed account does not stop the others.

Automatic generation has a maximum of four job attempts, including the original attempt. Scheduled combined jobs also have a durable four-attempt daily budget per account, including challenge/submission failures. An explicit Telegram “run now” (daily or question), CLI `daily`/`retry`, or authenticated `/admin/solutions/daily`/`:id/retry` request can renew an exhausted generation budget for the selected posts. The accepted submission is reverified and reused for the daily article retry. Budget renewal occurs atomically with the generation claim after source verification. It does not reset API key exhaustion, change the scheduler's independent daily budget, or replay published/uncertain publications. Expired generation leases can be resumed after a restart. Completed drafts stay available regardless of submission or publishing failures.

Generation claims and failures log the account ID, post ID, attempt count, explicit-retry flag, and previous error. AI attempt logs include the account/post IDs too. An automatic budget error retains and reports its underlying stored error rather than replacing it with a key-reset instruction. An AI provider HTTP 403 access challenge remains a provider access failure; renewing article attempts cannot remove that restriction.

## Publishing and limits

The default publisher uses LeetCode's authenticated `ugcArticlePublishSolution` GraphQL mutation from the server, with the selected account's existing session and CSRF token. It rechecks the accepted submission, account identity, exact source, approval hash, and existing account articles before claiming `PUBLISHING` and sending one mutation. `SOLUTION_POST_PUBLISH_TRANSPORT=browser` retains the visible-editor adapter as an explicit alternative. The existing-account scan is bounded; an incomplete scan blocks publication. Generated GIF URLs are served from the durable `/solution-assets/<sha256>.gif` endpoint and must pass public HTTPS content-type/signature verification during generation.

After the publication request or Post click, the job remains `PUBLISHING` until the returned solution URL, exact article Markdown/title, and author are positively verified. Timeouts preserve the draft and require reconciliation, never a repeated mutation or blind click. The API adapter never falls back to the browser after sending its mutation. A candidate URL can be reconciled through the API or CLI. It is not possible to reset an uncertain publication to a publishable state through these commands.

Only accepted submissions already captured by this project's `DailyRun` workflow are supported for production publication. Importing arbitrary historical submissions or publishing active-contest solutions is not exposed. CAPTCHA, access denial, changed editor markup, missing Monaco models, unsupported editor controls, or unverifiable identity block posting; no challenge solver is used by this module. A failed publication does not change the accepted `DailyRun`.

The API publisher was successfully exercised on Render on 6 November 2026, including exact content and author verification. See `docs/solution-article-server-verification-2026-11-06.md`. The older Codex browser test corrected Monaco insertion/title selectors for the optional browser adapter; Render's HTML editor can still require browser verification. No challenge solver is used by the API publisher.

## Files

`src/solutionPosts/{router,article,store,service,publisher,scheduler,routes}.ts` implement model routing, content, persistence, accepted context loading, review-gated UI publication, scheduling, and API integration. `scripts/solution-post.ts` supplies the interactive CLI. Migration `0006_solution_posts` adds article records and account preferences. `src/main.ts`, `src/api/health.ts`, and the optional account/date filters in `dailyWorker.ts` are the existing-system integration points. Configuration lives in `src/config/index.ts` and `.env.example`.

Verification results for this implementation are recorded in `docs/ai-solution-post-verification.md`.

## Account presentation and daily publication spacing (6 November 2026)

New generations reserve a durable presentation per account in `SystemState` under `solution-presentation:accounts:v2`. The assignment is global across problems and survives retries and restarts. A batch rotates through notebook, reader questions, example-first, recipe, interview, and field-guide article layouts; code placement and resource-summary formatting add structural variation for larger batches. The accepted source remains unchanged. Titles must use an original insight/technique hook: full question names and long verbatim fragments are rejected during generation and before publication. Recent titles from the account and the same problem guide variation across accounts.

Visual version 2 replaces the repeating three-layout/four-dark-palette cycle with fifteen compositions: timeline, spotlight, notebook board, split screen, terminal, stack, orbit, rail, matrix, ribbon, flow, blueprint, flashcards, dashboard and storyboard. The first fifteen accounts get unique primary layouts and palettes. The second visual uses a different geometry/palette pairing, so its output does not duplicate another account's primary visual. Light and dark surfaces, typography, native canvas dimensions/aspect ratios and five highlight motions vary. The renderer applies presentation metadata before independent factual review and never changes numeric trace values. Long animations use lossless inter-frame optimization if needed to retain every state within the 500 KB media limit.

Generation retries upgrade legacy presentation snapshots to version 2 while preserving accepted code. Published article URLs and their immutable GIF assets retain the presentation used when they were created; this change applies when an article is generated or regenerated. `POST /admin/solutions/visual-preview` accepts `{ "accountId": "..." }` under existing admin authentication and renders the normal assets on Render using identical demonstration data for each account. It does not publish a LeetCode article or vote. `npx tsx scripts/preview-solution-styles.ts` creates an offline comparison sheet without credentials; append an output directory and `--stress` for eight-value labels.

Daily publication uses a durable queue and a cross-process compare-and-swap gate. A verified daily publication sets the next eligible time to at least 20 minutes later. Waiting drafts remain approved and are not regenerated; cooldowns do not consume automatic generation retry budgets. The queue drains every minute and on restart, including before the 06:00 generation schedule. If Render sleeps, a delayed wake can postpone publication but cannot shorten the minimum gap. An uncertain request also reserves a conservative gap and is never replayed automatically.

`/dailysolution`, scheduled daily runs, and CLI daily runs use this queue. `/manualsolution` (including its daily-problem option), explicit manual publication, and CLI publish remain immediate. The bot reports queued drafts and sends the article link after delayed publication. Voting is not automated.

The authenticated server-test endpoint accepts optional `publicationMode: "daily" | "manual"` (default manual). Daily mode exercises the same queue as the bot. A test result can be `DEFERRED` while its reviewed draft waits; polling later resolves it to `PUBLISHED` after the queue completes it. The temporary test control does not change selected-account preferences.

Staged generation preserves the last rejected draft and concrete review issues for an explicit retry. This feedback is supplied to the writer; the fresh reviewer receives only the current article and exact source/problem. Configured reasoning models handle factual repairs and verdicts. Bounded validation feedback corrects overlong repairs before model fallback. Oversized diagram headings and scalar highlight indices are normalized without changing traced values; the complete article is still independently reviewed. Reasoning budgets and request/generation leases account for hidden reasoning tokens. Repeated transport failures temporarily cool down that model without rotating otherwise valid keys.

Active generation and eligible queued work share a scoped Render health heartbeat. It stops when the work finishes; it does not wake an already sleeping service for the 06:00 schedule. The external wake setup below remains necessary on a sleeping free service. Publication reservations survive an exception after the remote request. A failed API response triggers a read-only search and exact verification before returning an uncertain result; it never repeats the mutation. `/admin/solutions/:id/reconcile` accepts `{}` to perform the same positive reconciliation later. `GET /admin/solutions/:id/publication-check` provides read-only account/article diagnostics. Missing or mismatched articles remain protected `PUBLISHING` records.

Two further server publications with different presentations and a measured 45-minute gap are recorded in `docs/solution-article-variation-verification-2026-11-06.md`.

## 06:00 recovery and server diagnostics

The combined workflow completes daily code submissions for **all selected accounts before AI article generation**. Every accepted event requires the matching daily slug, `SUCCESS`, a submission ID, and an `Accepted` verdict. Existing accepted code is reused on article retries. A published manual article cannot suppress the daily code submission. Expired sessions get the same stored-credential refresh as the ordinary daily worker.

Recovery resumes completed `DRAFT_READY` / `AWAITING_APPROVAL` posts when automatic publication is enabled. An uncertain `PUBLISHING` record is never clicked again. Busy workers and active account leases do not consume the four automatic daily attempts. Adding an available key or explicitly resetting the pool resets both failed AI posts and their scheduler budgets; automatic retries no longer force-reset exhausted generation attempts.

The default article provider is BazaarLink at `https://api.bazaarlink.ai/v1`, using `qwen/qwen3.7-flash:free`. For this provider, environment precedence is `BAZAARLINK_API_KEYS`, `BAZAARLINK_API_KEY`, `SOLUTION_POST_API_KEYS`, then `SOLUTION_POST_API_KEY`. Empty variables do not hide populated alternatives. All keys in the selected pool are considered, with normal quota failover. Explicitly configured environment keys and `/setsolutionkeys` inputs are opaque credentials: no key is silently discarded or rejected because of a prefix. The provider's actual authentication response establishes validity. Quoted lists, JSON arrays, and copied assignments such as `SOLUTION_POST_API_KEYS="key1,key2"` are normalized with the same parser used by the bot.

There is no built-in article credential. A legacy CodeCraft bootstrap key is no longer loaded. On a provider switch, only recognizable saved BazaarLink keys are carried from the old provider's database pool; other old-provider credentials are not implicitly reused. Explicit environment values or newly saved keys are bound to the selected provider. Startup logs, `/testsolkey` when configuration is missing/invalid, and admin diagnostics expose only variable names, presence, counts, and formatting errors. Existing explicit `SOLUTION_POST_BASE_URL` and `SOLUTION_POST_MODELS` environment values still override defaults; update them on existing Render services. The Render blueprint and example environment use the defaults above. BazaarLink requests disable paid fallback with `X-Free-Fallback: false`.

On process startup, the server makes one small inference probe per configured Terra/Luna/Gemini model (maximum three). Set `SOLUTION_POST_VERIFY_ON_BOOT=false` to disable probes. Results, execution host, and HTTP failure category are saved under `solution-post-provider:last-check` and logged without full keys. Model-list success alone is not inference success; HTTP 402 is a provider billing/allowance failure. Missing `models:read` permission still permits the inference probe.

Authenticated routes (existing `SETUP_TOKEN` bearer authentication):

| Route | Purpose |
|---|---|
| `GET /admin/solutions/diagnostics` | Saved selection, timezone, running state, durable last tick, revision, provider probes, and masked key status |
| `POST /admin/solutions/scheduled` | Return HTTP 202 and run the saved 06:00 selection asynchronously, subject to the normal clock and idempotency checks |
| `POST /admin/solutions/api-keys/test` | Body `{"model":"gpt-5.6-terra"}`; optional `apiKey` tests a supplied key without saving it. Only Terra, Luna, and Gemini Flash are allowed. |

Render's free web services sleep after idle time; a process cron cannot wake a sleeping instance. The optional `docs/daily-solution-wake.yml` template supplies a 06:00 IST wake and hourly recovery. To activate it, copy it to `.github/workflows/` using a credential permitted to manage workflows, then configure repository variable `BOT_SERVER_URL` and secret `BOT_SETUP_TOKEN`. The deployment credential available during this fix lacks GitHub's `workflow` permission, so the template is not activated automatically. Polls keep the service awake during the bounded observation window. GitHub scheduled jobs may be delayed, so use an always-on worker or an external monitor with a suitable service guarantee when exact start time is required. The internal ten-minute recovery and restart catch-up remain active.

Incident evidence and validation are recorded in `docs/daily-solution-incident-2026-10-22.md`.

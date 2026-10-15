# AI solution articles

The article workflow is independent of executable code submission. Existing daily and range submission commands keep their existing defaults. New accounts have no article schedule and no publication permission by default.

## Integration and storage

The existing `Account` owns authentication, and `DailyRun` owns the accepted code, language, and submission ID. `loadContext` requires an owned successful run with `Accepted` status, verifies the session username and judge result, and loads the problem through the existing LeetCode API. It never sends cookies or account credentials to the AI provider.

`SolutionPost` stores an immutable source snapshot and SHA-256 code hash separately from `DailyRun`. It records generation/review models, usage, attempt outcomes and durations, draft Markdown, a content hash, human approval, publication status, and URL. A unique account/problem/publication-intent constraint prevents another article for the same problem even when a different accepted submission exists. Compare-and-swap state updates and generation leases prevent concurrent article generation. `SystemState` leases serialize combined jobs across worker replicas.

The AI router discovers exact available model IDs before generation, then tries the configured IDs in order. Transient connection errors, timeouts, HTTP 429, and server errors have bounded exponential retries. Invalid/incomplete responses move to the next model. Authentication, access, and payment failures stop the chain. Provider error bodies and secrets are not logged. Usage is recorded whenever returned, including failed validation attempts; a provider-returned numeric `cost` is recorded when present. Missing cost is unknown, never zero.

Presentation selection considers difficulty and source patterns, avoids the two most recent suitable styles, and sends recent titles to the generator. Emoji titles use a concrete hook and the actual technique; unmeasured “fastest” claims are rejected. Prose targets 120–170 words, with hard limits of 220/280/360 words for Easy/Medium/Hard and 45 words per paragraph. Correctness and takeaways are brief callouts, followed by one compact complexity table and exactly one unchanged source block.

Every article contains exactly two original GIFs interleaved with the short explanation: one for the core idea and one for a concrete dry run. The model supplies bounded trace data, and a separate request reviews every state transition; application code draws the diagrams and encodes delayed, looping frames. Model text cannot inject executable SVG or external image URLs. Generated media is stored by content hash in the existing PostgreSQL `SystemState` table and served at `/solution-assets/<sha256>.gif`. Set `PUBLIC_URL` to a stable public HTTPS origin; Render's `RENDER_EXTERNAL_URL` is used automatically. No new media migration is required. Before public publication, the worker fetches and validates both exact HTTPS GIF URLs (route, content type, and GIF signature). If either asset cannot be rendered, stored, or fetched, the post fails with `TWO_PUBLIC_GIFS_REQUIRED`; it is never auto-published with a trace-table substitute. Local sample generation can still use trace tables as an offline preview and does not publish assets.

Deterministic validation checks structure, required concepts, code duplication, supported markup, complexity notation, incomplete content, and repeated titles. A separate AI request checks the algorithm, trace, invariants, and complexity. This is useful review, not a correctness proof. Scheduled publication uses those checks, an accepted-submission recheck, exact-source comparison, duplicate detection, and post-publication verification. Set `SOLUTION_POST_AUTO_PUBLISH=false` to retain the previous human approval gate.

## Setup

Use Node 22+ and the existing PostgreSQL database. Set `DATABASE_URL`, `SETUP_TOKEN`, and the existing account configuration. Add the following environment variables through your normal secret manager or local ignored `.env` file (Node 22 can load it with `--env-file`). The project does not automatically load `.env` itself.

```dotenv
SOLUTION_POST_API_KEYS=<key-1>,<key-2>,<key-3>
SOLUTION_POST_BASE_URL=https://codecraftapi.com/v1
SOLUTION_POST_MODELS=gpt-5.6-terra,gpt-5.6-luna,gemini-3.7-flash
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
| POST | `/admin/solutions/:id/retry` | Resume a failed generation within the retry budget |
| POST | `/admin/solutions/:id/approve` | `{"contentHash":"<reviewed SHA-256>"}` |
| POST | `/admin/solutions/:id/publish` | Explicitly publish the approved draft |
| POST | `/admin/solutions/:id/reconcile` | `{"url":"https://leetcode.com/problems/.../solutions/.../.../"}` |

Long generation requests are synchronous. Use a client/proxy timeout that covers the configured model/review budget. A disconnected caller does not roll back a completed draft; inspect history before retrying.

## Scheduling and recovery

The new article cron is `0 6 * * *`, explicitly interpreted in `Asia/Kolkata`. Recovery checks every ten minutes after 06:00 IST and on startup. They process only explicitly selected accounts whose current UTC challenge day has no completed article. With the default `SOLUTION_POST_AUTO_PUBLISH=true`, a successfully generated and independently reviewed article is automatically approved and posted through LeetCode's visible solution editor. Set the flag to `false` to retain drafts for manual approval.

Each account authenticates independently and checks LeetCode's challenge date and slug. A stale pointer gets three bounded checks. Before invoking the existing submission worker, combined mode supplies the expected challenge date and selected account IDs; the worker checks the date again before submitting. An existing local accepted run is reused. One failed account does not stop the others.

Generation has a maximum of four job attempts, including the original attempt. Scheduled combined jobs also have a durable four-attempt daily budget per account, including challenge/submission failures. Expired generation leases can be resumed after a restart. Completed drafts stay available regardless of submission or publishing failures.

## Publishing and limits

The publisher uses LeetCode's visible `post-solution/?submissionId=...` editor, requires the selected account's accepted submission and the exact prepopulated source, and verifies the entered Markdown before clicking Post. It uses the existing community GraphQL queries to detect an existing post by the account. The scan is bounded; an incomplete scan blocks publication. Generated GIF URLs are served from the durable `/solution-assets/<sha256>.gif` endpoint. Both must be reachable as valid GIFs from the configured public HTTPS origin before any Markdown can be posted.

After clicking Post, the job remains `PUBLISHING` until the returned solution URL, exact article Markdown/title, and author are positively verified. Timeouts preserve the draft and require reconciliation, never another blind click. A candidate URL can be reconciled through the API or CLI. It is not possible to reset an uncertain publication to a publishable state through these commands.

Only accepted submissions already captured by this project's `DailyRun` workflow are supported for production publication. Importing arbitrary historical submissions or publishing active-contest solutions is not exposed. CAPTCHA, access denial, changed editor markup, missing Monaco models, unsupported editor controls, or unverifiable identity block posting; no challenge solver is used by this module. A failed publication does not change the accepted `DailyRun`.

The authenticated submission/editor/publication flow was successfully tested in the Codex browser; see the verification report for the accepted submission and public article URLs. That test also corrected Monaco insertion and title-selector behavior. The database-backed adapter and its GraphQL verification still need a smoke test on the deployment's browser before unattended use. The reference article was subsequently inspected in the Codex browser to guide pacing and layout; its text, code, and media were not copied.

## Files

`src/solutionPosts/{router,article,store,service,publisher,scheduler,routes}.ts` implement model routing, content, persistence, accepted context loading, review-gated UI publication, scheduling, and API integration. `scripts/solution-post.ts` supplies the interactive CLI. Migration `0006_solution_posts` adds article records and account preferences. `src/main.ts`, `src/api/health.ts`, and the optional account/date filters in `dailyWorker.ts` are the existing-system integration points. Configuration lives in `src/config/index.ts` and `.env.example`.

Verification results for this implementation are recorded in `docs/ai-solution-post-verification.md`.

# Daily solution incident — 22 October 2026

## Confirmed on the live LeetCode server

Server: `https://leetcode-daily-agent-avh0.onrender.com`.

- Saved schedule: `0 6 * * *`, `Asia/Kolkata`, automatic publishing, four selected accounts.
- Runtime logs show the first selected-account workflow at **06:00:00.854 IST**. The cron fired.
- Four code-submission events occurred; all four selected accounts reached the accepted stage with submission IDs. Four recovery rounds produced 16 article failures between 06:00 and 06:32.
- The database key pool contained one old key, with `active: null`; the runtime's one-based active index was 2. The sole key had already been exhausted. No inference request was attempted at 06:00 because the router rejected the empty usable slice.
- Today's four article records were `FAILED`, `AI_CONFIGURATION_REQUIRED`, `retryCount: 4`. This error incorrectly conflated an absent configuration with an exhausted saved key pool.
- Changing a key could reset article retries while leaving the separate scheduled-attempt budget exhausted. Recovery also treated a completed but unpublished draft as finished, so it never resumed publication.

The live admin inspection succeeded with the actual `SETUP_TOKEN`. The initially supplied four-digit dashboard token returned HTTP 401 on admin routes.

## Supplied replacement key

Small real requests from the workspace on 22 October:

| Request | Result |
|---|---|
| `GET /v1/models` | HTTP 200; all three configured IDs present |
| `gpt-5.6-terra` completion | HTTP 402, `insufficient_quota`, `insufficient_funds` |
| `gpt-5.6-luna` completion | HTTP 402, `insufficient_quota`, `insufficient_funds` |
| `gemini-3.7-flash` completion | HTTP 402, `insufficient_quota`, `insufficient_funds` |

Provider message: “Billing verification failed. Please check your payment method.” A model-list response and the dashboard's active-key badge do not establish inference allowance. These failures are provider billing/quota responses, not proof of an IP block.

## Fix and validation

- Complete all selected daily submissions before any AI call; verify the accepted run again before emitting acceptance.
- Resume completed unpublished drafts; preserve the non-replay rule for uncertain public posts.
- Reset scheduler and generation budgets together when credentials are repaired. Ordinary rate-limit messages containing “exceeded” no longer permanently retire a key. Exhausted keys stay skipped during a later review request.
- Persist the last key failure category and distinguish missing, exhausted, and billing-blocked configurations.
- Provide bounded live server probes, startup diagnostics, durable tick results, and an optional external wake workflow.
- Bootstrap the supplied key in code as explicitly requested. Environment variables and the encrypted bot pool remain supported. No full key is written to this report, endpoint responses, or logs.

Focused regression suite: **90 tests passed** across article generation, routing, encrypted keys, scheduler recovery, service/session renewal, routes, publishing, and GIFs. The TypeScript build and whitespace checks passed. Broader related suites passed 134 tests with one existing Telegram poller handover failure; the handover test also fails when run separately, and this patch does not change the poller implementation.

Application commits were pushed to both `main` remotes. The deployment repository's credential rejected creating an Actions workflow because it lacks `workflow` scope; the optional external wake remains a setup template under `docs/` instead. The existing in-process schedule was verified firing today.

## Confirmed from the deployed Render container

The deployment of `a34c099` was positively verified through `/admin/solutions/diagnostics`, which returned `executionHost: render` and the exact deployed commit. The supplied key was appended to the encrypted live database as slot #2, preserving the exhausted original slot. The saved four-account schedule and automatic publishing remained enabled.

Both the automatic startup probe and explicit authenticated server probes returned:

| Model | Model list | Inference | Category |
|---|---|---|---|
| `gpt-5.6-terra` | HTTP 403 | HTTP 403 | `PROVIDER_ACCESS_BLOCKED` |
| `gpt-5.6-luna` | HTTP 403 | HTTP 403 | `PROVIDER_ACCESS_BLOCKED` |
| `gemini-3.7-flash` | HTTP 403 | HTTP 403 | `PROVIDER_ACCESS_BLOCKED` |

The response was Cloudflare HTML titled **“Just a moment…”**, rather than CodeCraft's documented JSON `insufficient_scope` response. Authenticated requests to the bot itself returned HTTP 200, so these are upstream CodeCraft responses. This is an additional provider-side access restriction affecting Render, beyond the local HTTP 402 allowance failure. The provider must permit authenticated API access from this host and restore the account's inference allowance; changing model names or retiring more API keys cannot repair those external restrictions.

A follow-up patch stops immediately on this HTML challenge, preserves the current key slot, and stores `AI_PROVIDER_ACCESS_BLOCKED`. Only an explicit JSON `insufficient_scope` / `models:read` denial permits discovery fallback. Diagnostic results include a provider request ID when supplied, without retaining challenge HTML.

The actual combined workflow was also exercised on Render from **09:17:11 to 09:19:55 IST**. All four selected accounts' existing accepted submissions were reused before article generation began; no code resubmission was needed. The production OpenAI SDK then received HTTP 403 for discovery and all three allowed inference models. All four article records retained their accepted source and reported the provider failure. The next ten-minute recovery tick started normally. These checks establish that the restriction also affects the production SDK, rather than just the diagnostic fetch client.

Provider documentation: [authentication and HTTP errors](https://codecraftapi.com/docs/authentication), [documented API endpoint](https://codecraftapi.com/docs/getting-started). The API docs define HTTP 402 as exhaustion of balance and plan allowance, and HTTP 403 scope denials as JSON. No CAPTCHA solver or network identity workaround was used.

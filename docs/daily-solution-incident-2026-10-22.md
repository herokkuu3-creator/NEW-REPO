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

Focused regression suite: 86 tests passed before the final startup-probe additions. Final build/test and deployed-server results are recorded after verification.

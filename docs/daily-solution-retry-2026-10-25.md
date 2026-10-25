# Daily article retry lockout — 25 October 2026

## Observed failure and live evidence

The supplied Telegram screenshot shows `/dailysolution` and four accounts ending at “Retry limit reached (4 failed attempts)” at 11:37. It has no visible date, timezone, or request ID. That alone cannot identify the exact server request.

The older supplied `https://leetcode-daily-agent.onrender.com/logs` endpoint returns HTTP 503, “Service Suspended”. The current endpoint recorded in the repository, `https://leetcode-daily-agent-avh0.onrender.com/logs`, returned HTTP 200 and 40 retained entries beginning at 2026-10-25 11:34:48.184 +05:30. Those entries contain the same four-account failure at 11:38, but no workflow event at exactly 11:37. Exact screenshot-to-request attribution is therefore unverified.

| Server timestamp (IST) | Observed event | What it establishes |
| --- | --- | --- |
| 11:34:50.896–11:34:51.316 | Three startup inference probes return HTTP 403, `PROVIDER_ACCESS_BLOCKED`, for Terra, Luna, and Gemini Flash | The configured bootstrap credential's probe encountered a CodeCraft HTML access challenge from Render. This does not identify the saved article pool's credentials or establish why its earlier four attempts failed. |
| 11:38:30.115 | First account enters `starting` | A combined workflow runs. |
| 11:38:35.382 | `sks7501` accepted, submission `2180919355` | Accepted daily code exists. |
| 11:38:39.885 | `this_is_derek` accepted, submission `2180919411` | Accepted daily code exists. |
| 11:38:44.194 | `this_is_naruto` accepted, submission `2180919467` | Accepted daily code exists. |
| 11:38:48.376 | `chris_grif` accepted, submission `2180919535` | All four reach the accepted stage. |
| 11:38:48.587–11:38:50.026 | Each `generating_article` event is followed by `GENERATION_RETRY_LIMIT` | The article retry guard blocks all four. There are no AI generation attempts for this retained workflow. |

## Confirmed application defect

Telegram's explicit daily “run now” called `runCombined` with the same retry policy as unattended cron recovery. `runCombined` called `retryPost` without its explicit-retry flag. Once a post reached four attempts, subsequent operator requests failed before invoking the AI router. The Telegram message told the operator to reset API keys even though article attempts and key exhaustion are separate state.

The existing manual-question path already requested explicit retries. It also needed to pass that intent to `generateForRun` for pending/recovered records. The old force-reset implementation independently updated `retryCount` by ID before checking status or claiming the generation state; simultaneous requests could affect another worker's budget.

## Change

- Telegram's daily “run now”, the explicit daily admin endpoint, and the daily CLI request a fresh generation attempt for the selected posts. Explicit retry API/CLI commands do the same.
- Cron/restart recovery retains its four-attempt generation limit and independent daily scheduler budget.
- Generation verifies stored source and resets an exhausted count to one in the same compare-and-swap transition that claims generation. Explicit retry never resets API key exhaustion.
- Accepted daily code is reused and reverified. Published, publishing, and completed drafts cannot be regenerated through the retry command.
- Budget errors preserve post ID, count, and the underlying saved failure in progress. Generation claims, router attempts, and failures include account/post correlation. Startup logs now include Render's deployed revision.
- Provider access challenges receive a clear Telegram explanation. CodeCraft's upstream access policy remains external to this change.

## Validation and limits

106 tests passed across the service, scheduler, routes, key pool, article, publisher, and GIF suites. Cases include the four-account lockout, explicit retry after exhaustion, simultaneous budget renewal, source-integrity rejection, preservation of accepted code, cron retaining its cap, and prevention of retrying completed/uncertain publications. TypeScript compilation and whitespace checks passed.

These are local regression tests with network/database adapters mocked. They do not establish a successful provider completion or public article from the deployed server. After deployment, use the saved daily account selection's “run now” action; a fresh claim should include `explicitRetry: true` and `retryCount: 1` for an exhausted post. If the AI request fails, its correlated attempt and final failure should expose the current cause instead of the old retry-limit lockout. A current inference probe must succeed before end-to-end article publication can be considered restored.

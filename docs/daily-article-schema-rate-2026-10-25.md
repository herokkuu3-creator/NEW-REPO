# Article schema, rate limit, and progress incident — 25 October 2026

The screenshot shows a successful BazaarLink inference probe at 13:37, followed by a daily workflow with `SCHEMA:section.markdown`, `KEY_EXHAUSTED`, two accounts left at “accepted,” and a final zero-published/two-failed summary. The screenshot has no date, timezone, or run ID. The retained runtime sequence below has matching accounts and error types, with explicit server timestamps in IST. Exact screenshot-to-request attribution is not available.

Source: `https://leetcode-daily-agent-avh0.onrender.com/logs?limit=1000`.

| Server time (+05:30) | Event | What it establishes |
| --- | --- | --- |
| 13:39:19–13:39:35 | Combined run starts; four daily submissions reach `accepted` | Code acceptance is separate from article publication. |
| 13:40:00.987 | Another combined run starts; its first account is skipped with `ACCOUNT_JOB_IN_PROGRESS` | Two workflows overlap. The scheduled workflow's final report corroborates lease contention. |
| 13:40:19.879 | First article stage succeeds using `qwen/qwen3.7-flash:free` | Provider authentication and at least one generation request work. |
| 13:40:26.285 | Next AI attempt reports `SCHEMA:section.markdown` | A generated field fails schema validation after the repair path. The old log does not retain the issue subtype or offending output; array vs missing/short/long field cannot be established from it. |
| 13:40:26.292 | Post fails with `AI_ERROR: SCHEMA:section.markdown` | No article is published for this attempt. |
| 13:40:52–13:41:11 | Several stages for another account succeed; a second article begins concurrently | Real article generation works but creates multiple provider requests. |
| 13:41:12.507–13:41:12.854 | Two AI calls become `KEY_EXHAUSTED`; key pointer advances | At the deployed revision, this outcome is produced by the HTTP 429 quota-text classifier; 401 and 402 have separate outcomes. The original response body/headers were not retained, so RPM vs daily allowance cannot be identified. |
| 13:41:47.976 | Later account fails with `AI_KEYS_EXHAUSTED` | A valid key has been retired by the 429 classification. |
| 13:41:48.146 | Scheduled report includes two skipped accounts and two failures | The UI omits skipped updates during its article phase, leaving earlier accepted messages visible. |

## Source defects and corrections

`article.ts` used ambiguous `{heading,markdown}` prompts and a repair request without the original source. It also hardcoded parentheses inputs/depth invariants into every problem's prose and animations. Prompts now explicitly type fields, remain tied to the supplied algorithm, and use the actual dry-run example for its animation. String arrays of bullets are converted losslessly to Markdown before the existing validations. Repair remains bounded and now includes the source. Schema paths/codes and stage names are logged for future failures; invalid output is not blindly accepted.

`router.ts` interpreted any HTTP 429 message containing “quota” as key exhaustion. BazaarLink documents free-model RPM/daily caps and returns 429 when paid fallback is disabled. Its monthly/balance failures use 402. BazaarLink 429 now preserves the key, records HTTP status and Retry-After, and reports `AI_RATE_LIMITED`. The router caches model discovery and spaces free inference starts across concurrent routers in one process. Paid fallback remains disabled. `keyPool.ts` restores the most recently misclassified BazaarLink slot once, preserving earlier authentication retirements.

`scheduler.ts` returned a skipped result on second-phase lease contention without a progress event. It now emits that event and also treats an already-active generation/publication as owned by another run. Telegram summaries count skips and drafts/pending work. This does not transfer another run's live progress into the current message, and it never replays an uncertain Post click.

## Verification and limits

The focused solution-post suites passed 139 tests; TypeScript compilation and whitespace checks passed. Long Retry-After cooldowns defer work without retrying early and are recorded separately from new provider requests.

Regression cases reproduce schema repair with original source, bullet-array normalization, problem-specific animation prompts, a free-quota 429 with Retry-After, cross-router pacing/discovery caching, restoration of the incorrectly retired slot, rate limiting during review, and contention between two combined runs. Exact original invalid Markdown and exact provider limit remain unknown because the old logs did not capture their categories.

Local tests use mocked providers/database adapters. They establish application behavior, not successful public article publication. A live generation after deployment must pass all stages, review, both hosted-GIF checks, and publication verification before it counts as restored. A provider daily allowance can still defer work even with correct pacing; changing code cannot expand that allowance.

Primary provider reference: [free model quotas and errors](https://bazaarlink.ai/en/docs).

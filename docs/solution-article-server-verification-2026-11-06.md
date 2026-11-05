# Solution article repair and Render publication — 6 November 2026

## Verified result

Account `watch_me_win` published [Lower-Bound Shortcut: Distance in One Sorted Check](https://leetcode.com/problems/find-the-distance-value-between-two-arrays/solutions/8603066/lower-bound-shortcut-distance-in-one-sor-2c3i/).

The Render application recorded `PUBLISHED` at **01:02:11 IST**, then logged `solution article publication verified` at **01:02:12 IST** with `executionHost: render`, `transport: api`, and revision `4ff2f6ae34b7a1f9bee158e2437360d062fc670f`. Server test `78cd954d-4b17-4622-b899-83d727d021a7` completed successfully. The publication request ran inside the deployed application's `publishPost` function; no local publication request or local-browser Post action was used.

The application independently rechecked accepted submission `2189767051`, compared the approved content hash, checked for an existing article, sent one authenticated mutation, and verified the returned URL, exact Markdown/title, and account author. Both embedded assets returned HTTP 200, `image/gif`, and `GIF89a`, with sizes 49,154 and 70,835 bytes. They are stored durably in PostgreSQL.

## Failures reproduced and corrected

- Sage reasoning consumed the old 512-token stage budgets. Requests now reserve reasoning headroom and increase bounded budgets after truncation; internal reasoning is never substituted for final article output.
- Valid review rejections were classified as invalid protocol output, losing their correction feedback. The staged workflow now repairs rejected content and requests a fresh verdict, with a two-repair limit and no approval shopping.
- MiniMax reviews contradicted their own arithmetic. Configured reasoning models now handle technical review and its full-article repairs. Earlier article parts are supplied to later stages for consistency.
- An unrelated hash-table instruction contaminated binary-search explanations. It was removed.
- HTTP 429 and 90-second timeouts prevented repairs and were mislabeled as technical rejections. Sage 429 responses without retry headers receive a conservative cooldown; review/repair requests get at least 180 seconds; provider failures retain their categories.
- Final assembled validation failures had no repair path. They now enter bounded structural repair. A retry also excludes its own failed draft from recent-title comparisons.
- Render's HTML editor required browser verification. The default publication adapter now uses LeetCode's authenticated GraphQL publication endpoint. Source/eligibility/approval/duplicate checks and compare-and-swap ownership remain mandatory; uncertain requests are never replayed.

## Controlled server testing

Authenticated `POST /admin/solutions/test-control` enables testing for one account for one hour (`{"accountId":"..."}`). A null account disables it. `POST /admin/solutions/server-tests` accepts an existing accepted `runId`, returns 202, and executes the normal generation/approval/publication code on Render. `GET /admin/solutions/server-tests/:testId` reads its durable result. It requires `RENDER_INSTANCE_ID`, uses the shared account lease, and preserves uncertain publications.

The temporary feature was **disabled after successful publication**. No account schedule or selected-account preference was changed.

## Validation

All **170 solution-article tests across 11 files**, TypeScript compilation, and whitespace checks passed. Live testing covered failed review/repair runs, successful review with zero issues, hosted GIF verification, the blocked HTML editor, and successful server API publication. This establishes the observed flow; provider availability and future schema changes remain external dependencies.

# Investigation: repeated form verification timeouts, 13 October 2026

## 1. Screenshot evidence

The screenshot identifies account `me_petro`, submission attempt 1/3 at 01:51,
and a CPSolver Turnstile attempt. At 01:52, the solver returns HTTP 408 with
`Turnstile challenge timed out after 60000ms without token`, then begins solver
attempt 2/3. It contains no date, timezone, seconds, contest ID, request ID,
stack trace, or final submission result. Solver attempts and submission attempts
are separate counters.

If the displayed time is IST on 13 October, the corresponding UTC interval is
20:21–20:22 on 12 October. This conversion is conditional; the screenshot alone
does not establish its timezone or date.

## 2. Actual log access and correlation limits

Read both `https://pk-coder.onrender.com/logs?limit=200` and
`https://codeforces-submit-browser.onrender.com/logs?limit=1000` during this
investigation. CPSolver retained earlier starts and warning messages. The
submitter initially retained a browser attempt for contest 112. It restarted
at `2026-10-12T20:26:53.373Z` (01:56:53 IST), clearing its in-memory history.

There was no retained CPSolver start at 20:21 UTC, nor a common identifier
linking the screenshot's `me_petro` account to the retained contest-112 attempt.
The nearby sequence below therefore **cannot be represented as an exact match**.
The repeated timeout mechanism is consistent with the screenshot, but
consistency is not proof of request identity.

## 3. Nearby chronological sequence, not a confirmed screenshot match

| UTC, 12 October | IST, 13 October | Observed event | Establishes |
| --- | --- | --- | --- |
| 20:22:29.858 | 01:52:29.858 | isolated browser preflight | Submission preparation began. |
| 20:22:36.156 | 01:52:36.156 | browser launched | A browser actually started; this is not an unclaimed GitHub job. |
| 20:22:46.553 | 01:52:46.553 | initial navigation completed, HTTP 200 | The form document was served; this does not establish successful verification. |
| 20:22:47.254 | 01:52:47.254 | submit form opened directly | Form discovery succeeded. |
| 20:22:48.054 | 01:52:48.054 | checking turnstile | Verification preparation reached the form check. |
| 20:22:48.858 | 01:52:48.858 | CPSolver starts contest 112 in harness mode | A separate synthetic host page was used for a form-token request. |
| 20:22:55.443 | 01:52:55.443 | postMessage target-origin mismatch warning | A frame messaging warning occurred; it does not identify a terminal Cloudflare error. |
| 20:22:59.245 | 01:52:59.245 | no available adapters warning | A browser warning occurred; causality is unverified. |
| 20:23:52.244 | 01:53:52.244 | challenge resource request aborted | A request was aborted late in the attempt. Cleanup can also produce this event. |
| 20:23:55.808 | 01:53:55.808 | next harness attempt starts | The caller retried. No token success was logged in this sequence. |
| 20:25:00.762 | 01:55:00.762 | third harness attempt starts | Another retry began. |
| 20:26:53.373 | 01:56:53.373 | submitter startup | The process restarted. Its reason and the prior attempt's final result are absent from the public endpoint. |

Earlier CPSolver successes used navigation mode, reported clearance cookies,
and had zero token length. A form-widget request requires a token. These are
different success conditions, so earlier clearance success does not prove that
form-token generation previously worked. No recycling/disconnection event in
the retained relevant CPSolver sequence proves that recycling caused HTTP 408.

## 4. Ranked explanations

1. **Confirmed immediate failure:** the form-token request reached the configured
   deadline without returning a token. The screenshot supplies the HTTP 408 and
   error. `solveWithHarness` constructs that error; the HTTP route maps it to 408.
   This explains the failed solver attempt but not why the remote widget did not
   issue a token.
2. **Confirmed application lifecycle defects, possible contributors to prolonged
   hangs:** the submitter's old deadline only closed the browser, while nested
   HTTP requests, retry sleeps, and fallback work remained alive. Direct HTTP
   client disconnects did not cancel submissions. CPSolver ignored active
   cancellation and its queue freed capacity on watchdog timeout while the task
   still ran. Offline regressions establish these defects. There is no retained
   trace proving that they caused the screenshot's first 60-second timeout.
3. **Confirmed diagnostic defect:** the public submitter ring omitted logs from
   the form helper and solver orchestration. Ordinary CPSolver timeout results
   had no terminal log event. This prevented a complete causal trace.
4. **Plausible, unverified:** differences between the original form's execution
   context and a synthetic host, challenge resource failures, or remote policy
   decisions could explain no token. The origin warning is a clue, not proof.
   The retained data does not distinguish these possibilities. Increasing the
   timeout, modifying fingerprints, or changing click/proxy strategies would
   not constitute an evidence-backed fix.

## 5. Source locations

- `src/codeforces/submitterService.ts`: `submit`, `submitWithinAttempt`, and the
  direct `/submit` route control browser lifetime and HTTP request ownership.
- `src/codeforces/browserForm.ts`: `ensureFormTurnstile`, `triggerSolver`, and
  `awaitSolver` initiate and await the independent solver work.
- `src/codeforces/captchaSolver.ts`: both orchestration functions execute retries
  and fallback; the HTTP and polling helpers previously used independent timers.
- `CPSolver/src/solver.ts`: `solveWithHarness` produces the screenshot's timeout;
  `executeSingleSolveAttempt` owns the context and cleanup.
- `CPSolver/src/index.ts`: `/solve` maps timeout results to HTTP 408 and observes
  response close for client disconnect.
- `CPSolver/src/queue.ts`: `run` and `dequeue` own concurrency and cancellation.

## 6. Implemented fixes and practical limits

An attempt context now carries one deadline, request ID, and cancellation signal.
Nested requests, polling delays, and retries stop when the submission expires or
its client disconnects. Browser closure and no-POST/uncertain-POST reporting share
that lifetime. Background helper rejection is observed, and attempt completion
cancels helpers left behind by a failing page operation.

CPSolver propagates active cancellation to context closure, checks it in its
loops, and keeps a concurrency slot reserved until cleanup ends. Debug screenshot
capture has a two-second bound. An uncooperative task remains counted as active;
the queue must not pretend its resources have been released.

The direct HTTP route rechecks occupancy after reading the request body, preventing
two overlapping uploads from reserving browsers on the same small service.

The submitter, form helper, and orchestration now share a bounded diagnostic ring.
Request IDs flow into CPSolver and remain attached to queued work. Solver ingress,
terminal HTTP status, and disconnect events are recorded. Submitter logs support
`?requestId=...`; credential-bearing fields are redacted.

These changes repair resource ownership and evidence collection. They do not
establish why Cloudflare withheld the token or guarantee successful third-party
verification. They do not change token acquisition strategies. Cancellation after
submission begins is reported as uncertain, preserving protection against duplicate
POSTs. Disconnecting a caller now intentionally cancels its active browser work.

## 7. Reproduction and regression verification

Run from the root checkout:

```powershell
npx vitest run tests/submissionServiceCancellation.test.ts tests/submissionAttempt.test.ts tests/submissionLog.test.ts tests/verificationDiagnostics.test.ts tests/verificationHttpLifecycle.test.ts tests/verificationCancellation.test.ts tests/codeforcesBrokerHttp.test.ts tests/codeforcesLocalRunnerMode.test.ts tests/codeforcesActionBroker.test.ts --maxWorkers=1 --minWorkers=1
npx tsc --noEmit
```

Run `npx tsc --noEmit` in `CPSolver` as well. The cancellation fixtures use mocked
network calls and browser objects, plus localhost HTTP requests. They exercise a
pending request, retry delay, expired attempt, disconnected client, cancellation
after POST initiation, overlapping uploads, queue watchdog, queued correlation,
and active context closure. No production challenge or submission is executed.

Root and `CPSolver` are separate Git repositories with different remotes. Both
service changes must be deployed for cancellation and correlation across services
to work completely. A root push cannot deploy nested CPSolver edits. The log rings
are still volatile and will be lost on process restart.

## 8. Remaining evidence needed

To resolve the actual no-token cause, preserve one full attempt with the shared ID:
original-page diagnostics, native widget error/callback observations, challenge
resource outcomes, every solver terminal response, browser cancellation/cleanup,
and the final submission result. A remote verification decision can require
server-side evidence from the site owner. Reproduce integration/callback/expiry
behavior on an owned fixture using documented test behavior; use the site's
supported browser verification flow for actual third-party verification.

This investigation does not claim that every possible edge case or the remote
token-issuance failure has been solved.

## Follow-up: the 02:14–02:16 screenshot

Both health endpoints now report the pushed revisions: submitter
`19260848308514fea988709bef99c5b1cfbd81c1`, CPSolver
`a4a1dfb9237f3b188c1dc7d086dafab506b1a294`.
The retained post-deployment submission for `me_petro` has shared request ID
`50f67e46-a929-45b4-997d-abd9b243c2b8`, contest 112. The screenshot's minute labels
are approximately one minute earlier than this server trace converted to IST;
the screenshot lacks seconds, date, timezone, and request ID. Account and operation
support correlation, but the clock discrepancy must remain explicit.

| UTC, 12 October | IST, 13 October | Confirmed event for this ID |
| --- | --- | --- |
| 20:45:44.612 | 02:15:44.612 | Submission started; browser deadline was 20:52:42.678 UTC. |
| 20:45:52.503 | 02:15:52.503 | Browser launched. |
| 20:46:04.206 | 02:16:04.206 | Form document returned HTTP 200. |
| 20:46:08.184 | 02:16:08.184 | First harness solve request received. |
| 20:47:18.674 | 02:17:18.674 | HTTP 408 after 70,490ms including work/cleanup. |
| 20:47:21.657 | 02:17:21.657 | Second solve request received. |
| 20:48:35.073 | 02:18:35.073 | HTTP 408 after 73,416ms. |
| 20:48:37.537 | 02:18:37.537 | Third solve request received. |
| 20:49:20.247 | 02:19:20.247 | Submission client disconnected; cancellation reports clicked=false. |
| 20:49:20.274 | 02:19:20.274 | CPSolver received propagated disconnect. |
| 20:49:21.170 | 02:19:21.170 | Active solver work stopped with cancellation. |
| 20:49:21.307 | 02:19:21.307 | Browser closed; terminal failure confirms no POST was sent. |

This verifies deployed cancellation behavior. It also proves that the final
cancellation occurred before the browser's deadline and was triggered by the
client connection closing. It does **not** establish why that connection closed.
The caller's logs are necessary to distinguish its configured HTTP timeout,
process restart, and network interruption. Its source uses a configurable
`CODEFORCES_SUBMITTER_TIMEOUT_MS`, default 300,000ms, capped by remaining attempt
time. The observed server lifetime was 216,696ms; treating that as proof of the
default timeout would be incorrect.

Caller-side diagnostics now record the selected HTTP budget, elapsed time,
request ID, whether its own abort signal fired, and the abort reason's name.
They intentionally omit the request payload. No timeout or challenge strategy
was changed on the basis of an unproven hypothesis.

The token failure remains the same: the synthetic harness did not produce a
form token. The original page's widget callback/error evidence and the remote
verification decision are absent. Origin-mismatch, adapter, and font warnings
do not establish a definitive cause. A supported browser verification/handoff
is the legitimate completion path when the site requires user verification.
Successful token issuance for every third-party challenge is not a behavior
this implementation can guarantee.

### Main service follow-up

The user provided `https://leetcode-daily-agent.onrender.com`. Initial `/health`
and `/logs` requests each exceeded a 20-second client timeout. A later `/logs`
request succeeded and contained only seven startup messages, beginning at
`2026-10-13T02:24:56.736+05:30`. The health server started at 02:24:57.343 and
Telegram polling started at 02:24:57.660. No entries from the disconnected
submission survived in this process's ring.

This establishes a fresh main process and missing caller history. It does not
prove the reason the connection closed at 02:19:20. Both browser services later
reported no active work: submitter busy=false, CPSolver active=0/waiting=0.

The Blueprint configures the main bot as a free web service. Render documents
that these services spin down after 15 minutes without inbound traffic and
start again on an incoming request. Telegram long polling is initiated by the
service; it is not an inbound request to the service. This makes hosting
suspension a plausible contributor, rather than a confirmed explanation of this
incident. A crash, deployment, or connection failure remains possible.
Source: https://render.com/docs/free#spinning-down-on-idle

Deployment documentation already calls for an external liveness monitor. If
Render's retained event history confirms idle suspension, ensure that monitor
targets the **main** service's `/health`, not only the isolated browser and
CPSolver. A continuously running bot requires hosting that meets its uptime
needs. No hosting plan, paid setting, or external monitor was changed here.

To settle the disconnect cause, the exact remaining resource is Render's
retained event/runtime history for `leetcode-daily-agent` around
02:19:20 IST on 13 October, including shutdown, deploy, suspension, or OOM events.
The public `/logs` endpoint cannot recover those entries after restart.

Validation of the additional caller diagnostics: the two offline
`remoteSubmitterDiagnostics.test.ts` tests passed; root TypeScript validation
and `git diff --check` passed. These fixtures test selected timeout budgeting,
shared IDs, payload omission, connection-failure classification, and protection
against retrying an uncertain POST. They do not assert a production token success.

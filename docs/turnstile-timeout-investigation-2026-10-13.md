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

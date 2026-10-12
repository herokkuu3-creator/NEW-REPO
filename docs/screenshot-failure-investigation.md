# Screenshot-specific investigation — 12 October 2026

## 1. What failed in the screenshot

The screenshot shows Cloudflare navigation orchestration: attempt 1 starts at 20:51 and reports `The operation was aborted due to timeout` at 20:52. Attempts 2 and 3 both report HTTP 500 with `Task aborted while waiting in concurrency queue` at 20:52. Commercial fallback is announced at 20:52 and reported cleared at 20:53. A preceding 20:50 notification says the preferred proxy was unreachable and pool rotation was used.

No date, timezone, seconds, request ID, target URL, stack trace, or exact duration is visible. Asia/Calcutta is the supplied user timezone, so IST is a working assumption, not screenshot evidence. The expected result was an HTTP result from CPSolver; the observed results are a client timeout followed by server-side queue cancellations.

## 2. Logs at the relevant time

The web browsing tool could not open the endpoint. A direct read-only HTTP GET to `https://pk-coder.onrender.com/logs?limit=200` succeeded with HTTP 200. Its 192 entries span 2026-10-12 11:10:32.840Z through 15:22:45.741Z (16:40:32.840–20:52:45.741 IST). Snapshot: `scratch/cpsolver-live-logs.json`. The service stores at most 200 entries in memory and does not implement historical pagination.

The snapshot includes the relevant clock window, but no request IDs or queue/HTTP completion events. Critically, the logged attempt begins at 20:52:12, while screenshot attempt 1 begins at 20:51. Therefore this is a strongly relevant service incident, not a proven exact match to the pictured first request. The screenshot date/timezone and caller-side trace are still required to resolve that discrepancy.

## 3. Chronological timeline

All times below are 12 October 2026, converted from UTC to IST by adding 05:30.

| IST time | Actual event | What it establishes |
|---|---|---|
| 20:48:58.389 | `Starting Turnstile solve attempt`, navigate, contest/381/submit | Earlier operation; not the pictured failure |
| 20:49:23.540 | `Turnstile / Cloudflare solved successfully`, duration 25151 ms, tokenLength 0, hasClearance true | Internal result classification only |
| 20:51, minute only | Screenshot attempt 1 announcement | Caller started an operation; cannot uniquely correlate |
| 20:52:12.707 | `Attempting Turnstile solve with pool proxy`, attempt 1, timeoutMs 70000; `Starting Turnstile solve attempt`, navigate, contest/385/submit | Service began a navigation attempt with pool proxy 0; proxy host matches screenshot |
| 20:52:40.448 | `Turnstile / Cloudflare solved successfully`, duration 27741 ms, tokenLength 0, hasClearance true | Success logged before awaited cleanup; does not establish HTTP delivery or application acceptance |
| 20:52:45.455 | `Recycling browser to prevent memory accumulation in 512MB cgroup`, solvesCount 50, rssMb 163, maxRssMb 380 | Solve-count threshold triggered recycle; this record does not indicate OOM |
| 20:52:45.741 | `Chromium disconnected or terminated.` | Follows intentional recycling by 286 ms; consistent with cleanup rather than the initiating failure |
| 20:52, minute only | Screenshot timeout and two queue-aborted HTTP 500s | Within-minute ordering relative to the precise service timestamps is unknown |
| 20:53, minute only | Screenshot commercial fallback success | Separate provider result; does not prove CPSolver recovered |

A subsequent read-only `/health` returned browser.isAlive=false, solvesSinceRestart=50, queue.active=0, queue.waiting=0, and status=ok. This supports a stuck browser lifecycle, although it is a later snapshot, not state captured at the screenshot instant. No later launch appears in the captured logs.

## 4. Most likely causes and alternatives

**Recycling self-deadlock: confirmed locally, strongly supported for the logged service stall.** The service closes the old browser and then calls the public `ensureBrowser()` while its own `recyclingPromise` is pending. That public method awaits the same promise. `executeSingleSolveAttempt` awaits recycling in its finally block, so a success message can precede an indefinitely withheld HTTP result. Threshold 50, deliberate disconnect, absent relaunch, and later dead browser all fit. A slow/hung browser close is an alternative live explanation because logs omit close completion; the local deterministic test proves the self-wait with a successfully resolving close. A deployed revision mismatch remains possible. The first invalid local lifecycle transition is the post-close call back into the recycle-wait gate, not the earlier zero-token result.

**Wrong HTTP close event: confirmed locally; strongly supported explanation for pictured queue errors.** The route watches `req.close`. Node emits that event on normal request completion; it does not prove client disconnection. With a response still pending, the handler aborts the signal. A queued item rejects with precisely the screenshot error; index.ts maps it to HTTP 500. An active item is no longer in the waiting array, so the same signal does not stop active work. This explains why a first request may linger while subsequent queued requests fail rapidly. Other active work could occupy the queue; the screenshot does not prove the occupant was specifically the recycling request.

Smallest discriminating experiment: two ordinary localhost POSTs with a held mock task, no browser or remote service. Original listener returns [422,500]; corrected listener returns [422,422], where 422 is the intentional fixture result. Actual client disconnection remains an alternative for a queue cancellation in isolation, but normal connected requests reproduced this defect.

**Proxy failure: unverified as the cause of these errors.** The screenshot reports an earlier proxy issue, but the relevant service attempt proceeds into result classification and recycling. Queue cancellation is local control flow; it is not a Cloudflare error code. Zero token length is not evidence of failure for a navigation/clearance operation. The log's hasClearance cannot distinguish a real cookie from this implementation's `cleared` sentinel, so genuine remote acceptance remains unverified.

## 5. Source locations

- `src/codeforces/captchaSolver.ts:800`: Cloudflare orchestration and three attempts; `:298` client timeout is request timeout plus 5000 ms; `:836` onward reports failures and retries after two seconds.
- `CPSolver/src/index.ts:181`: abort-controller wiring; route catch returns HTTP 500 for ordinary thrown errors.
- `CPSolver/src/queue.ts:57`: only queued items are removed on abort; `:90` onward races work against a 120-second timer without cancelling the underlying task.
- `CPSolver/src/solver.ts:333`: success logging; `:373` onward awaited cleanup; `:382` awaited completion/recycling.
- `CPSolver/src/browser.ts:40`: public recycle gate; `:145` onward threshold logic; `:167` onward recycling. Line numbers reflect the working tree after the small fix.
- `src/codeforces/captchaSolver.ts:864`: fallback success announcement is based on provider token/cookies, not subsequent application acceptance.

## 6. Minimal code fixes applied locally

`browser.ts`: extracted existing reuse/launch code into private `getOrLaunchBrowser()`. Public `ensureBrowser()` still waits for recycling, then delegates. Recycling calls the private method directly, avoiding its own gate. Existing launch-promise deduplication remains intact.

`index.ts`: changed `req.on('close', ...)` to `res.on('close', ...)`, retaining the `!res.writableEnded` check. Normal JSON-body completion no longer cancels queued work; premature response closure still signals cancellation.

No challenge interaction, proxy logic, token extraction, or provider integration was changed. These patches fix generic lifecycle control flow. They are not deployed. A process already stuck on the old pending promise requires restart/redeployment of the corrected revision; editing files cannot resolve that existing promise.

Side effects/limits: legitimate connected requests now actually wait in the queue, increasing queue residence compared with immediate erroneous rejection. Active-task cancellation and the queue's non-cancelling 120-second timeout remain separate defects. The recycle regression uses a mocked launch helper; actual Linux browser launch after recycling remains an integration check.

## 7. Reproduction and verification

Added `tests/verificationHttpLifecycle.test.ts`: actual Express route and localhost HTTP, mocked work/queue, no browser or external calls. Temporarily restored the original request-close handler: test failed with actual statuses [422,500], expected [422,422]. Restored the corrected response-close handler: passed.

Updated `tests/verificationDiagnostics.test.ts` recycle regression: fake connected browser closes once, concurrent recycle callers complete, launch helper runs once, and recyclingPromise clears. Three other tests retain characterization of unfixed queue/expiry defects; their passing status does not mean those defects are fixed.

Final command: `npx vitest run tests/verificationHttpLifecycle.test.ts tests/verificationDiagnostics.test.ts --maxWorkers=1 --minWorkers=1`: 5/5 passed, 20:58:33 IST, total 2.07 seconds. `npx tsc --noEmit -p CPSolver/tsconfig.json`: passed. CPSolver `git diff --check`: passed. No live solve, third-party challenge, notification, deployment, or restart was performed.

## 8. Remaining uncertainty

The exact screenshot-to-request identity is unresolved because of the 20:51 versus 20:52:12 start mismatch and absent date/timezone/request IDs. Needed: caller log slice for 20:50–20:54 on the screenshot date, including request start, configured timeout, target path, and HTTP result; confirmation of screenshot timezone/date; deployed CPSolver revision. Tokens, cookies and proxy passwords are unnecessary.

The live logs do not contain screenshot retries, HTTP response completion, browser close completion, or server-side application acceptance. The next controlled integration check should exercise 50 completions with a fake/owned page, observing recycle begin/end, replacement launch, and successful HTTP completion. This distinguishes lifecycle repair from remote verification outcomes.

References: [live log endpoint](https://pk-coder.onrender.com/logs), [Node IncomingMessage close semantics](https://nodejs.org/download/release/latest-v25.x/docs/api/http.html#event-close).


# Verification debugging report

Investigation date: 12 October 2026. Scope: current source, existing test logs, offline characterization tests. Production source was not changed. No third-party challenge, proxy, submission, or notification was contacted.

## 1. Executive summary

Four local defects were reproduced: browser recycling deadlocks, queue timeout permits overlapping work beyond its configured capacity, aborting active work does not stop it, and widget expiry leaves stale token copies. Source inspection additionally identifies false-positive clearance reporting and an early navigation return inconsistent with the later token requirement.

These are demonstrated implementation defects, not proof of the cause of the user's particular remote failure. No correlated failing request, deployed revision, service log, or application response was supplied. The old `.codex-cf-tests.log` is a Vitest transcript, not production evidence.

## 2. Execution-flow map

The root package is TypeScript/CommonJS, Node >=22, Playwright, Fastify, Prisma/PostgreSQL, cron, and Pino. Local runtime is Node v24.19.0 / npm 12.0.2 on Windows. The separately versioned `CPSolver` directory is its own Git repository: TypeScript/CommonJS, Node >=20, Express, dotenv, and Patchright ^1.63.0. Declared dependency ranges do not establish the deployed versions.

Root `src/main.ts` starts database, health, bot, and schedulers. The relevant browser integration is `src/codeforces/browserForm.ts:305` (`triggerSolver`) -> `captchaSolver.ts:650` orchestration -> `captchaSolver.ts:187` HTTP POST -> `CPSolver/src/index.ts` POST `/solve` -> `solveTurnstile` -> `ConcurrencyQueue.run` -> `executeSingleSolveAttempt` -> singleton `BrowserManager.createContext` -> ephemeral context/page -> harness or navigation -> result predicate -> screenshot/page/context cleanup -> optional browser recycle -> HTTP result -> backend result predicate -> browser integration -> application submission and verification (`src/codeforces/submission.ts:141`). This report traces verification and its immediate caller, not every scheduler or submission branch.

Harness mode replaces main-document responses with synthetic HTML. It does not load the real application's document or prove application acceptance. Navigation mode loads the requested page. Token extraction checks the title, page globals/API/inputs, then frames. Many exceptions become null/empty values. Harness mode has console and request-failure logging; navigation does not provide equivalent diagnostics.

Configuration: CPSolver uses PORT, HOST, DEFAULT_TIMEOUT_MS (75000), MAX_CONCURRENT_SOLVES (1), MAX_QUEUE_SIZE (10), MAX_SOLVES_BEFORE_RECYCLE (50), MAX_RSS_MB (380), HEADLESS (true only for the exact string `true`), PROXY_URL/SERVER/USERNAME/PASSWORD, and pool precedence PROXIES -> PROXY_LIST -> PROXY_URL. Caller uses CPSOLVER_URL / TURNSTILE_SOLVER_URL, CPSOLVER_MAX_TRIES (3), CPSOLVER_TIMEOUT_MS (90000). Request mode, timeout, sitekey, cookies, proxy, and userAgent also alter execution. Actual deployed values were not read.

Docker targets Linux with Xvfb, headed Chromium, and a 192 MB Node heap. Browser launch has a 30-second timeout. Parent-process RSS drives recycling; it does not measure total Chromium/container memory. This is a measurement limitation, not demonstrated OOM evidence.

## 3. Failure timeline

No production timestamps can be reconstructed. The following is the code-defined lifecycle; statuses distinguish local evidence from unverified live behavior.

| Stage | Expected | Observed evidence / status | Missing evidence |
|---|---|---|---|
| Request/queue | Validate and enqueue work | URL/sitekey checked; other types weakly validated; active abort ignored (reproduced) | Sanitized request, queue wait |
| Browser initialization | Launch/reuse connected browser | Launch mutex exists; recycling later deadlocks (reproduced) | Launch stderr, revision, browser version |
| Session setup | Establish intended application context | New context; `cf_`/`__cf` input cookies filtered; form caller explicitly passes `cookies: undefined` | Cookie metadata and intended session contract |
| Navigation | Load expected document | Harness fulfills document itself; navigation uses DOMContentLoaded with up to 25s timeout | Final URL, document status, redirects |
| Readiness/interface | Confirm expected application/widget | Navigation relies partly on title/URL; no positive application-ready check | DOM state and widget callbacks |
| Interaction | Wait for legitimate test-widget outcome | Automated interaction helpers are called; not executed here | Owned test-page callback trace |
| Async completion | Keep only current results | Expiry retains title/input copies (reproduced) | Callback ordering and issuance age |
| Result handling | Distinguish token, cookie, and acceptance | Literal `cleared` can be called clearance; token-required branch can return early without token (source-confirmed) | Result classification plus server validation |
| Application response | Establish actual acceptance | Solver result alone cannot do this; application submission is downstream | Sanitized application rejection/acceptance response |
| Cleanup/retry | Close context and return before next work | Recycling can block the return; queue timeout frees capacity without stopping work (reproduced) | Cleanup timestamps and live work count |

Reproduced recycle sequence: connected browser -> `recycle()` assigns pending promise -> awaits old browser close -> `ensureBrowser()` awaits that same pending promise -> recycle cannot finish. `executeSingleSolveAttempt` awaits `notifySolveCompleted` in `finally`, so even an already prepared result cannot return. After 120 seconds the queue rejects the caller and releases capacity, but the original task remains pending. Subsequent work can also wait on the stuck recycle promise. First launch without recycling is a different path and was not shown to fail.

## 4. Root causes, ranked

1. **Confirmed, reproduced: recycling self-deadlock.** `CPSolver/src/browser.ts:40,163,172,181`; `solver.ts:382`. The closing browser yields before `ensureBrowser`, which then awaits `recyclingPromise`. Offline fake browser close resolves immediately, yet recycle never reaches launch or completion. This explains threshold-related stalls, not necessarily first-request failures. Experiment: isolated manager with fake connected browser; expected healthy outcome is completion and a new launch, observed outcome is pending with no launch.

2. **Confirmed, reproduced: queue timeout is not work cancellation.** `CPSolver/src/queue.ts` races the task against 120s, then decrements active count. A held task remains alive while its successor runs: configured capacity 1, observed work count 2. This requires a task outlasting the timeout; ordinary fast tasks still obey capacity. Experiment uses fake time and a held promise; healthy outcome is no replacement until the old work terminates.

3. **Confirmed, reproduced: expired token copies remain readable.** `solver.ts:95,106,149`. Expiry clears only `window.__turnstileToken`; extraction checks the title first and later inputs. Executing the actual embedded callback script in a VM leaves both unchanged after expiry. Remote rejection is not demonstrated: it depends on whether expiration happens before extraction/use. Healthy outcome is clearing every cached copy and refusing expired state.

4. **Confirmed, reproduced: abort only removes waiting work.** `queue.ts:57` onward checks whether the item is still in the waiting array. Once running, abort does nothing; `solveTurnstile` passes the signal only to the queue. Held active work resolves normally after abort. Whether the HTTP listener fires at the desired disconnect moment is separately unverified; do not equate the request `close` event with a proven disconnected response.

5. **Confirmed in source, runtime unverified: false clearance evidence.** `solver.ts:694-709` returns the literal `cleared` after four seconds if certain title/URL markers are absent. `solver.ts:322` and `index.ts:204` treat nonempty clearance as success. This can classify an ordinary error/login document as success, without a real clearance cookie. A legitimate already-accessible page is an alternative explanation for the same DOM state, so absence of a challenge is not enough to distinguish them. Small experiment: mock ordinary 403 and 200 documents with no cookies; both must remain distinct from validated clearance.

6. **Confirmed in source, runtime unverified: premature return for token-required navigation.** `solver.ts:681-686,694-709` permits early clearance/page-transition results for a URL containing `codeforces.com`, including a form sitekey. `solver.ts:328` then rejects that result because it requires a token. This affects navigation requests with that combination; default form requests use harness mode, so it is not universal. Experiment: mock clearance followed by a delayed widget callback; record the state transition and whether the result returns before the callback. Do not run this against a third-party challenge.

Additional source-supported issues: the harness-to-navigation fallback leaves its document fulfillment route installed (`solver.ts:295`), so that fallback can still receive synthetic HTML; elapsed time starts before enqueue but navigation gets a fresh relative timeout; cookie export drops domain/path/expiry by using a name-only record; modeUsed is not updated after fallback. Each needs an isolated fixture before attribution to an incident. Error code 600010's interpretation in a comment is not independently established here.

## 5. Evidence

Added `tests/verificationDiagnostics.test.ts`: four executable characterization tests importing actual queue/browser code and executing the actual embedded callback script. They intentionally assert current faulty behavior. Their passing status means reproduction, not remediation.

Existing `.codex-cf-tests.log` begins with Vitest invocation and contains challenge messages dated 5 October 2026. Those messages cannot establish a live failure on the present revision. No raw secrets, cookie values, or real verification tokens were needed for this investigation.

## 6. Unresolved questions

Which request fails (harness, navigation, initial launch, or after recycling)? Which commit is deployed in each repository? Is the observed symptom a timeout, widget error, HTTP rejection, or application rejection? There is no evidence here establishing DNS/TLS/proxy failure, remote detection decisions, or token validation failure.

Cloudflare requires server-side validation; tokens are single-use and expire after 300 seconds. A string-length predicate is only a shape check. The application owning the secret must establish validation and expected hostname/action; a separate browser service cannot infer those results. See [server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) and [official testing keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).

## 7. Minimal fixes proposed

No production implementation was changed. These are proposals, not tested fixes; the investigation deliberately does not improve third-party challenge interaction, fingerprint masking, token injection, or proxy evasion.

For a controlled integration, separate browser launching from the public recycle-wait gate so recycling cannot await itself. Make task cancellation cooperative and retain capacity until work actually terminates. Clear every cached token copy on expiry and use explicit lifecycle state. Represent page accessibility, cookie presence, client callback, server validation, and application acceptance as separate outcomes; never synthesize a clearance-cookie value. Reject invalid request/configuration types before browser allocation.

Add structured events with request ID, stage, mode requested/actual, queued/start/end times, HTTP status, sanitized URL, browser version, error name/code, callback state, and cleanup duration. Record token presence/age only, never its value. Correlate application validation and acceptance separately. Do not infer a proxy failure from a generic widget timeout.

## 8. Regression plan

Convert characterization expectations to healthy behavior when each approved scoped fix is implemented: recycle completes and launches exactly once; simultaneous recycle callers share completion; timeout never permits excess live work; queued and active cancellation have explicit outcomes; expiry clears all copies. Add mocked result-contract tests for ordinary error pages, valid application pages, clearance-only results, delayed callbacks, and invalid/expired/duplicate server-validation responses. Use Cloudflare test keys on an owned localhost page for integration coverage, with a matching test secret. Test keys cannot establish production challenge behavior.

## 9. Verification results

- `npx tsc --noEmit -p CPSolver/tsconfig.json`: passed, exit 0.
- Initial combined Vitest run: existing orchestration 8/8 and initial diagnostics 3/3 passed (11 total).
- Final diagnostics after adding recycle reproduction: 4/4 passed, exit 0, 12 October 2026 at 20:44:59 IST; test time 10 ms, total runner duration 1.71 s.
- Existing orchestration tests mock fetch, including notification and provider calls; none of those services was contacted.
- Full root suite, Docker build, actual browser launch, and live verification were not run. `CPSolver/test/sanity.test.ts` mixes unit assertions with live browser/widget tests, so it was not treated as an offline suite.

## 10. Next diagnostic step

Provide one sanitized failing request/response and the matching CPSolver log slice from `Starting Turnstile solve attempt` through failure or the last cleanup/recycling event, plus the deployed CPSolver commit. Preserve timestamps, mode, timeout, HTTP status and error codes; remove tokens, cookie values, and proxy credentials. This distinguishes the reproduced recycle/queue stall from an earlier navigation or widget failure without guessing about remote behavior.

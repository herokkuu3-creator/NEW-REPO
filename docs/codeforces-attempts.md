# Codeforces attempt limits

Each browser submission attempt has an eight-minute budget, including broker
wakeup, GitHub waiting, browser work and verdict polling. The browser closes
before that deadline to leave time for result delivery. GitHub's job also has
an eight-minute timeout. Native Codeforces form filling and submission remain
the restored morning implementation.

The worker retries the same account and source up to three total attempts if
the result confirms that no submission was sent. A successful account is not
repeated while another account retries. Final judge verdicts, duplicate-code
responses and signed-out sessions do not trigger transport retries. Turnstile,
CAPTCHA, Cloudflare challenge and HTTP 403 failures also stop immediately;
they are not retried through alternate submit URLs or browser jobs.

A batch pauses the affected account after an unconfirmed submission, delivers
its final outcome to Telegram and continues with the other selected accounts.
The current source remains pending. It is never marked completed merely
because two attempts failed. Confirmed terminal judge verdicts and exact-code
duplicates still advance to the next source.

The Codeforces browser uses its native user agent, Client Hints and automation
defaults. It does not inject fingerprint overrides, perform simulated browsing
on the homepage, or click verification controls. Existing native form filling
and enabled-button checks are retained. Saved cookies are restored as supplied
instead of unconditionally deleting Cloudflare cookies on every proxy launch.

The broker atomically authorizes the runner immediately before its single
submit click. A timed-out job can be cancelled before authorization, and its
late runner cannot post. Older runners without this protocol can only be
cancelled before they claim their payload. Once a POST may have happened, the
worker checks Codeforces history within the remaining attempt budget rather
than creating another submission. Unknown results retain the current source.

Telegram distinguishes attempt number, waiting for GitHub, running browser,
retrying, verdict polling and final result. Progress messages keep complete
rows within Telegram's message limit. A failed final-result edit falls back to
a result message. The account list records the most recent completed check;
its error can predate a currently running attempt.

Deploy both Render services from the new main commit before testing. The
broker and GitHub runner need the same authorization protocol. Tests exercise
timeouts, atomic cancellation, retries, multi-account progress and ambiguous
POSTs with fixtures; an actual cloud submission remains a deployment check.

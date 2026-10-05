# Daily cloud browser sessions

The GitHub runner preserves per-account Playwright storage state: cookies,
local storage and IndexedDB. This is not a full Chrome profile; disk cache,
session storage and browser fingerprint are not persisted. An accepted session
does not guarantee future Cloudflare verification will pass.

Only AES-256-GCM encrypted files are saved in the Actions cache. The existing
`CODEFORCES_SUBMITTER_TOKEN` secret supplies the encryption key. No additional
secret is required. Cache entries are isolated by account label, uploaded
session contents, selected network route and browser version. Renewing cookies,
changing proxy credentials, switching routes or upgrading the browser starts
fresh. State older than seven days is ignored. Missing, damaged or
undecryptable state falls back to the uploaded session.

Keep `CODEFORCES_RESIDENTIAL_PROXY` set to the same static endpoint for daily
runs. Rotating endpoints can change the external IP even if their URL stays
the same. State restoration does not pin the external IP.

The runner waits up to 45 seconds for normal verification. Preparation may
retry once after ten seconds, before the submit click. A submit POST is never
retried here. Existing daily retries remain bounded by the scheduler and its
submission-history checks. Interactive verification is reported as blocked;
tokens are never forged and challenges are not solved by external services.

Runner phases are delivered to the authenticated broker and polled by the bot
to edit `/submitnextsolution` progress. Progress delivery failures do not change
submission results. Daily summaries continue to report account failures.

Encrypted cache storage is best-effort: GitHub can evict older entries, and a
runner crash before saving can discard state. The next job still works from the
uploaded cookies. Rotating the submitter token invalidates old encrypted state.

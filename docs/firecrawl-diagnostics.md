# Firecrawl server diagnostic

`POST /admin/solutions/firecrawl/test` uses the existing `Authorization: Bearer SETUP_TOKEN` admin gate.
Send JSON `{ "apiKey": "fc-your-key" }`. The key is used only for this request, never saved in the article key pool.
The route rejects alternate URLs, origins and options. It sends one bounded Markdown scrape of `https://example.com`
to the fixed `https://api.firecrawl.dev/v2/scrape` endpoint. This can consume one scrape credit.

Alternatively, send `/testfirecrawl fc-your-key` in the bot's authorized Telegram chat.
The existing sensitive-message deletion helper is invoked before the command runs; deletion is best effort.
The result is logged as `Firecrawl server probe` without the key, raw upstream errors, or scraped content.

The response includes `executionHost`, `revision`, `testedAt`, HTTP status, elapsed time,
content checks and failure category. HTTP 200 alone is insufficient: Firecrawl must report success,
return the expected page content, and not report a failed target-page status.
`onlyMainContent` can omit the heading, so the distinctive example-domain body is also accepted.

This verifies credential access and one scrape from the executing host. It does not enable Firecrawl
as an LLM provider, guarantee access to LeetCode pages, or verify the article/GIF/publishing pipeline.
Firecrawl supplies source content; the configured LLM still generates the article.

## Verification on 1 November 2026

The supplied key completed a real local request at 08:16:26 UTC / 13:46:26 IST:
HTTP 200, `success: true`, target HTTP 200, 959 Markdown characters, expected page body,
1,031 ms, `SCRAPE_OK`. No key was saved in source or the article pool.
An earlier local result was rejected because the heading was absent from main content;
the validator now checks the distinctive body as well, with a regression test.

The live admin API returned HTTP 401 without its admin credential. Git authentication
was unavailable when preparing this change. These local results do not establish deployment
or a successful request from Render; the live probe remains to be run after access is restored.

Validation: 28 focused Firecrawl/route/command tests and 7 existing submission-command tests passed.
The TypeScript build passed. A broader Telegram poller test failed its handover assertion;
running that suite with the unchanged HEAD version of `telegramBot.ts` reproduced the failure.
The Firecrawl change does not modify polling ownership or handover behavior.

References: [scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape),
[credit usage](https://docs.firecrawl.dev/api-reference/endpoint/credit-usage).

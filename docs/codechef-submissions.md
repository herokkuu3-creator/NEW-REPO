# CodeChef submissions

Set `CODECHEF_1=username::password`, `CODECHEF_2=username::password`, etc. in the
main Render service. Values must stay in Render's environment, not in the repo.
The service seeds these accounts in Postgres and refreshes saved credentials when
an environment value changes. Browser cookies are saved only after login is
verified. All browser resources are closed after each account.

Deploy the latest main branch. Migration `0005_codechef` creates the three
CodeChef tables and two enums. It adds no changes to LeetCode or Codeforces tables.
The Docker image now includes `codechef-solutions`.

`/codechef` starts the worker from Telegram and sends its account results.
`npm run codechef:run` runs it locally with the configured environment. The automatic
schedule is ten minutes after the configured LeetCode start time, in the same
timezone. If LeetCode is still running or memory is too low, the automatic worker
defers and checks again every five minutes, up to ten times.

The source index accepts C++ files next to a README containing a direct CodeChef
problem URL or a contest problem URL. It deduplicates problem codes and stores
portable paths. Unresolved directories are audited but not submitted. The current
checkout resolves 240 of 360 directories with this structure; files without a
usable problem link require their README to be corrected before reindexing.

The browser selects C++, fills the Ace editor (with Monaco support for other page
versions), clicks Submit once, and waits for a submission ID and a final verdict.
Any confirmed terminal verdict advances to the next source, including WA/TLE/CE/RE.
The daily claim permits one performed source per account per day. Preparation or
login failures release the claim so a later command can try again. An ambiguous
click keeps today's claim; the bot does not retry a possibly sent submission.

These changes were checked against the public login/submit page structure and
local browser fixtures. A live authenticated CodeChef submission is still required
to verify the site's current judge-response format. If login requires additional
verification, or the judge response is not recognized, the bot reports failure
instead of claiming acceptance from unrelated page text.

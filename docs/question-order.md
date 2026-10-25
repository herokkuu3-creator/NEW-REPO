# Per-account shuffled submission order

Question ordering is automatic for the existing Telegram range/batch commands:

- LeetCode `/questionrangesubmission 50-100`: each account receives its own
  Fisher-Yates permutation of all 51 selected question numbers.
- Codeforces `/cfrange N`: shuffle the next N source entries for each account.
- CodeChef `/ccrange N`: shuffle the next N source entries for each account.

Every permutation contains the original selected candidates once. Independent
random permutations can occasionally coincide; they do not guarantee that two
accounts will never select the same question. Single-question requests have no
alternative order.

Progress reports count completed positions rather than assuming question IDs
increase. Cancellation and early stops report the actual unattempted question
set. Existing submission retries stay on the same question.

Codeforces and CodeChef persist the current permutation in `SystemState` under
`question-order:v1:<platform>:<accountId>`. An interrupted batch resumes that
order, including when resumed by a single-question daily run. The source queue's
already-completed prefix and untouched suffix retain their order. Completed
batches move to the following source window; exhaustion does not restart the
queue. If a saved order is corrupt or its unfinished source window has changed,
the run stops before submitting and preserves progress for operator review.

LeetCode ranges use the existing job lifecycle: a new explicitly requested range
gets a new permutation. This does not add persistence/recovery to LeetCode range
jobs themselves.

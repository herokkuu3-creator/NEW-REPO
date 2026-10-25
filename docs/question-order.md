# Per-account shuffled submission order

Question ordering is automatic for the existing Telegram range/batch commands:

- LeetCode `/questionrangesubmission 50-100`: each account receives its own
  permutation of all 51 selected question numbers, in both sequential and
  parallel modes. The job shuffles starting questions once and assigns different
  starts to successive accounts until the range is exhausted, then independently
  shuffles each account's remaining questions.
- Codeforces `/cfrange N`: shuffle the next N source entries for each account.
- CodeChef `/ccrange N`: shuffle the next N source entries for each account.

Every permutation contains the original selected candidates once. Independent
random permutations can occasionally coincide on Codeforces/CodeChef.
Single-question requests have no alternative order.

Parallel LeetCode workers share a question reservation pool. A worker selects an
unreserved question from its remaining candidates, and holds the reservation
through source loading, submission, judging, and retries. It releases the question
after that attempt finishes, including errors and cancellation. If all remaining
questions are reserved, the worker waits without polling; `/cancelrange` wakes
waiting workers. No two workers in the same range job process a question at once.
Accounts still eventually complete the entire selected range, so the same question
can appear later for another account. A one-question range necessarily runs that
question sequentially across accounts.

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

The log message `range question scheduling configured` identifies the scheduler as
`distinct-starts-with-question-reservations` and records each account's planned
first question. `range question reserved` records the account ID, actual selected
question and step number. These messages distinguish this implementation from
older deployed revisions.

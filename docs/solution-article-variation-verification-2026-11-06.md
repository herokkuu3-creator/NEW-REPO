# Server article presentation verification — 6 November 2026

Both successful test articles were created by the deployed application on `leetcode-daily-agent-ascq.onrender.com`, using `publicationMode: daily`. Local commands only called authenticated control/read endpoints. They did not publish to LeetCode from the local IP.

| Account | Article | Verified publication time (IST) | Presentation |
|---|---|---|---|
| dom4429 | [Sorted Halves](https://leetcode.com/problems/find-the-distance-value-between-two-arrays/solutions/8603303/sorted-halves-probing-the-middle-to-guar-ks5p/) | 09:24:43.496 | Notebook; strip + ledger; aurora/ocean |
| watch_me_win | [Active-Server Window](https://leetcode.com/problems/count-zero-request-servers/solutions/8603327/active-server-window-two-pointers-by-wat-frg9/) | 10:10:21.023 | Reader questions; ledger + focus; sunset/violet |

The verified timestamps are **2,737.527 seconds apart (45 minutes 37.527 seconds)**. Both exceed the daily minimum of 1,200 seconds. Manual publication keeps its immediate path.

## Production evidence

- First post: `cmw4d8ytl0001ujfivxptxkbx`; server test `068e9c16-0cde-406b-bfd4-df1fc63e8ca2`; revision `a7a3ade47e2609a02cc40602eb5d0480faa7cd1f`.
- Second post: `cmw4hcrmi0001gr96mzb9gi80`; server test `3fdad76a-cabe-4b69-82dc-d5c74fe773cd`; revision `5274c5442800e8c1d7d150cd159a3cbd8296b6f3`.
- Both durable records are `PUBLISHED`, with a successful `qwen3.8-27b` technical verdict and matching approved/content hashes. The publisher verified exact title, Markdown, source and authenticated author through LeetCode's API.
- Neither title includes its question name. The actual Markdown uses different headings, section ordering and visual treatments.
- The daily gate retained the first publication's `09:44:43.496 IST` eligibility time across deployments. Boundary, restart, concurrent-worker and uncertain-result behavior were also exercised with fake-clock unit tests.
- All four public GIFs returned HTTP 200, `image/gif`, and `GIF89a`. Each is 720×360, animated, below 125 KB, and has a different SHA-256 content address. The first article has six frames per GIF; the second has nine.
- Actual first/final GIF frames were inspected for both articles. The temporary server-test control was disabled after the successful runs.

| GIF hash | Bytes | Frames |
|---|---:|---:|
| `1c7392b2bafd5a5b0afae5f67bdb665911ae3dce4bc5b4d21a0a0db85b50f20f` | 99,647 | 6 |
| `c363c46baa3ea6d63deff6128958c2c29f95ca0a3d8e442a14dcb872ea028657` | 102,110 | 6 |
| `05150333d73980b5ef170c0fe930924358b931fe5529b30cfa61c696912e2471` | 123,064 | 9 |
| `259ecae7532f09f74a6e623438f8a7bf3a923fc488c595656ac3d06d4cae8135` | 122,217 | 9 |

## Failures found and handled

Reasoning-only truncation, provider timeouts, conflicting animation/article title lengths, scalar highlight indices, unchanged animation frames, overlong repairs and incorrect arithmetic/early-exit explanations were observed during server tests. The fixes retain strict source, factual-review, approval and publication checks. Cosmetic normalization never changes numeric trace states. Rejected factual content is repaired before another independent verdict.

One candidate, `dom9090` / `cmw4g5by70001il52tuin8gu1`, passed review but returned an uncertain publication result without a URL. Server reconciliation and a complete account-scoped scan found no visible matching article. Its record remains `PUBLISHING`; no second mutation or local publication was attempted. This is an unresolved account/request outcome, not one of the two verified publications above. A later server query confirmed `isSignedIn: true` and `isVerified: true`, so lack of basic account verification does not explain it. The original response was not retained by the old catch handler, so its exact rejection reason cannot be recovered from those logs. New diagnostics retain safe API failure reasons. Future lost responses get an immediate read-only reconciliation attempt and remain protected if no exact article can be verified.

`dom6969` was already leased by another account job. That test stopped before generation; the existing lease was preserved.

Coordinated upvote automation was not implemented.

## Validation and hosting

`npx vitest run solutionPost solutionSharing --maxWorkers=2 --minWorkers=1`: **207 tests passed across 15 files**. `npm run build` passed. This includes the final heartbeat, read-only reconciliation and account-verification diagnostic changes; successful public articles above were generated before the final heartbeat deployment.

Render documents a 15-minute idle spin-down on free services: [free service limits](https://render.com/docs/free). Scoped health traffic protects work already in progress during a 20-minute cooldown. It cannot initiate a 06:00 job on a sleeping instance. The external wake workflow remains staged in `docs/daily-solution-wake.yml`; the available git credential lacks workflow permission, and the connected GitHub integration rejected workflow creation (403 for the primary repository; 404 for the mirror).

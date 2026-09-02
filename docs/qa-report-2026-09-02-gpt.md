# QA report: Alu-Value social queue

## Verdict

DO NOT SHIP. The queue timing is safe, but the system is not idempotent and can silently miss or duplicate posts after a crash, a lost response, or a failed Git push.

## Checks I ran

| Check | Command or method | Result |
|---|---|---|
| Top-up logic | Read `system/scripts/topup.mjs` line by line with `nl -ba` and traced every state change and exit path. | Failed. Buffer creation happens before durable state. Several errors still end with exit code 0. |
| Buffer client | Read `system/scripts/buffer.mjs` line by line. | The list call paginates. The create call has no idempotency key. Network and GraphQL failures have different paths. |
| Workflow | Read `system/.github/workflows/topup.yml` line by line. Read the two live workflow runs with `gh run list` and `gh run view`. | The workflow syntax ran successfully. `contents: write` is present. The fixed concurrency group serializes workflow runs. The latest observed push to `main` succeeded. A normal run commits even when it adds no post. |
| Branch state | Read the public repo metadata and branch protection with `gh api`. | `main` is not protected. This allows the Action push, but it does not prevent another writer from causing a non-fast-forward push failure. |
| Dry-run expression | Traced `${{ inputs.dryRun && '--dry-run' || '' }}` and `${{ !inputs.dryRun }}` for scheduled, manual false, and manual true events. | Correct for these three cases. A scheduled or manual false run writes state. A manual true run does not write state. |
| Live organization and channels | Ran the supplied read-only `bufread.mjs` organization and channel queries. | One organization exists. Instagram is `business`, connected, and unlocked. Facebook is a connected, unlocked page. The channel IDs are `6a97fb07065799be4672732d` for Instagram and `6a97f4b3065799be467250e1` for Facebook. |
| Live scheduled posts | Ran the supplied read-only posts query several times and compared IDs, dates, and channels with the live `state.json` and `posts.json`. | Final observation: 10 scheduled posts exist for days 1 to 5. All 10 have the planned `dueAt` and channel ID. During QA, the day 5 Facebook ID changed. A separate run added the replacement and saved the new ID. No duplicate was present in the final query. |
| Buffer statuses | Ran a read-only GraphQL schema query through `bufread.mjs`. | `PostStatus` has six values: `draft`, `error`, `needs_approval`, `scheduled`, `sending`, and `sent`. The three list calls cover all six current values. |
| All 30 local dates | Ran a Node date check over every item in `system/posts.json`. | Passed. All 30 dates have the correct weekday or weekend UTC time. All Facebook times are 20 minutes after Instagram. |
| Picture links | Ran `node system/scripts/check-images.mjs`. Also ran explicit HEAD requests for days 1, 7, 15, 23, and 30. | All 33 unique URLs were reachable. Each of the five explicit checks returned HTTP 200 and `image/png`. |
| Queue runway | Simulated the daily two-post drain and the next `17 */6 * * *` refill from the observed 10-item starting queue. | Passed when each needed cron run succeeds. The queue does not become empty before the final post. |
| Failure and duplicate paths | Traced crash, response-loss, partial-loop, bad-state, failed-push, and overlapping-run cases against the exact write order. | Failed. The live Buffer state is not used to recover an unrecorded planned post. |

## Findings

### Blocker: a successful Buffer create can become a duplicate

- **What breaks:** The claim that the routine never creates the same post twice is false.
- **Trigger:** Buffer accepts a create, but the process crashes before line 129. The same problem occurs when the response is lost, an unhandled error occurs after one or more creates, or the Git push fails after Buffer accepted posts. It also occurs if `state.json` is missing or invalid, because the broad catch resets the state to empty. A later run sees the plan key as missing. When a queue slot opens, it creates that post again.
- **File and line:** `system/scripts/topup.mjs:40-42`, `system/scripts/topup.mjs:88-89`, `system/scripts/topup.mjs:109-115`, `system/scripts/topup.mjs:129`; `system/.github/workflows/topup.yml:42-51`.
- **Smallest fix:** Before every create, reconcile planned posts against Buffer by a stable fingerprint such as channel ID, due time, and text hash. Record any match in state. Fail on more than one match. Reject an unreadable state file instead of treating it as empty. Use an API idempotency key too if Buffer supports one.

The workflow concurrency group prevents two runs of this workflow from running at once. It does not protect a local run, another workflow, a lost response, a process crash, or the gap between the Buffer create and the Git push.

### High: failed and skipped posts do not raise an alarm

- **What breaks:** A campaign post can fail to publish or be skipped, but the workflow can stay green. Nobody is guaranteed to find out. The failed post is kept in `state.created`, so the routine does not retry it.
- **Trigger:** Buffer changes a remembered post to `error`. The script only prints `ERROR`. It then writes state and exits successfully. A post that is less than 30 minutes away or already late is stored in `state.failed`, but this also does not fail the run.
- **File and line:** `system/scripts/topup.mjs:68-75`, `system/scripts/topup.mjs:90-93`, `system/scripts/topup.mjs:125-130`; `system/.github/workflows/topup.yml:35-51`.
- **Smallest fix:** Exit non-zero when a campaign post is in `error` or `state.failed`. Add one explicit alert target for failed workflows. Keep the post failed until a person or a tested retry rule resolves it.

### High: some Buffer create failures are reported as success

- **What breaks:** The queue can drain while each Action run appears successful.
- **Trigger:** `createPost` throws a `BufferError`, including a GraphQL error or an invalid response. Line 110 prints `STOP` and breaks the loop. The script then writes state and exits with code 0. Repeated errors cause no refill.
- **File and line:** `system/scripts/topup.mjs:109-110`, `system/scripts/topup.mjs:125-130`; `system/scripts/buffer.mjs:12-16`.
- **Smallest fix:** Only treat a known queue-limit response as a clean stop. Rethrow every other `BufferError` so the Action fails and alerts.

### High: the Git push has no conflict recovery

- **What breaks:** Buffer can contain newly created posts while Git still has the old state. This feeds the duplicate path in the blocker finding.
- **Trigger:** `main` changes after checkout and before `git push`. The static concurrency group blocks overlap only inside this workflow. A local run, another workflow, or a person can still update `main`. The push then fails as non-fast-forward after Buffer has already changed.
- **File and line:** `system/.github/workflows/topup.yml:15-17`, `system/.github/workflows/topup.yml:26`, `system/.github/workflows/topup.yml:42-51`.
- **Smallest fix:** Make live Buffer reconciliation the recovery control. Then retry the state commit from current `main`. Do not rely on Git state alone for exactly-once behavior.

### Medium: account and channel selection is not pinned

- **What breaks:** Posts can go to the wrong organization or wrong social channel if the Buffer account later gains another organization or another connected channel of the same service.
- **Trigger:** Organization order changes, or more than one connected Instagram or Facebook channel exists. The code selects the first organization and the first channel for each service.
- **File and line:** `system/scripts/buffer.mjs:20-25`; `system/scripts/topup.mjs:47-58`.
- **Smallest fix:** Pin organization ID and both stable service IDs in config. Fail if the exact targets are missing or if selection is ambiguous.

Current live state is safe for this finding. I observed one organization and exactly one connected channel for each wanted service.

### Medium: picture checks do not guarantee publish-day availability

- **What breaks:** An already scheduled post can fail if its `main` branch picture URL changes or disappears after the last check. The check cannot repair a scheduled post, and the current error handling does not alert.
- **Trigger:** The repo becomes private, is renamed, removes a picture, rewrites `main`, or GitHub has an outage when Buffer fetches the picture.
- **File and line:** `system/posts.json` asset URLs; `system/scripts/check-images.mjs:10-19`; `system/.github/workflows/topup.yml:32-33`.
- **Smallest fix:** Pin asset URLs to an immutable commit SHA. Keep the reachability check. Make any campaign publish error fail and alert.

### Low: every live run creates a Git commit

- **What breaks:** The repo gains about four state commits per day even when no post was added. This adds noise and gives unrelated writers more chances to conflict.
- **Trigger:** Every non-dry run. Lines 126 to 129 always change `runs` and `updatedAt`, so the workflow's `git diff --quiet` check is normally false.
- **File and line:** `system/scripts/topup.mjs:125-129`; `system/.github/workflows/topup.yml:41-51`.
- **Smallest fix:** Only write and commit state when `created`, `failed`, or reconciliation data changed. Put run logs in Action output.

No current Buffer status is missing from reconciliation. The schema query showed exactly six statuses, and the code covers all six. A future new Buffer status would need a code update.

## Runway arithmetic

Starting state is 10 items, which is five days with two channels per day.

On a weekday, Instagram sends at 16:00Z and leaves 9 items. Facebook sends at 16:20Z and leaves 8. The 18:17Z cron adds the next two items. The low point lasts 1 hour and 57 minutes.

On a weekend, Instagram sends at 07:00Z and leaves 9 items. Facebook sends at 07:20Z and leaves 8. The 12:17Z cron adds the next two items. The low point lasts 4 hours and 57 minutes. This is the tightest repeating refill window.

| Day | Date | Type | Times in UTC | Before | After both send | Added at next cron | After cron |
|---:|---|---|---|---:|---:|---:|---:|
| 1 | 2026-09-07 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 2 | 2026-09-08 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 3 | 2026-09-09 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 4 | 2026-09-10 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 5 | 2026-09-11 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 6 | 2026-09-12 | Weekend | 07:00, 07:20 | 10 | 8 | 2 | 10 |
| 7 | 2026-09-13 | Weekend | 07:00, 07:20 | 10 | 8 | 2 | 10 |
| 8 | 2026-09-14 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 9 | 2026-09-15 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 10 | 2026-09-16 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 11 | 2026-09-17 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 12 | 2026-09-18 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 13 | 2026-09-19 | Weekend | 07:00, 07:20 | 10 | 8 | 2 | 10 |
| 14 | 2026-09-20 | Weekend | 07:00, 07:20 | 10 | 8 | 2 | 10 |
| 15 | 2026-09-21 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 16 | 2026-09-22 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 17 | 2026-09-23 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 18 | 2026-09-24 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 19 | 2026-09-25 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 20 | 2026-09-26 | Weekend | 07:00, 07:20 | 10 | 8 | 2 | 10 |
| 21 | 2026-09-27 | Weekend | 07:00, 07:20 | 10 | 8 | 2 | 10 |
| 22 | 2026-09-28 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 23 | 2026-09-29 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 24 | 2026-09-30 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 25 | 2026-10-01 | Weekday | 16:00, 16:20 | 10 | 8 | 2 | 10 |
| 26 | 2026-10-02 | Weekday | 16:00, 16:20 | 10 | 8 | 0 | 8 |
| 27 | 2026-10-03 | Weekend | 07:00, 07:20 | 8 | 6 | 0 | 6 |
| 28 | 2026-10-04 | Weekend | 07:00, 07:20 | 6 | 4 | 0 | 4 |
| 29 | 2026-10-05 | Weekday | 16:00, 16:20 | 4 | 2 | 0 | 2 |
| 30 | 2026-10-06 | Weekday | 16:00, 16:20 | 2 | 0 | 0 | 0 |

The queue reaches zero only after the last Facebook post sends on 6 October. From day 26 onward it shrinks because all 60 posts are already created. The tightest point while work remains is after day 29. Two items remain, and both are the planned final-day posts.

This arithmetic assumes the needed cron runs succeed. A full queue gives about five calendar days of outage tolerance. The silent failure findings can use up that runway without warning.

## What I could not check

- I did not create, edit, move, or delete a Buffer post. Therefore, I did not run destructive crash or duplicate tests against Buffer.
- No campaign post has reached its due time. I could not prove end-to-end Instagram or Facebook publication.
- I could not prove that GitHub will deliver every future scheduled run. I observed two successful manual workflow runs only.
- I could not verify GitHub notification settings or any external alert receiver. The workflow file defines no alert step.
- I could not prove that the picture URLs will still work on each future publish day. I proved only that all 33 worked during this QA run.
- `actionlint` is not installed. I could not run that static checker. The live workflow did parse and run successfully.

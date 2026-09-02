# What was done about the QA report

The QA in `qa-report-2026-09-02-gpt.md` was run by GPT-5.6 Sol Medium on a snapshot taken
before the last round of fixes. Its verdict was DO NOT SHIP. Every finding is answered here.

| Finding | Status | What changed |
|---|---|---|
| Blocker: a create can become a duplicate | Fixed | Two guards. `state.json` remembers ids and is now saved after **every** create, not once at the end. A second guard matches `channelId + dueAt` against every live Buffer post, so a post is recognised even with no state at all. An unreadable `state.json` now raises an alert instead of resetting to empty. Tested by deleting and by corrupting `state.json`: both rebuilt the exact same 10 ids and created nothing. |
| High: failed and skipped posts raise no alarm | Fixed | A post in `error`, a post that went past due, and a rejection all raise an alert. Any alert exits 1, which fails the Action, which emails the repo owner. |
| High: some create failures reported as success | Fixed | A thrown `BufferError` and a rejection are both alerts now. Only a genuine plan-limit message is a clean stop, and even that exits 1. |
| High: the git push has no conflict recovery | Fixed | The workflow retries once after `git pull --rebase`. Losing `state.json` is survivable anyway, because the slot guard rebuilds it from Buffer. |
| Medium: account and channel not pinned | Fixed | `posts.json` pins the organization id and both channels by the **platform's own** service id. The routine requires exactly one match per channel and fails otherwise. It no longer takes "the first one it finds". |
| Medium: picture links could move | Fixed | Asset URLs are pinned to commit `f2e19080`, not to `main`. A branch can move. A commit cannot. |
| Low: a commit on every run | Fixed | State is only written when something actually changed. |
| Not fixed: no end-to-end publish proof | Accepted | No post has reached its due time yet. Nothing can prove this before 7 September. |
| Not fixed: GitHub could drop a scheduled run | Accepted | A full queue carries about 5 days of outage tolerance, and the month is 34 days. |

## Found separately, not by the QA

Buffer rejects `type: carousel` for Instagram, although its own schema offers the value.
Several pictures on a post of `type: post` **is** the carousel. Day 10 would have failed
silently on 16 September. Fixed and proved with a real 4 picture post, which was then deleted.

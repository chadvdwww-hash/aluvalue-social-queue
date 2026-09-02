# Alu-Value social queue

This repo posts for Alu-Value Glass & Aluminium on its own. Nobody has to touch it.

One post a day, Monday 7 September to Tuesday 6 October 2026, on Instagram and Facebook.

## The problem this solves

Buffer on the Free plan holds only **10 scheduled posts** at one time.
A 30 day month on two channels needs 60. They do not fit.

So the queue is not filled once. It is **topped up**.
A GitHub Action runs every 6 hours. It counts what Buffer is still holding,
then adds the next posts that are due until Buffer is full again.
As posts go out, room appears, and the next ones drop in.

## The pieces

| File | What it does |
|---|---|
| `posts.json` | The month. Text, picture links, and the exact time for each post. |
| `images/` | The 33 finished pictures. GitHub serves them as public links. |
| `scripts/topup.mjs` | The routine. Fills the Buffer queue. |
| `scripts/buffer.mjs` | Talks to the Buffer GraphQL API. |
| `scripts/check-images.mjs` | Proves every picture link works before anything is scheduled. |
| `state.json` | What is already scheduled. Written back by the Action after each run. |
| `.github/workflows/topup.yml` | The clock. |

## Why the images live here

Buffer has **no upload**. It fetches the picture from a public link at the moment it posts.
The link must stay alive until 6 October 2026. A public GitHub repo does that for free and forever.

## Rules the routine follows

- It never creates the same post twice. `state.json` remembers every Buffer post id.
- It never posts early. Buffer publishes at the time in `posts.json`.
- It skips any post whose time has already passed, and says so.
- It reads the channel list fresh every run, because Buffer channel ids change when a channel is reconnected,
  and it matches on the platform's own id pinned in `posts.json`, never on "the first one it finds".
- Picture links are pinned to a commit, not to `main`, so a later change cannot break a scheduled post.
- It stops if Instagram is connected as a personal profile, because Buffer cannot auto post to one.
- It stops politely when Buffer says the plan limit is reached, and tries again next run.

## Setup

One secret is needed. It is already set.

```
gh secret set BUFFER_TOKEN --repo chadvdwww-hash/aluvalue-social-queue
```

## Run it by hand

```
gh workflow run topup.yml --repo chadvdwww-hash/aluvalue-social-queue
gh workflow run topup.yml --repo chadvdwww-hash/aluvalue-social-queue -f dryRun=true
```

Locally:

```
BUFFER_TOKEN=... node scripts/topup.mjs --dry-run
```

## The times

- Weekdays 18:00 SAST. People look at their phone after work.
- Weekends 09:00 SAST. People plan the house in the morning.
- Facebook goes 20 minutes after Instagram, so the two do not land together.

## Where the content came from

Built by the `aluvalue-30-days` pack. See `Kilo/Projects/aluvalue-30-days/README.md`.
Real photos come from the cleared media bank. Ten pictures were made by GPT Image 2;
those posts are marked `aiAssisted` and are flagged to Instagram as AI made.

# Team comms — poqpoq-sundial

One shared channel for everyone working on this repo: Allen, Claude (the
"sundial" session) and Codex. Append-only, newest at the bottom of the log.
Use it to request reviews, report review results, and hand work between
agents without Allen relaying every message.

## Who's who

| Handle | Role |
|---|---|
| `allen` | Owner. Decides scope, merges, anything outward-facing (forum posts, upstream PRs, making the repo public). |
| `claude` | Author. Builds Sundial, opens PRs, answers review findings. |
| `codex` | Reviewer. Reviews PRs for correctness, GPU races and API misuse; can also propose changes. |

## How to use it

1. **Append, don't edit.** Add a new entry at the bottom of the log. Never
   change someone else's entry; reply with a new one that names it.
2. **One entry, one topic.** Start the heading with a status tag:

   | Tag | Meaning |
   |---|---|
   | `[REVIEW-REQUEST]` | Please review this PR. |
   | `[REVIEW]` | Review results for a PR. |
   | `[RESPONSE]` | Author's reply to a review: fixed, disputed, or deferred, per finding. |
   | `[QUESTION]` | Needs an answer before work continues. |
   | `[FYI]` | Nothing to do. |
   | `[DONE]` | Closes a thread. |

3. **Heading format:** `### YYYY-MM-DD HH:MM · from → to · [TAG] · PR #n or topic`
4. **Findings** get a severity and a location, so each can be answered by ID:
   `F1 · high · src/core/kernels.ts:183 · what breaks, and the input that breaks it`.
   Severities: `blocker` (wrong output or crash), `high`, `medium`, `nit`.
5. **Commit the entry** on the PR's own branch when it concerns that PR, or
   on a `comms/...` branch otherwise, so the log never conflicts with code.
6. **Claims need evidence.** Performance claims cite the bench command, the
   GPU and the numbers. Correctness claims name the input that breaks.

## Standing rules for this repo

- Every change goes through a branch and a PR. No direct commits to `main`.
- GPU numbers: `scripts/bench.mjs` with warm-up and flush pages; NVIDIA
  first (`GPU=nvidia`), Intel Xe-LPG as the weak-hardware check.
- Material receivers must stay read-only (a storage write kills early-Z),
  and the shadow raster must stay outside Babylon snapshot bundles.
- Nothing proprietary to poqpoq World goes into this repo. It will be public
  one day: no secrets, no World source, no prod hostnames.

## Log

### 2026-09-21 · claude → codex · [FYI] · channel opened
This file is the channel. Everything on `main` today (3 commits: the working
example, the leaf prepass and Babylon prepass fix, a README correction)
predates PRs and has not been reviewed. If you take a pass, the areas most
worth your eyes are `src/core/kernels.ts` (GPU page allocation and eviction,
where races would live) and `src/babylon/SundialBabylon.ts` (Babylon
internals we depend on). File the results here as a `[REVIEW]` entry.

# 006 — CI integration

**Status:** draft

Defines the GitHub Action wrapper and the safety machinery for running a tool that commits to your repository.

## 1. Principle

- **006-R1** — The Action MUST be a thin wrapper over the CLI (005-R1). Behaviour that exists only in CI is unreproducible and untestable.

## 2. Triggers

The root README lists three shapes. They differ in where they run, not in what they do.

| Shape | Runs | Mode |
|---|---|---|
| GitHub Action, pull request | On PR | `check`. Comments; never commits to a contributor branch. |
| GitHub Action, post-merge | On push to the target branch | `apply`. Commits the update. |
| Pre-push hook | Locally | `check`. Blocks the push on exit `1`. |

- **006-R2** — `apply` in CI MUST run **post-merge on the target branch**, not per-branch. This is the root README's stated mitigation for merge conflicts, and it also means only one writer touches the README.

## 3. The loop guard

The README update is itself a commit, which can re-trigger the pipeline that produced it. Three independent guards, because any one of them can be bypassed by configuration the tool does not control:

- **006-R3** — Commits MUST carry `[skip ci]` in the subject.
- **006-R4** — The tool MUST exit `0` before doing work when the only changed paths are the README and the state file (002-R6).
- **006-R5** — The workflow SHOULD add `paths-ignore` for the README and `.autoreadme/**`.

- **006-R6** — Commits MUST be identifiable by a trailer, so 003-R14 can exclude them from the changelog and humans can filter them:

```
docs: sync README sections [skip ci]

Regenerated: api, dependencies
Source-Commit: ce31c4e0e589ee2b7684c86a7952864083482550

X-Readmesync: 1
```

- **006-R7** — Depth-limit as a backstop: if the immediately preceding commit carries `X-Readmesync`, the tool MUST exit `0`. Even with the guards above defeated, the loop terminates after one iteration.

## 4. Commit and identity

- **006-R8** — The tool MUST commit only the README and the state file. Staging anything else risks committing a contributor's unrelated work.
- **006-R9** — The commit author MUST be a distinguishable bot identity, never the triggering user. Attributing a machine edit to a person corrupts blame.
- **006-R10** — On push rejection (non-fast-forward), the tool MUST rebase and retry at most twice, then give up and warn. It MUST NOT force-push.

## 5. Fail-closed commenting

When confidence is below threshold (002-R13), the tool comments rather than edits.

- **006-R11** — Stale warnings on a PR MUST be posted as a single comment, updated in place on re-runs. One comment per push is spam, and spam gets muted.
- **006-R12** — The comment MUST name the section, the triggering paths, and the reason, and MUST state that no edit was made.
- **006-R13** — Stale warnings MUST NOT fail the check by default (002-R14). Configurable via `failOn: ['stale']`.
- **006-R14** — When commenting is impossible — a fork PR without write permission, which is the common case for outside contributions — the tool MUST fall back to the job summary and MUST NOT fail the build. A contributor cannot act on a permission error.

## 6. Action interface

```yaml
- uses: atharvagaikwad03/ubiquitous-tribble@v1
  with:
    mode: check          # check | apply
    config: readmesync.config.json
    scope: ''            # empty = all scopes
    fail-on: drift       # none | drift | stale
    comment: true
```

| Output | Meaning |
|---|---|
| `changed` | `true` if any section was rewritten. |
| `sections` | Comma-separated IDs rewritten. |
| `stale` | Comma-separated IDs below threshold. |
| `commit` | SHA of the sync commit, empty in `check`. |

- **006-R15** — Required permissions MUST be documented and minimal: `contents: write` only for `apply`, `pull-requests: write` only when `comment: true`.

## 7. Failure modes

| Mode | Mitigation |
|---|---|
| Infinite loop | 006-R3, 006-R4, 006-R5, 006-R7 |
| Merge conflict | Post-merge single-writer execution (006-R2) |
| Concurrent runs | Concurrency group per branch; cancel in-progress |
| Fork PR without write access | Job-summary fallback (006-R14) |
| Push race | Bounded rebase-and-retry, never force (006-R10) |
| Shallow clone hiding history | Detected as cold start (002-R4); the workflow sets `fetch-depth: 0` |

## 8. Acceptance criteria

- A sync commit does not trigger a second sync run. Verified end-to-end, not by inspection.
- With every guard but 006-R7 disabled, the loop still terminates after one iteration.
- A fork PR with read-only permissions completes green and reports via job summary.
- A concurrent push during `apply` results in a rebase and retry, never a force-push.
- `apply` stages exactly two paths (006-R8).

# 002 — Change detection

**Status:** draft

Defines how the tool knows what changed, which sections a change affects, and when it must refuse to act.

## 1. Motivation

Regenerating every section on every run is the one-shot behaviour this project rejects: it burns tokens, churns the diff, and makes review meaningless. Regeneration must be scoped to what actually changed.

## 2. Last-run tracking

Scoping requires knowing the commit the tool last ran against.

- **002-R1** — The tool MUST persist the last-processed commit SHA in `.autoreadme/state.json`, committed alongside the README update.

```json
{
  "version": 1,
  "lastCommit": "ce31c4e0e589ee2b7684c86a7952864083482550",
  "sections": {
    "api":    { "inputHash": "sha256:3f9a…", "generatedAt": "2026-09-19T00:00:00Z" },
    "status": { "inputHash": "sha256:81bc…", "generatedAt": "2026-09-19T00:00:00Z" }
  }
}
```

- **002-R2** — `inputHash` is a digest of the extractor's **inputs**, not its output. Equal input hashes mean regeneration is unnecessary and MUST be skipped.
- **002-R3** — When state is missing, unreadable, or `version` is unrecognised, the tool MUST fall back to **cold-start** mode: treat every configured section as affected, and warn.
- **002-R4** — When `lastCommit` is not an ancestor of `HEAD` — force-push, rebase, shallow clone, squash-merge — the tool MUST NOT attempt a diff. It falls back to cold start (002-R3).

### Why a committed state file

| Option | Rejected because |
|---|---|
| Git notes | Not fetched by default; CI checkouts silently see no state, producing permanent cold starts. |
| Commit trailers | Requires walking history to find the last tagged commit; squash-merges discard trailers. |
| CI cache | Evicted unpredictably; not shared across forks; state loss is invisible. |
| **Committed file** | **Chosen.** Survives clone, fork, and squash. Cost: it appears in diffs. |

The cost is real — a file that changes on most runs adds noise to review. It is accepted because every alternative fails silently, and silent state loss degrades the tool to the full-rewrite behaviour it exists to avoid.

## 3. Diff scoping

- **002-R5** — The change set is `git diff --name-status <lastCommit>..HEAD`, filtered by the active scope from [004](004-configuration.md).
- **002-R6** — If `README.md` and `.autoreadme/state.json` are the *only* changed paths, the tool MUST exit `0` immediately without regenerating. This is the innermost loop guard; see also [006](006-ci-integration.md).
- **002-R7** — Renames MUST be detected (`--find-renames`) and treated as a change to both paths.
- **002-R8** — Deletions MUST be propagated. A removed export disappearing from the API section is the primary case; a section going empty is a valid outcome.

## 4. Mapping changes to sections

Each section declares input globs in config. Mapping is glob intersection against the change set.

```
changed:  src/parser.ts, package.json, docs/notes.md
          │
          ├─ src/**        → api, structure
          ├─ package.json  → install, dependencies
          └─ docs/**       → (no section claims this path)
                             ↓
                         unmapped
```

- **002-R9** — A section is **affected** when at least one changed path matches one of its input globs.
- **002-R10** — A changed path matching no section's globs is **unmapped**. Unmapped paths are not errors — most code changes genuinely do not affect the README.
- **002-R11** — Affected sections MUST be regenerated even if the extractor then produces identical content; the no-op is detected by comparing output, not by guessing beforehand.

## 5. Confidence and failing closed

The root README's rule: *never guess*. A change the tool cannot confidently map must produce a comment, not an edit.

- **002-R12** — Every regeneration MUST carry a confidence in `[0, 1]`.
- **002-R13** — Below the configured `confidenceThreshold` (default `0.8`), the tool MUST NOT edit the section. It records a **stale warning** naming the section, the triggering paths, and the reason.
- **002-R14** — Stale warnings MUST surface as a PR comment (see [006](006-ci-integration.md)) and MUST NOT fail the build by default.

Confidence is a property of the extractor, not a global heuristic:

| Extractor class | Confidence | Rationale |
|---|---|---|
| Deterministic (dependencies, scripts, structure) | `1.0` | Read directly from a manifest. Either it parsed or it did not. |
| Structural analysis (API surface) | `0.9` when the parse is clean; `0.5` when any target file failed to parse | A partial parse yields a partial surface, which would read as deletions. |
| Prose synthesis (changelog) | Extractor-reported, never above `0.8` | Summarising commit messages is inference. |

- **002-R15** — A parse failure in any input file MUST lower confidence for every section consuming it. Silently emitting a partial API surface would present unparsed files as removed exports — the worst available outcome, since it looks like a correct diff.

## 6. Acceptance criteria

- Given a change touching only `src/**`, only sections globbing `src/**` regenerate.
- A README-only change exits `0` with no work (002-R6).
- A force-push that orphans `lastCommit` triggers cold start, not a crash (002-R4).
- An unparseable input file yields a stale warning and an unmodified section, never a truncated one.
- Two consecutive runs with no code change produce no diff on the second (idempotence, per 001-R17).

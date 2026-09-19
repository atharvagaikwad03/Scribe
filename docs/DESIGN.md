# readme-sync design

## Goal

Keep `README.md` truthful on every merge without ever rewriting what a human
wrote. Three properties define the tool:

1. **Section ownership.** Only regions wrapped in
   `<!-- autogen:start:<id> hash=… -->` / `<!-- autogen:end:<id> -->` are
   ever modified. Every byte outside is copied through unchanged.
2. **Incremental, diff-driven regeneration.** Only the sections whose watched
   files changed since the last recorded run are re-extracted, and only those
   whose extracted data actually changed are re-rendered.
3. **Fail closed.** When a change cannot be mapped to a section with
   confidence, nothing is written; a stale flag is raised instead.

## Pipeline

```
plan(opts)
  ├─ resolvePackages         explicit config | discovered workspaces | single root
  └─ for each package:
       ├─ read README, parseReadme          mdast positions only → regions + headings
       ├─ load state.json                   lastSha, per-section inputHash/bodyHash, changelog history
       ├─ decide base                       lastSha usable? else full mode (first run / force-push / shallow)
       ├─ git diff --name-status -M base..HEAD  (+ working tree)   → ChangedFile[]
       ├─ mapChangedFiles                   claimed by sections | ignored | unmapped
       ├─ for each generator (ordered):
       │     disabled? → skip
       │     no marker? → flag missing-marker
       │     marker hash ≠ body hash and !force? → flag manual-edit
       │     not affected? → unchanged
       │     extract() → {data, confidence, diagnostics}     (throws → flag extractor-error)
       │     confidence < threshold → flag low-confidence
       │     inputHash = hash(stableStringify(data))
       │     render(data) → body; trial splice must keep marker structure
       │     body == current → unchanged (state still recorded)
       │     else → update
       ├─ unmapped files: surfaceRelevance() → flag unmapped-surface-file
       ├─ spliceMany(readme, updates)       offsets, back to front, structure re-verified
       └─ stateAfter: sections…, lastSha = HEAD unless flags (or acceptStale)
apply(plan)
  └─ write README(s), state.json, afterWrite hooks (api-surface.json, llm-cache.json)
```

`plan` is pure with respect to the repository: it reads but never writes.
`update --check`, `plan`, `explain` and the PR comment all reuse it.

## Markers and splicing

The README is parsed with `remark-parse` **only to locate** `html` nodes
(markers) and headings (anchors for `init`). Markers inside fenced code
blocks are `code` nodes and therefore ignored. Splicing replaces the byte
range `[region.start, region.end)` with a freshly rendered region; nothing
else is touched, and the document is never stringified from the AST.

Canonical form of a written region:

```
<!-- autogen:start:ID hash=HHHHHHHHHHHH -->\n
BODY (trailing whitespace trimmed)\n
<!-- autogen:end:ID -->
```

`hash` = first 12 hex chars of sha256(BODY). On read, the text between the
markers has exactly one leading and one trailing newline stripped and is
hashed again; a mismatch means a human edited inside the region.

After splicing, the output is re-parsed and must contain the same region ids
in the same order; otherwise the write is refused (`MarkerError`). This
catches renderers that emit an unbalanced fence or a stray marker.

## State

```
.readme-sync/
  state.json                 root package
  api-surface.json           root package's normalised API snapshot
  llm-cache.json             validated LLM output keyed by input hash (optional)
  packages/<slug>/state.json monorepo packages (slug = path with non-alnum → "__")
  packages/<slug>/api-surface.json
```

`state.json`:

```json
{
  "version": 1,
  "toolVersion": "0.1.0",
  "lastSha": "…",
  "sections": { "api": { "inputHash": "…", "bodyHash": "…" } },
  "changelog": { "entries": [...], "apiChanges": [...], "highlights": [...] }
}
```

State is committed alongside the README so CI runs are incremental across
machines.

## Mapping files to sections

Each generator declares `defaultWatch` globs (package-relative, negations
allowed), optionally restricted to change statuses (`structure` reacts to
A/D/R anywhere but to M only for manifests via `watchAnyStatus`). Users may
replace (`watch`) or extend (`watchExtra`) them per section, globally or per
package. A changed file gets exactly one outcome:

- **claimed** by ≥ 1 section → those sections re-extract;
- **ignored** by built-in or configured ignore globs (README, `.readme-sync/**`,
  `node_modules/**`, files owned by another package);
- **unmapped** → checked for surface relevance (manifest, lockfile,
  requirements, Dockerfile/compose, CI config added/removed, declared entry
  point, new top-level directory). Relevant ⇒ stale flag.

Renames are treated as a change to both paths.

## Extractors

All extractors return `{ data, confidence, diagnostics }` where `data` is
JSON-serialisable and sorted. Rendering is a pure function of `data`.

| id | source | notes |
|---|---|---|
| `structure` | filesystem + manifests | languages by extension count and manifests; frameworks by dependency names; entry points from `main`/`module`/`bin`/`exports`, `pyproject` scripts, Dockerfile `CMD`/`ENTRYPOINT`; tree to `depth` |
| `api` | TypeScript compiler API, embedded Python `ast` helper, regex heuristics | entry files from package.json (dist → src mapping) or `src/index.*`; Python `__init__.py` `__all__`/public names with relative-import resolution; CLI and route registrations with literal names only. Snapshot diffed against `api-surface.json` |
| `commands` | package.json scripts, Makefile, justfile, Dockerfile, pyproject | package manager from lockfile / `packageManager`; documented make targets preferred |
| `dependencies` | manifests + lockfiles | declared and resolved versions (pnpm, npm, yarn v1/berry, bun, poetry, uv, pdm) |
| `changelog` | `git log lastSha..HEAD` | Conventional Commits grouped; tool commits excluded; API changes from the surface diff; history lives in state; optional validated LLM highlights |
| `packages` | workspace manifests | monorepo root table |

## Confidence and flags

Confidence is 1.0 for exact sources (manifests, compiler API, `ast`). Regex
heuristics score 0.85 (CLI) / 0.75 (routes). A dynamic registration in a
changed file drops the section to 0.5. Default threshold 0.7. Below
threshold, or on any thrown error, the section is flagged and left as is.

Flags are reported (CLI output, PR comment, job summary) and block `lastSha`
from advancing so the same change is re-examined next run. `--force`
reclaims manually edited sections; `--accept-stale` acknowledges the rest.

## CI integration

- `pull_request` → check mode: plan, comment (upserted via
  `<!-- readme-sync:comment -->`), job summary, never commits.
- `push` to default branch → commit mode (or `pr` mode): loop guard, plan,
  apply, commit with `[skip ci]` + `readme-sync: auto` trailer,
  `pull --rebase`, push; on conflict reset to remote and regenerate (≤ 3 attempts).
- `concurrency: readme-sync-${{ github.ref }}` (no cancel) serialises runs per branch.

The core (`plan`/`apply`) has no GitHub dependency; `src/action` and
`src/github` are thin wrappers, so other CI systems can call the CLI directly
(`readme-sync update` then commit) and get identical results.

## Testing strategy

Fixtures are real git repositories built in temp dirs (`test/helpers/repo.ts`).
Key tests: property-based human-bytes invariant; idempotency; surgical scope
(one export → only `api`/`changelog`; refactor → nothing); every flag
condition; manual edit preserved; loop guard; two clones racing to
convergence; monorepo isolation; LLM rejection and caching; built CLI exit
codes.

# 003 — Extractors

**Status:** draft

Defines the extractor contract and the five built-ins that feed the table in the root README.

## 1. Contract

An extractor turns repository state into markdown for one section. It is the only component permitted to produce content.

```ts
interface ExtractorContext {
  /** Absolute path to the scope root (repo root, or package root in a monorepo). */
  root: string;
  /** Paths changed since lastCommit, relative to root. Empty on cold start. */
  changed: string[];
  /** Resolved options from the section's config entry. */
  options: Record<string, unknown>;
  /** Read a repo file. Returns null if absent. Records the read for input hashing. */
  read(path: string): Promise<string | null>;
  /** Glob within scope. Records the match set for input hashing. */
  glob(pattern: string): Promise<string[]>;
}

interface ExtractorResult {
  /** Markdown body, without marker lines. */
  content: string;
  /** See 002-R12. */
  confidence: number;
  /** Non-fatal problems: unparsed files, missing manifests. */
  warnings: string[];
}

interface Extractor {
  readonly name: string;
  extract(ctx: ExtractorContext): Promise<ExtractorResult>;
}
```

- **003-R1** — Extractors MUST be pure with respect to the repository: no network, no writes, no mutation of `ctx`.
- **003-R2** — Output MUST be deterministic. Given identical inputs, byte-identical output. This is what makes 001-R17 achievable.
- **003-R3** — Collections MUST be sorted by a stable key, never filesystem order, which varies across platforms.
- **003-R4** — Output MUST NOT contain `autogen` markers. Emitting one would corrupt the document on the next parse; the patcher MUST reject such content.
- **003-R5** — An extractor MUST NOT throw for missing inputs. A missing manifest is `confidence: 0` plus a warning, not a crash.
- **003-R6** — The `inputHash` of 002-R2 is computed from recorded `read` and `glob` calls, so extractors declare their inputs by using them. Reading a file outside `ctx` defeats change detection and is a defect.

## 2. Built-ins

### 2.1 `structure`

Entry points, folder layout, detected language and framework.

- Detects language by manifest presence, in order: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`.
- Respects `.gitignore`. Never lists ignored or dot-directories.
- **003-R7** — Depth MUST be bounded (`maxDepth`, default `3`). Rendering a deep tree in full produces an unreviewable diff on every refactor.
- Confidence `1.0`.

### 2.2 `install`

Install, run, and build commands.

- Sources: `package.json` scripts, `Makefile` targets, `Dockerfile`, `pyproject.toml`.
- **003-R8** — Commands MUST be quoted from config verbatim, never inferred. The root README is explicit: pulled from real config, never guessed. If no manifest declares a build command, the output says nothing about building.
- Confidence `1.0`.

### 2.3 `dependencies`

Name and version list.

- Prefers lockfiles over manifests: resolved versions beat declared ranges.
- Separates runtime from development dependencies.
- **003-R9** — Transitive dependencies MUST be excluded by default. A full lockfile expansion is thousands of lines and defeats the purpose of a README.
- Confidence `1.0`.

### 2.4 `api-surface`

Exported functions, CLI commands, HTTP endpoints. The hardest extractor, and the one the root README singles out as diffed against the last known surface, not re-derived from scratch.

- **003-R10** — The previous surface MUST be persisted in `.autoreadme/state.json` as structured data, not re-parsed from rendered markdown. Round-tripping through prose loses information and invites drift.
- **003-R11** — Analysis MUST be AST-based. Regex export detection is out of scope: it cannot distinguish a re-export from a comment mentioning one.
- **003-R12** — On a parse failure in any target file, confidence drops to `0.5` and the file is named in warnings (see 002-R15). The section is then left untouched under 002-R13.
- Confidence `0.9` clean, `0.5` degraded.

### 2.5 `changelog`

Recent changes, folded from commit messages and diff summaries.

- **003-R13** — Merge commits MUST be excluded.
- **003-R14** — Commits matching the loop-guard signature of [006](006-ci-integration.md) MUST be excluded, or the tool's own commits accumulate in the changelog it maintains.
- **003-R15** — Confidence MUST NOT exceed `0.8`. Summarising intent from commit messages is inference, and 002-R13 should make a low-quality commit history visible as a warning rather than as invented prose.
- Conventional Commit prefixes, when present, group the output.

## 3. Registration

- **003-R16** — Extractors are resolved by name from config. An unknown name is a config error, reported before any file is read.
- **003-R17** — Third-party extractors MAY be loaded by module path. They receive the same `ctx` and are bound by the same rules; the patcher enforces 003-R4 regardless of origin.

## 4. Acceptance criteria

- Every built-in run twice on an unchanged tree returns byte-identical content.
- Every built-in given an empty repository returns a warning and `confidence: 0`, and does not throw.
- `api-surface` given a file with a syntax error reports `0.5` and names the file.
- `structure` output on a large monorepo stays within `maxDepth` and excludes ignored paths.
- An extractor emitting an `autogen` marker is rejected by the patcher (003-R4).

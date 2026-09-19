# readme-sync

**Keep `README.md` in sync with your codebase without letting a robot rewrite your prose.**

`readme-sync` is a CLI and GitHub Action that regenerates only the README sections it owns, only when the code behind them changes, and refuses to guess when it can't tell what a change means.

[![CI](https://github.com/atharvagaikwad03/ubiquitous-tribble/actions/workflows/ci.yml/badge.svg)](https://github.com/atharvagaikwad03/ubiquitous-tribble/actions/workflows/ci.yml)
[![readme-sync](https://github.com/atharvagaikwad03/ubiquitous-tribble/actions/workflows/readme-sync.yml/badge.svg)](https://github.com/atharvagaikwad03/ubiquitous-tribble/actions/workflows/readme-sync.yml)

> This README is maintained by `readme-sync` itself. Everything between `<!-- autogen:start:… -->` and `<!-- autogen:end:… -->` markers is generated on every push to `main`. Everything else was written by a person and is never touched by the tool.

## Contents

- [Why surgical beats regeneration](#why-surgical-beats-regeneration)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [GitHub Action](#github-action)
- [CLI](#cli)
- [Generated sections](#generated-sections)
- [Stale flags](#stale-flags)
- [Configuration](#configuration)
- [Monorepos](#monorepos)
- Generated on every push: [Project structure](#project-structure) · [API](#api) · [Commands](#commands) · [Dependencies](#dependencies) · [Changelog](#changelog)
- [Development](#development)
- [Design notes](#design-notes)
- [Non-goals (for now)](#non-goals-for-now)
- [License](#license)

## Why surgical beats regeneration

Most README generators do a one-shot rewrite from an LLM prompt. That has three problems that get worse the longer you use them:

1. **They clobber your prose.** The paragraph explaining *why* the project exists, the badges, the carefully worded install caveat: all rewritten or gone.
2. **They drift.** Every run produces slightly different wording, so the README changes even when the code didn't, and reviewers stop reading the diffs.
3. **They guess.** When a change is ambiguous, an LLM writes something plausible. Plausible-but-wrong documentation is worse than stale documentation.

`readme-sync` takes the opposite stance on each point:

| Problem | What `readme-sync` does instead |
| --- | --- |
| Clobbered prose | Only bytes inside `autogen` markers are ever written. A property-based test proves every byte outside them is unchanged. |
| Drift | Extractors are deterministic and sorted. Same code, same bytes. Optional LLM output is validated and cached by input hash so it can never drift either. |
| Guessing | If a change can't be mapped to a section with confidence, the section is left alone and a **stale flag** is posted to the PR instead. |
| Full re-scan every run | It diffs against the commit it last ran on (`git diff lastSha..HEAD`) and regenerates only the sections whose watched files changed. An internal refactor with an unchanged public surface produces no README diff. |

## How it works

```text
              git diff lastSha..HEAD
                        │
        ┌───────────────┼──────────────────┐
        ▼               ▼                  ▼
   claimed by       ignored            unmapped
   section(s)   (README, state,   ┌────────┴────────┐
        │        node_modules…)   ▼                 ▼
        ▼                    not surface-      surface-relevant
   run extractor             relevant: ok      (manifest, lockfile,
        │                                       entry point, new dir…)
   inputHash same? ── yes ─▶ unchanged               │
        │ no                                          ▼
        ▼                                     ⚠ stale flag, no write
   render → splice into markers by byte offset
        │
   hash mismatch inside markers? ── yes ─▶ ⚠ manual edit flag, no write
        │ no
        ▼
   write README + .readme-sync/state.json
```

Each generated region carries the hash of the body the tool last wrote:

```markdown
<!-- autogen:start:api hash=3f9a1c2b7d10 -->
…tool-owned content…
<!-- autogen:end:api -->
```

If a human edits inside the markers, the hash no longer matches and the tool **does not overwrite** the edit. It flags it, and `--force` reclaims the section.

The README is parsed only to *locate* markers and headings. It is never re-serialised from a syntax tree, so list styles, table alignment, trailing whitespace and every other byte outside the markers survive untouched. After each splice the result is re-parsed and must contain the same markers in the same order, or the write is refused.

## Requirements

- **Node.js 20 or newer** and **git**. The tool shells out to `git` for the diff, so it needs a checkout with history. In CI use `fetch-depth: 0`; a shallow clone still works but falls back to a full regeneration of the generated sections.
- **Python 3.9 or newer** on `PATH`, only if you want the API surface of a Python project. Set `READMESYNC_PYTHON` to point at a specific interpreter. Without Python the `api` section still runs; it just reports that the Python surface could not be extracted.
- **Nothing else.** No API keys and no network access, unless you opt in to LLM changelog highlights.

## Quick start

`readme-sync` is not published to npm yet (the `readme-sync` name on npm belongs to an unrelated tool). Until it is, run it from a clone or use the GitHub Action, which needs no install.

```sh
git clone https://github.com/atharvagaikwad03/ubiquitous-tribble readme-sync
cd readme-sync && pnpm install && pnpm build
cd /path/to/your/project
node /path/to/readme-sync/dist/cli/index.js init     # writes .readme-sync.yml, inserts markers at your headings
node /path/to/readme-sync/dist/cli/index.js plan     # dry run: what would change, what is flagged, and why
node /path/to/readme-sync/dist/cli/index.js update   # write the generated sections + .readme-sync/state.json
```

`init` never converts existing prose into a generated section unless you pass `--adopt`. Without it, an existing `## API` heading gets an empty marker pair below it and your notes stay where they were. Re-running `init` is safe: sections that already have markers are skipped.

Commit the README and the `.readme-sync/` directory. The state file records the commit each section was last generated from, which is what makes later runs incremental.

Then add the workflow below. On pull requests it only comments; on push to `main` it commits the regenerated sections back.

## GitHub Action

Minimal workflow (the full, annotated version is [`examples/workflow.yml`](examples/workflow.yml)):

```yaml
name: readme-sync
on:
  pull_request:
  push:
    branches: [main]
    paths-ignore: ['README.md', '**/README.md', '.readme-sync/**']

concurrency:
  group: readme-sync-${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: write        # commit mode
  pull-requests: write   # PR comment / pr mode

jobs:
  readme-sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # incremental diffs need the last-run commit
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: atharvagaikwad03/ubiquitous-tribble@main
        with:
          mode: commit     # or: pr, check
```

### Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `mode` | `commit` | On push: `check` (never write), `commit` (commit and push to the branch) or `pr` (push to `pr-branch` and open/update a pull request). Pull request events always run in `check` mode. |
| `config` | `.readme-sync.yml` | Config path, relative to the repository root. |
| `token` | `${{ github.token }}` | Used for the PR comment and, in `pr` mode, the pull request. Use a PAT or GitHub App token to push to a protected branch. |
| `llm` | from config | `off`, `anthropic` (needs `ANTHROPIC_API_KEY`) or `mock`. Changelog highlights only. |
| `commit-message` | `docs: sync README with codebase [skip ci]` | Commit message for `commit` / `pr` mode. The `readme-sync: auto` trailer is appended automatically. |
| `pr-branch` | `readme-sync/update` | Branch used in `pr` mode. |
| `working-directory` | repository root | Directory inside the checkout to run from. |

### Outputs

| Output | Meaning |
| --- | --- |
| `changed` | `"true"` when a README was (or would be) changed. |
| `flags` | Number of stale flags raised. |
| `skipped` | `"true"` when the loop guard skipped the run. |
| `sha` | Commit created in `commit` / `pr` mode, if any. |
| `plan` | The JSON plan (check mode). |

### Behaviour in CI

- **Pull requests** always run in `check` mode: no commits, one comment with the README diff preview and flags.
- **Push to the default branch** runs in `commit` mode (or `pr` mode for protected branches) once per merge, never per feature branch. Regenerating on every feature branch is exactly what produces merge conflicts in generated sections.
- **Loop guard**, in layers: `[skip ci]` and a `readme-sync: auto` trailer on the tool's commits; early exit when HEAD carries the trailer, was authored by the bot, or touches only README(s) and `.readme-sync/**`; no commit when output is identical; `paths-ignore` in the workflow. Pushes made with `GITHUB_TOKEN` do not trigger workflows at all; PATs do, so keep the guards if you use one.
- **Conflicts**: the workflow uses `concurrency: readme-sync-${{ github.ref }}` and the Action does `pull --rebase` before pushing. On conflict it throws the local patch away, regenerates on the new HEAD (generation is deterministic) and retries, up to three times.
- **Flags** go to one PR comment (upserted, never duplicated) and to the job summary. Set `failOnStale: true` in the config to fail the job instead of just reporting.

## CLI

Every command accepts `-C <dir>` to run from another directory, `-c <file>` to point at a config file, and `-v` / `-q` for more or less logging.

| Command | What it does |
| --- | --- |
| `init [--adopt] [--dry-run]` | Create `.readme-sync.yml` and insert marker pairs under the configured anchor headings. `--adopt` moves the prose already under a heading into the generated section. |
| `plan [--diff] [--json]` | Dry run. Prints, per section, whether it would be updated, left alone, skipped or flagged, and why. Never writes. |
| `update [--check] [--diff]` | Regenerate affected sections and write the README(s) and state. `--check` writes nothing and exits 1 if the README is out of date, which is what CI should run. |
| `explain <section>` | Show the changed files that were mapped to one section, the extractor output, its confidence and diagnostics, and the resulting diff. Start here when a flag surprises you. |
| `comment [--dry-run]` | Upsert the stale-warning comment on the current pull request. The Action calls this for you; it is exposed for other CI systems. |

Options shared by `plan`, `update`, `explain` and `comment`:

| Option | Effect |
| --- | --- |
| `--base <sha>` | Diff against this commit instead of the recorded last run. |
| `--section <id...>` | Only process these sections. The CI job on this repo uses it to skip the changelog, which is always one commit behind by construction. |
| `--package <path...>` | Only process these package paths in a monorepo. |
| `--force` | Overwrite sections that were edited by hand inside their markers. |
| `--accept-stale` | Advance the recorded commit even though stale flags were raised. Use it once a human has dealt with the flagged change. |
| `--llm off\|anthropic\|mock` | Override the config's LLM setting for changelog highlights. |

## Generated sections

| Section | Watches | Source of truth |
| --- | --- | --- |
| `structure` | files added/removed/renamed, manifests | folder layout, entry points (`main`/`bin`/`exports`, `pyproject` scripts, `Dockerfile`), detected language and frameworks |
| `api` | `src/**`, `lib/**`, `*.py`, manifests | exported functions/classes/types via the TypeScript compiler API; Python public names via `ast`; CLI commands (commander/yargs/click/typer/argparse); HTTP routes (express/fastify/FastAPI/Flask). Diffed against `.readme-sync/api-surface.json` |
| `commands` | `package.json`, `Makefile`, `Dockerfile`, `pyproject.toml`, `justfile`, lockfiles | scripts, `##`-documented make targets, console scripts, Docker entrypoints. Nothing is invented |
| `dependencies` | manifests and lockfiles | declared and lockfile-resolved versions, engines, `requires-python` |
| `changelog` | every commit | Conventional Commits grouped as Breaking / Features / Fixes / Other, plus API changes from the surface diff. Append-only, SHA-deduped, capped |
| `packages` | workspace manifests | monorepo root table of packages |

Every section can be disabled, given a different anchor heading, or pointed at different files. See [Configuration](#configuration). The generated regions further down this page are what these extractors produce for `readme-sync` itself.

## Stale flags

A **stale flag** ("README may be stale here") is raised, and the affected section is left untouched, when:

| Reason | Trigger |
| --- | --- |
| `unmapped-surface-file` | a changed file that no section watches is surface-relevant: a manifest, lockfile, `requirements*.txt`, Dockerfile or compose file, an entry point, an added or removed CI config, or a file in a new top-level directory |
| `low-confidence` | an extractor's confidence is below `confidenceThreshold` |
| `extractor-error` | an extractor throws, for example on a `package.json` that is not valid JSON |
| `manual-edit` | a generated section was edited by hand (the marker hash no longer matches the body) |
| `missing-marker` | a section is enabled but its markers are not in the README |
| `malformed-markers` | a start marker without its end, or nested or duplicated markers |
| `render-error` | the rendered body would break the marker structure |

While any flag is open the recorded `lastSha` does not advance, so the unaccounted change keeps being reported on every run until a human resolves it. Nothing is ever written to work around a flag.

### Resolving a flag

1. Run `readme-sync explain <section>` (or `plan -v`) to see which files triggered it and what the extractor saw.
2. Pick the fix that matches the cause:
   - **The file should drive a section.** Add a glob to that section's `watchExtra` in `.readme-sync.yml`.
   - **The file never matters to the README.** Add it to `ignore`.
   - **The README needs a human update.** Edit the prose outside the markers, then run `update --accept-stale` so the recorded commit moves on.
   - **Someone edited inside the markers.** Move their text outside the markers and run `update --force` to reclaim the section, or disable the section and delete the markers if it should stay hand-written.
   - **Markers are missing.** Re-run `init`; it only inserts what is absent.
   - **Extractor error or low confidence.** Fix the malformed input, or lower `confidenceThreshold` if the heuristic is being too cautious for your layout.
3. Run `plan` again. When it reports no flags, `update` advances `lastSha` on its own.

## Configuration

`.readme-sync.yml`, validated with zod (unknown keys are errors). A JSON schema for editor completion lives at [`schema/readme-sync.schema.json`](schema/readme-sync.schema.json); add `# yaml-language-server: $schema=…` at the top of the file to get it in VS Code.

```yaml
version: 1
packages: []                 # monorepo: [{ path, readme, sections, ignore }]; empty = auto-discover workspaces
sections:
  api:
    enabled: true
    anchor: '## API'         # heading `init` inserts markers under
    watch: ['src/**']        # replace the default watch globs
    watchExtra: []           # or extend them
  structure: { depth: 2 }
ignore: ['docs/**']          # never affects any section
confidenceThreshold: 0.7
failOnStale: false
changelog: { maxEntries: 50 }
llm: { enabled: false }      # optional, changelog highlights only, validated + cached
```

The LLM is **off by default**. When enabled (`ANTHROPIC_API_KEY`), it only ever sees commit subjects and diff stats, and every bullet it returns must cite a real commit SHA or the whole response is discarded. Accepted output is cached in `.readme-sync/llm-cache.json` by input hash, so the same commits always produce the same bullets.

## Monorepos

With `packages: []` the tool discovers npm, yarn and pnpm workspaces from `package.json` or `pnpm-workspace.yaml`. Each package gets its own README, its own state under `.readme-sync/packages/<slug>/`, and its own set of sections. The root README gets the `packages` table, `structure` and `changelog`; `api`, `commands` and `dependencies` are off at the root because a workspace root rarely has a public surface of its own.

List `packages:` explicitly to take full control:

```yaml
packages:
  - path: .
    sections: { api: { enabled: false } }
  - path: packages/core
  - path: packages/cli
    readme: docs/README.md
    ignore: ['fixtures/**']
```

Per-package `sections` and `ignore` are merged over the root config. `--package <path>` limits a run to some of them.

## Project structure

<!-- autogen:start:structure hash=bc1a5ef4bca0 -->
|  |  |
| --- | --- |
| Language | TypeScript, JavaScript |
| Frameworks / tools | Commander (CLI), Vitest |

**Entry points**

| Role | File | Declared in |
| --- | --- | --- |
| `bin:readme-sync` | `dist/cli/index.js` | package.json#bin |
| `types` | `dist/index.d.ts` | package.json#types |
| `exports:.` | `dist/index.js` | package.json#exports |
| `main` | `dist/index.js` | package.json#main |

**Layout** (depth 2)

```text
.github/
  workflows/  (2 files)
examples/  (1 file)
schema/  (1 file)
scripts/  (1 file)
src/
  action/  (3 files)
  cli/  (5 files)
  config/  (4 files)
  engine/  (2 files)
  extractors/  (17 files)
  flags/  (1 file)
  git/  (1 file)
  github/  (1 file)
  llm/  (4 files)
  markdown/  (1 file)
  state/  (1 file)
  util/  (4 files)
test/
  helpers/  (1 file)
  integration/  (8 files)
  unit/  (3 files)
CLAUDE.md
README.md
action.yml
eslint.config.js
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
tsconfig.json
tsup.action.config.ts
tsup.config.ts
vitest.config.ts
```
<!-- autogen:end:structure -->

## API

<!-- autogen:start:api hash=386559256604 -->
**Exports** (from `src/index.ts`)

| Name | Kind | Signature |
| --- | --- | --- |
| `AnthropicProvider` | class | `class AnthropicProvider(apiKey: string, baseUrl?) { complete(req: LlmRequest): Promise<string>; name: "anthropic" }` |
| `apply` | function | `apply(run: RunPlan): Promise<ApplyResult>` |
| `bodyHash` | function | `bodyHash(body: string): string` |
| `buildCommentBody` | function | `buildCommentBody(run: RunPlan, opts?: { readmeDiff?: string; runUrl?: string; }): string` |
| `COMMENT_MARKER` | const | `const COMMENT_MARKER: "<!-- readme-sync:comment -->"` |
| `Config` | type | `type Config = z.infer<typeof configSchema>;` |
| `CONFIG_FILENAME` | const | `const CONFIG_FILENAME: ".readme-sync.yml"` |
| `configSchema` | const | `const configSchema: z.ZodObject<{ version: z.ZodDefault<z.ZodLiteral<1>>; packages: z.ZodDefault<z.ZodArray<z.ZodObject<{ path: z.ZodDefault<z.ZodString>; readme: z.ZodDefault<z.ZodString>; sections: z.ZodDefault<z.ZodObject<{ structure: z…` |
| `createLlmProvider` | function | `createLlmProvider(config: Config, override?: string): LlmProvider \| undefined` |
| `FlagReason` | type | `type FlagReason = \| 'unmapped-surface-file' \| 'low-confidence' \| 'extractor-error' \| 'manual-edit' \| 'malformed-markers' \| 'missing-marker' \| 'render-error';` |
| `formatFlag` | function | `formatFlag(f: StaleFlag): string` |
| `Git` | class | `class Git(cwd: string) { add(paths: string[]): Promise<void>; changedFiles(base: string, head?: string): Promise<ChangedFile[]>; commit(message: string, opts?: { authorName?: string; authorEmail?: string; }): Promise<string>; commitAuthor(rev?: string): Promise<{ name: string; email: string; }>; commitExists(sha: string): Promise<boolean>; commitMessage(rev?: string): Promise<string>; commitsBetw…` |
| `init` | function | `init(opts: InitOptions): Promise<InitResult>` |
| `insertMarkers` | function | `insertMarkers(source: string, pkg: ResolvedPackage, adopt: boolean): { after: string; inserted: SectionId[]; adopted: SectionId[]; skipped: Array<{ id: SectionId; why: string; }>; }` |
| `LlmProvider` | interface | `interface LlmProvider { readonly name: string; complete(req: LlmRequest): Promise<string>; }` |
| `loadConfig` | function | `loadConfig(repoRoot: string, configPath?: string): Promise<LoadedConfig>` |
| `MarkerRegion` | interface | `interface MarkerRegion { id: string; hash: string \| undefined; start: number; end: number; bodyStart: number; bodyEnd: number; body: string; attrs: Record<string, string>; }` |
| `MockProvider` | class | `class MockProvider { calls: LlmRequest[]; complete(req: LlmRequest): Promise<string>; name: "mock"; reply(text: string): this }` |
| `PackageConfig` | type | `type PackageConfig = z.infer<typeof packageConfigSchema>;` |
| `PackagePlan` | interface | `interface PackagePlan { pkg: ResolvedPackage; headSha: string; baseSha: string \| null; fullMode: boolean; fullModeReason?: string; files: MappedFile[]; sections: SectionPlan[]; flags: StaleFlag[]; readmeBefore?: string; readmeAfter?: string; readmeChanged: boolean; stateBefore: PackageState; stateAfter: PackageState; error?: string; _contexts?: Map<SectionId, ExtractContext>; }` |
| `parseConfig` | function | `parseConfig(input: unknown, sourceName?: string): Config` |
| `ParsedReadme` | interface | `interface ParsedReadme { source: string; regions: MarkerRegion[]; headings: HeadingAnchor[]; }` |
| `parseReadme` | function | `parseReadme(source: string): ParsedReadme` |
| `plan` | function | `plan(opts: RunOptions): Promise<RunPlan>` |
| `planToJson` | function | `planToJson(run: RunPlan): unknown` |
| `regionIsPristine` | function | `regionIsPristine(region: MarkerRegion): boolean` |
| `renderDefaultConfig` | function | `renderDefaultConfig(): string` |
| `renderRegion` | function | `renderRegion(id: string, body: string, attrs?: Record<string, string>): string` |
| `ResolvedPackage` | interface | `interface ResolvedPackage { path: string; slug: string; absPath: string; readme: string; absReadme: string; stateDir: string; sections: Record<SectionId, SectionConfig>; ignore: string[]; }` |
| `resolvePackages` | function | `resolvePackages(repoRoot: string, config: Config): Promise<ResolvedPackage[]>` |
| `RunOptions` | interface | `interface RunOptions { repoRoot: string; config: Config; base?: string; force?: boolean; acceptStale?: boolean; packages?: string[]; sections?: SectionId[]; llm?: LlmProvider; includeWorkingTree?: boolean; forceExtract?: boolean; }` |
| `RunPlan` | interface | `interface RunPlan { repoRoot: string; headSha: string; packages: PackagePlan[]; flags: StaleFlag[]; changed: boolean; }` |
| `SectionConfig` | type | `type SectionConfig = z.infer<typeof sectionConfigSchema>;` |
| `SectionId` | type | `type SectionId = (typeof SECTION_IDS)[number];` |
| `SectionPlan` | interface | `interface SectionPlan { id: SectionId; status: SectionStatus; reason: string; affectedBy: string[]; confidence?: number; diagnostics: string[]; oldBody?: string; newBody?: string; inputHash?: string; data?: unknown; extracted: boolean; }` |
| `SectionStatus` | type | `type SectionStatus = 'disabled' \| 'unchanged' \| 'update' \| 'flagged' \| 'skipped';` |
| `spliceMany` | function | `spliceMany(source: string, updates: Array<{ region: MarkerRegion; body: string; }>): string` |
| `spliceRegion` | function | `spliceRegion(source: string, region: MarkerRegion, newBody: string): string` |
| `StaleFlag` | interface | `interface StaleFlag { pkg: string; section?: SectionId; reason: FlagReason; message: string; files: string[]; }` |
| `STATE_DIR` | const | `const STATE_DIR: ".readme-sync"` |
| `TOOL_VERSION` | const | `const TOOL_VERSION: string` |
| `upsertComment` | function | `upsertComment(ctx: PullRequestContext, body: string, client?: CommentClient): Promise<{ action: "created" \| "updated" \| "unchanged"; url: string; }>` |

**CLI commands**

| Command | Kind | Defined in |
| --- | --- | --- |
| `comment` | command | `src/cli/index.ts` |
| `explain <section>` | command | `src/cli/index.ts` |
| `init` | command | `src/cli/index.ts` |
| `plan` | command | `src/cli/index.ts` |
| `readme-sync (dist/cli/index.js)` | binary | `package.json` |
| `update` | command | `src/cli/index.ts` |
<!-- autogen:end:api -->

## Commands

<!-- autogen:start:commands hash=3826476a0e7d -->
**Install**

```sh
pnpm install
```

**Scripts**

| Command | Runs |
| --- | --- |
| `pnpm build` | `tsup && tsup --config tsup.action.config.ts` |
| `pnpm check` | `pnpm build && pnpm test && pnpm lint` |
| `pnpm format` | `prettier --write .` |
| `pnpm lint` | `eslint . && prettier --check .` |
| `pnpm readme-sync` | `node ./dist/cli/index.js` |
| `pnpm schema` | `node ./scripts/gen-schema.mjs` |
| `pnpm test` | `vitest run` |
| `pnpm test:watch` | `vitest` |
| `pnpm typecheck` | `tsc --noEmit` |
<!-- autogen:end:commands -->

## Dependencies

<!-- autogen:start:dependencies hash=73abf80fbc5c -->
|  |  |
| --- | --- |
| Package | `readme-sync` |
| Version | `0.1.0` |
| Engine: node | `>=20` |

**Runtime dependencies**

| Package | Declared | Resolved (pnpm-lock.yaml) |
| --- | --- | --- |
| `@actions/core` | `^1.11.1` | `1.11.1` |
| `@actions/github` | `^6.0.0` | `6.0.1` |
| `commander` | `^13.1.0` | `13.1.0` |
| `diff` | `^8.0.2` | `8.0.4` |
| `picomatch` | `^4.0.2` | `4.0.7` |
| `remark-parse` | `^11.0.0` | `11.0.0` |
| `smol-toml` | `^1.3.4` | `1.8.0` |
| `typescript` | `^5.8.3` | `5.9.3` |
| `unified` | `^11.0.5` | `11.0.5` |
| `yaml` | `^2.8.0` | `2.9.1` |
| `zod` | `^3.25.67` | `3.25.76` |

**Dev dependencies**

| Package | Declared | Resolved (pnpm-lock.yaml) |
| --- | --- | --- |
| `@eslint/js` | `^9.29.0` | `9.39.5` |
| `@types/diff` | `^8.0.0` | `8.0.0` |
| `@types/mdast` | `^4.0.4` | `4.0.4` |
| `@types/node` | `^22.15.32` | `22.20.3` |
| `@types/picomatch` | `^4.0.0` | `4.0.3` |
| `@types/unist` | `^3.0.3` | `3.0.3` |
| `eslint` | `^9.29.0` | `9.39.5` |
| `fast-check` | `^4.1.1` | `4.10.1` |
| `prettier` | `^3.5.3` | `3.9.8` |
| `tsup` | `^8.5.0` | `8.5.1` |
| `typescript-eslint` | `^8.34.1` | `8.70.0` |
| `vitest` | `^3.2.4` | `3.2.7` |
| `zod-to-json-schema` | `^3.24.5` | `3.25.2` |
<!-- autogen:end:dependencies -->

## Changelog

<!-- autogen:start:changelog hash=5dea217f09fa -->
**Other**

- GitHub Action, check|commit|pr modes, loop guard, rebase-retry, monorepo (`10c58db`)
- fail-closed flag coverage, PR comment upsert, comment/explain hardening (`7b09a52`)
- changelog extractor (deterministic + optional validated LLM) (`7c472cc`)
- structure + api extractors with snapshot diffing (`0d3f665`)
- incremental engine, state, commands + dependencies extractors, CLI (`d8ce1bd`)
- scaffold, config schema, marker parser and offset splicer (`07da88c`)
- Write README describing the auto-README CI plugin (`ce31c4e`)
- Initial commit (`cc99bff`)

**API changes**

- Changed export `AnthropicProvider`: `const AnthropicProvider: typeof AnthropicProvider` → `class AnthropicProvider(apiKey: string, baseUrl?) { complete(req: LlmRequest): Promise<string>; name: "anthropic" }`
- Changed export `apply`: `apply(run2: any): Promise<{ written: any[]; }>` → `apply(run: RunPlan): Promise<ApplyResult>`
- Changed export `bodyHash`: `bodyHash(body: any): string` → `bodyHash(body: string): string`
- Changed export `buildCommentBody`: `buildCommentBody(run2: any, opts?: {}): string` → `buildCommentBody(run: RunPlan, opts?: { readmeDiff?: string; runUrl?: string; }): string`
- Changed export `COMMENT_MARKER`: `const COMMENT_MARKER: any` → `const COMMENT_MARKER: "<!-- readme-sync:comment -->"`
- Changed export `CONFIG_FILENAME`: `const CONFIG_FILENAME: any` → `const CONFIG_FILENAME: ".readme-sync.yml"`
- Changed export `configSchema`: `const configSchema: any` → `const configSchema: z.ZodObject<{ version: z.ZodDefault<z.ZodLiteral<1>>; packages: z.ZodDefault<z.ZodArray<z.ZodObject<{ path: z.ZodDefault<z.ZodString>; readme: z.ZodDefault<z.ZodString>; sections: z.ZodDefault<z.ZodObject<{ structure: z…`
- Changed export `createLlmProvider`: `createLlmProvider(config: any, override: any): AnthropicProvider | MockProvider | undefined` → `createLlmProvider(config: Config, override?: string): LlmProvider | undefined`
- Changed export `formatFlag`: `formatFlag(f: any): string` → `formatFlag(f: StaleFlag): string`
- Changed export `Git`: `const Git: typeof Git` → `class Git(cwd: string) { add(paths: string[]): Promise<void>; changedFiles(base: string, head?: string): Promise<ChangedFile[]>; commit(message: string, opts?: { authorName?: string; authorEmail?: string; }): Promise<string>; commitAuthor(rev?: string): Promise<{ name: string; email: string; }>; commitExists(sha: string): Promise<boolean>; commitMessage(rev?: string): Promise<string>; commitsBetw…`
- Changed export `init`: `init(opts: any): Promise<{ wroteConfig: boolean; readmes: never[]; }>` → `init(opts: InitOptions): Promise<InitResult>`
- Changed export `insertMarkers`: `insertMarkers(source: any, pkg: any, adopt: any): { after: any; inserted: string[]; adopted: string[]; skipped: { id: string; why: any; }[]; }` → `insertMarkers(source: string, pkg: ResolvedPackage, adopt: boolean): { after: string; inserted: SectionId[]; adopted: SectionId[]; skipped: Array<{ id: SectionId; why: string; }>; }`
- Changed export `loadConfig`: `loadConfig(repoRoot: any, configPath: any): Promise<{ config: any; file: undefined; } | { config: any; file: string; }>` → `loadConfig(repoRoot: string, configPath?: string): Promise<LoadedConfig>`
- Changed export `MarkerRegion`: `interface MarkerRegion { id: string; /** Hash recorded in the start marker, if any. */ hash: string | undefined; /** Offset of the first char of the start marker. */ start: number; /** Offset just past the last char of the end marker. */ end: number; bodyStart: number; bodyEnd: number; /** Canonical body: the region text with one leading and trailing newline stripped. */ body: string; /** Extra a…` → `interface MarkerRegion { id: string; hash: string | undefined; start: number; end: number; bodyStart: number; bodyEnd: number; body: string; attrs: Record<string, string>; }`
- Changed export `MockProvider`: `const MockProvider: typeof MockProvider` → `class MockProvider { calls: LlmRequest[]; complete(req: LlmRequest): Promise<string>; name: "mock"; reply(text: string): this }`
- Changed export `PackagePlan`: `interface PackagePlan { pkg: ResolvedPackage; headSha: string; baseSha: string | null; fullMode: boolean; fullModeReason?: string; files: MappedFile[]; sections: SectionPlan[]; flags: StaleFlag[]; readmeBefore?: string; readmeAfter?: string; readmeChanged: boolean; stateBefore: PackageState; stateAfter: PackageState; /** Fatal package-level problem (e.g. malformed markers). Nothing is written for…` → `interface PackagePlan { pkg: ResolvedPackage; headSha: string; baseSha: string | null; fullMode: boolean; fullModeReason?: string; files: MappedFile[]; sections: SectionPlan[]; flags: StaleFlag[]; readmeBefore?: string; readmeAfter?: string; readmeChanged: boolean; stateBefore: PackageState; stateAfter: PackageState; error?: string; _contexts?: Map<SectionId, ExtractContext>; }`
- Changed export `parseConfig`: `parseConfig(input: any, sourceName?: any): any` → `parseConfig(input: unknown, sourceName?: string): Config`
- Changed export `parseReadme`: `parseReadme(source: any): { source: any; regions: { id: string | undefined; hash: any; attrs: {}; start: any; end: any; bodyStart: any; bodyEnd: any; body: any; }[]; headings: { depth: any; text: any; start: any; end: any; }[]; }` → `parseReadme(source: string): ParsedReadme`
- Changed export `plan`: `plan(opts: any): Promise<{ repoRoot: any; headSha: any; packages: { pkg: any; headSha: any; baseSha: null; fullMode: boolean; files: never[]; sections: any[]; flags: any[]; readmeChanged: boolean; stateBefore: any; stateAfter: any; }[]; fl…` → `plan(opts: RunOptions): Promise<RunPlan>`
- Changed export `planToJson`: `planToJson(run2: any): { headSha: any; changed: any; packages: any; }` → `planToJson(run: RunPlan): unknown`
- Changed export `regionIsPristine`: `regionIsPristine(region: any): boolean` → `regionIsPristine(region: MarkerRegion): boolean`
- Changed export `renderRegion`: `renderRegion(id: any, body: any, attrs?: {}): string` → `renderRegion(id: string, body: string, attrs?: Record<string, string>): string`
- Changed export `ResolvedPackage`: `interface ResolvedPackage { /** Repo-relative POSIX path, "." for the root. */ path: string; /** Stable slug used for state directories. */ slug: string; absPath: string; /** Repo-relative POSIX path of the README. */ readme: string; absReadme: string; /** Repo-relative POSIX path of this package's state directory. */ stateDir: string; sections: Record<SectionId, SectionConfig>; /** Package-relat…` → `interface ResolvedPackage { path: string; slug: string; absPath: string; readme: string; absReadme: string; stateDir: string; sections: Record<SectionId, SectionConfig>; ignore: string[]; }`
- Changed export `resolvePackages`: `resolvePackages(repoRoot: any, config: any): Promise<any>` → `resolvePackages(repoRoot: string, config: Config): Promise<ResolvedPackage[]>`
- Changed export `RunOptions`: `interface RunOptions { repoRoot: string; config: Config; /** Override the base commit (defaults to the package's recorded lastSha). */ base?: string; /** Overwrite sections that were manually edited inside their markers. */ force?: boolean; /** Advance lastSha even when stale flags were raised. */ acceptStale?: boolean; /** Only process packages whose path is in this list. */ packages?: string[];…` → `interface RunOptions { repoRoot: string; config: Config; base?: string; force?: boolean; acceptStale?: boolean; packages?: string[]; sections?: SectionId[]; llm?: LlmProvider; includeWorkingTree?: boolean; forceExtract?: boolean; }`
- Changed export `RunPlan`: `interface RunPlan { repoRoot: string; headSha: string; packages: PackagePlan[]; flags: StaleFlag[]; /** True when at least one README would change. */ changed: boolean; }` → `interface RunPlan { repoRoot: string; headSha: string; packages: PackagePlan[]; flags: StaleFlag[]; changed: boolean; }`
- Changed export `SectionPlan`: `interface SectionPlan { id: SectionId; status: SectionStatus; reason: string; /** Package-relative files that made this section run. */ affectedBy: string[]; confidence?: number; diagnostics: string[]; oldBody?: string; newBody?: string; inputHash?: string; data?: unknown; /** Set when extraction succeeded (used for afterWrite hooks). */ extracted: boolean; }` → `interface SectionPlan { id: SectionId; status: SectionStatus; reason: string; affectedBy: string[]; confidence?: number; diagnostics: string[]; oldBody?: string; newBody?: string; inputHash?: string; data?: unknown; extracted: boolean; }`
- Changed export `spliceMany`: `spliceMany(source: any, updates: any): any` → `spliceMany(source: string, updates: Array<{ region: MarkerRegion; body: string; }>): string`
- Changed export `spliceRegion`: `spliceRegion(source: any, region: any, newBody: any): string` → `spliceRegion(source: string, region: MarkerRegion, newBody: string): string`
- Changed export `StaleFlag`: `interface StaleFlag { /** Package path ("." for root). */ pkg: string; /** Section affected, or undefined when the flag is not attributable to one section. */ section?: SectionId; reason: FlagReason; message: string; /** Package-relative files that triggered the flag. */ files: string[]; }` → `interface StaleFlag { pkg: string; section?: SectionId; reason: FlagReason; message: string; files: string[]; }`
<!-- autogen:end:changelog -->

## Development

```sh
pnpm install
pnpm build        # dist/cli, dist/index (library) and dist/action/index.js (Action bundle)
pnpm test         # vitest; integration tests create temporary git repositories
pnpm typecheck
pnpm lint         # eslint + prettier --check
pnpm check        # build + test + lint
pnpm schema       # regenerate schema/readme-sync.schema.json from the zod schema
node dist/cli/index.js plan -v   # run the tool on this repository
```

`dist/action/index.js` is committed so the Action can run without a build step. Rebuild and commit it whenever `src/` changes; CI fails if it is stale. CI also runs `update --check` on this repository's own README for every section except the changelog.

Before changing behaviour, read [`docs/DECISIONS.md`](docs/DECISIONS.md) and add a `D-0xx` entry for any non-obvious call. The invariants (human bytes untouched, idempotency, surgical scope, determinism, fail closed, loop safety) are enforced by tests; please do not weaken them.

## Design notes

- [`docs/DESIGN.md`](docs/DESIGN.md): architecture, the incremental engine, invariants.
- [`docs/DECISIONS.md`](docs/DECISIONS.md): the decision log, with reasoning.

## Non-goals (for now)

Full-document LLM rewrites, languages beyond TypeScript/JavaScript/Python, non-GitHub CI wrappers (the core is CI-agnostic, so a GitLab wrapper is a thin layer), and a web UI.

## License

MIT

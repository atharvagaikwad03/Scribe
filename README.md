# ubiquitous-tribble

**A CI-integrated plugin that keeps `README.md` in sync with the codebase, surgically.**

Most README generators do a one-shot full rewrite from an LLM prompt. That clobbers hand-written prose, badges, and custom sections, and the tone drifts on every run. This project takes a different approach: it treats the README as a document with *owned regions*, regenerates only the regions affected by a code change, and refuses to guess when it can't map a change to a section.

<!-- autogen:start:status -->
> **Status:** design phase. No code yet. This README is the problem statement and plan.
<!-- autogen:end:status -->

---

## The problem

A README is written once and then left to rot. Install commands change, exported functions come and go, dependencies get bumped, and nobody updates the docs. Existing tools (readme-ai, assorted GitHub Actions) "fix" this by regenerating the whole file, which is worse than stale docs for anyone who wrote careful prose.

The useful version of this tool is **incremental and section-aware**:

1. Parse the existing README into sections using the markdown AST, with headers as anchors.
2. Distinguish **generated** sections (owned by the tool) from **human-owned** free text.
3. Diff the codebase since the last generation, using `git diff` against the last commit the tool ran on.
4. Regenerate only the generated sections that the diff actually affects.
5. **Fail closed.** If a change can't be confidently mapped to a section, leave a PR comment saying the README may be stale there instead of editing content.

Section ownership plus incremental diff-driven regeneration is the differentiator. Mainstream tools don't do this well yet.

## What it captures

| Area | Source of truth | Behaviour |
|---|---|---|
| Project structure | Filesystem scan | Entry points, folder layout, detected language and framework |
| Public API surface | Language-aware export analysis | Exported functions, CLI commands, HTTP endpoints. Diffed against the last known surface, not re-derived from scratch |
| Install / run / build commands | `package.json` scripts, `Makefile`, `Dockerfile`, `pyproject.toml` | Pulled from real config, never guessed |
| Dependencies | Lockfiles and manifests | Name and version list |
| Recent changes | Commit messages and diff summaries | Folded into a changelog-style section |

## How section ownership works

Generated regions are wrapped in HTML comment markers so they survive any markdown renderer and are trivially parseable:

```markdown
## API

<!-- autogen:start:api -->
- `parseReadme(source: string): Section[]`
- `applyPatch(sections: Section[], patch: Patch): string`
<!-- autogen:end:api -->

## Why this project exists

Free text here is human-owned. The tool never touches it.
```

Anything outside a marker pair is human-owned and is left byte-for-byte intact. Anything inside is owned by the tool and may be rewritten when its inputs change.

## Trigger

A CI step fires after a successful build. Supported shapes:

- **GitHub Action** running on push to the target branch.
- **Pre-push hook** for local-first workflows.
- **Build pipeline stage** for other CI systems.

## Failure modes designed against

- **Infinite loop.** The README update is itself a commit and could re-trigger the pipeline. Guard with a `[skip ci]` tag, or bail early when the only changed file is `README.md`.
- **Merge conflicts.** Two branches both regenerating the README will collide. Run post-merge on the target branch rather than per-branch, or make the patch rebase-safe.
- **Monorepos.** One root README versus per-package READMEs. Scope is configurable per directory.
- **Low-confidence mapping.** Never guess. Comment on the PR and let a human decide.

## Planned shape

- A small **CLI** that does the parsing, diffing, and patching, runnable locally.
- A thin **GitHub Action** wrapper around the CLI.
- A config file (name TBD) declaring which sections exist, what feeds them, and the monorepo scope.

## Roadmap

- [ ] Markdown AST parser with `autogen` marker detection
- [ ] Section model: generated vs. human-owned
- [ ] Last-run commit tracking and `git diff` scoping
- [ ] Config-driven extractors: scripts, dependencies, structure
- [ ] Public API surface extraction and diffing
- [ ] Changelog section from commit history
- [ ] Fail-closed PR commenting
- [ ] Loop guard and post-merge execution
- [ ] GitHub Action wrapper
- [ ] Monorepo scoping

## Contributing

This is a Claude Community Build repo. Issues and PRs are welcome. If you're touching this README, edit anything outside the `autogen` markers freely. The tool owns what's inside them.

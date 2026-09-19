# readme-sync — notes for coding agents

## What this is

A CLI + GitHub Action that keeps `README.md` in sync with the codebase by
regenerating only tool-owned marker regions, only when their inputs change,
and flagging instead of guessing. Read `docs/DESIGN.md` for the architecture
and `docs/DECISIONS.md` before changing behaviour; add a `D-0xx` entry when
you make a non-obvious call.

## Build / test / lint

```sh
pnpm install
pnpm build        # tsup: dist/cli + dist/index (library) + dist/action/index.js (Action bundle)
pnpm test         # vitest (unit + integration; integration tests create temp git repos)
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint + prettier --check
pnpm check        # build + test + lint
pnpm schema       # regenerate schema/readme-sync.schema.json from the zod schema (after build)
node dist/cli/index.js plan -v   # run the tool on this repo
```

The CLI integration tests (`test/integration/cli.test.ts`) build `dist/cli`
themselves. `dist/action/index.js` is **committed**; rebuild it with
`pnpm build` whenever `src/` changes and commit the result, or CI fails.

## Invariants (tests enforce these; do not weaken them)

1. **Human bytes.** Every byte outside `<!-- autogen:start:x -->…<!-- autogen:end:x -->`
   is byte-identical after any run (`test/unit/markers.test.ts`, property based).
   Never re-serialise the markdown document; splice by offset only.
2. **Idempotency.** Running `update` twice yields no diff and no writes the second time.
3. **Surgical scope.** A change regenerates only sections whose watched files changed
   *and* whose extracted data changed. Internal refactors with an unchanged public
   surface produce no README diff.
4. **Determinism.** Same inputs, same bytes. Sort everything. No timestamps in bodies.
   LLM output (changelog only, off by default) is validated per bullet and cached by input hash.
5. **Fail closed.** Unmapped surface-relevant files, low confidence, extractor errors,
   manual edits inside markers, malformed/missing markers → stale flag, section untouched,
   `lastSha` not advanced. Never guess.
6. **Loop safety.** Tool commits carry `[skip ci]` and the `readme-sync: auto` trailer; the
   Action exits early on its own commits / README-only commits; identical output → no commit.

## Layout

- `src/markdown/markers.ts` — marker parsing (remark positions only) and offset splicing.
- `src/engine/` — diff → map → extract → render → splice; `mapping.ts` is watch-glob logic.
- `src/extractors/<section>/` — one generator per section (`extract()` deterministic, `render()` pure).
- `src/state/` — `.readme-sync/state.json` and `api-surface.json`.
- `src/flags/` — stale-flag types and surface-relevance rules.
- `src/cli/` — commander commands; `src/action/` — GitHub Action entry, loop guard, commit/push retry.
- `test/helpers/repo.ts` — temp git repo fixtures (TS package, Python package).

## Conventions

- TypeScript strict, ESM, Node ≥ 20. `pnpm`. Conventional Commits.
- Extractors must never throw on *missing* inputs (return empty data) but **should** throw on
  *malformed* inputs (that becomes an `extractor-error` flag).
- Any new section id goes in `SECTION_IDS`, `DEFAULT_ANCHORS`, the registry, and gets a fixture test.

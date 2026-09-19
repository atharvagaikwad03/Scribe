# Decisions

A running log of design decisions made while building `readme-sync`, with the
reasoning. Newest at the bottom. Each entry should be short enough to read in
a minute.

## D-001: Splice by string offsets, never re-serialise markdown

We parse the README with `remark-parse` **only to find positions** of
`html` nodes (the autogen markers) and headings (anchors for `init`). The new
body is spliced into the original string by offset. We never call a markdown
stringifier.

Why: any stringifier normalises something (list bullets, emphasis markers,
table alignment, trailing whitespace). That would violate the core promise
that human-owned bytes are untouched. The property-based test in
`test/unit/markers.test.ts` enforces this.

Using the AST rather than a regex also means markers quoted inside fenced code
blocks are correctly ignored, because they are `code` nodes, not `html`.

## D-002: Marker body canonical form is `\n<body>\n`

The tool always writes the start marker, a newline, the body with trailing
whitespace trimmed, a newline, and the end marker. The recorded `hash` is the
truncated sha256 of the trimmed body. When re-reading, exactly one leading and
one trailing line break are stripped before hashing. This makes the write path
idempotent and makes any human edit inside the region (including deleting the
newline) show up as a hash mismatch.

## D-003: A marker without `hash=` is writable

`init` emits markers with a hash of the placeholder body, but a hand-inserted
marker pair with no hash attribute is treated as "unclaimed": the tool may
write it. Once written, it carries a hash and manual edits are detected.
Rationale: users adopting the tool by hand should not have to compute hashes.

## D-004: Unknown config keys are errors

The zod schema is `.strict()` everywhere. A typo like `watchh` fails loudly
instead of silently doing nothing, which matters for a tool whose job is to
not do the wrong thing quietly.

## D-005: State directory layout

Single-package repos use `.readme-sync/state.json` and
`.readme-sync/api-surface.json` directly. Monorepo packages use
`.readme-sync/packages/<slug>/…`, where the slug is the package path with
non-alphanumerics replaced by `__`. Keeping the common case flat keeps the
committed tree readable.

## D-006: Node 22 locally, Node 20 as the floor

The spec asks for Node 20. The development machine has Node 22, and nothing
in the code uses post-20 APIs. `engines.node` is `>=20` and the Action runs
on `node20`.

## D-007: Verify marker structure after every splice

The property test found that a rendered body containing an unclosed code
fence swallows the end marker. Rather than trusting renderers, `spliceMany`
re-parses its output and requires the same section ids in the same order,
otherwise it throws a `MarkerError` and the file is never written. This turns
a whole class of renderer bugs into a fail-closed error.

## D-008: CI config only flags on add/delete

The spec lists CI configuration as "surface relevant" for unmapped-file
flags. Flagging every workflow tweak would make the stale comment noise that
people learn to ignore. We flag CI files only when they are added or deleted
(a new or removed pipeline changes how the project is built); modifications
are not flagged. Users can widen this with `watchExtra` on a section.

## D-009: Stale flags block `lastSha` from advancing

If a run raises any stale flag, sections that *did* regenerate are still
written and their state recorded, but `lastSha` stays where it was. The next
run therefore re-examines the same diff and re-raises the flag until a human
resolves it (fix markers, adjust config, `--force` for manual edits, or
`--accept-stale` to acknowledge). This is the mechanical meaning of "fail
closed": an unaccounted change is never silently forgotten. Cost: the diff
range grows until resolved; extractors are cheap and idempotent so this is
acceptable.

## D-010: Makefile targets: documented subset wins

If any target carries a `## description`, only documented targets are listed.
Otherwise every plain target is listed. This follows the common
`make help` convention without hiding everything in undocumented Makefiles.

## D-011: Working-tree changes are included in the diff

`plan`/`update` consider uncommitted changes as well as `lastSha..HEAD`, so a
developer editing `package.json` locally sees the README update before
committing. Because extractors read the working tree anyway, this keeps the
"what changed" view and the "what we extracted" view consistent.

## D-012: Docker "build" command is derived

`docker build -f <file> .` is the one command we emit that is not literally
present in a config file. A Dockerfile's only purpose is to be built, so we
consider this reading the config, not guessing. Everything else (scripts,
make targets, console scripts) is copied verbatim.

## D-016: Changelog history lives in state, not in the README

The rendered changelog is a pure function of `state.changelog` (entries,
API changes, optional highlights). New commits since `lastSha` are parsed,
prepended, deduped by SHA and capped to `changelog.maxEntries`. We never
parse the README's changelog body back, so a human cannot "corrupt" the
history by editing it (they would only trigger the manual-edit flag), and the
output is byte-identical for identical state. No dates are rendered.

## D-017: LLM output is validated per bullet and cached by input hash

The optional LLM sees only commit subjects and diff stats. Every bullet must
carry a SHA that prefixes a commit in the input; one bad bullet rejects the
whole response and the deterministic rendering is used (with a diagnostic).
Accepted output is cached in `.readme-sync/llm-cache.json` keyed by a hash
of (provider, model, stats), so re-running on the same inputs never calls the
model again and can never drift in tone. Highlights are pruned when their
commit falls off the entry cap.

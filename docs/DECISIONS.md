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

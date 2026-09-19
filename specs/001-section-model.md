# 001 — Section model

**Status:** draft

Defines how a README is decomposed into regions, which regions the tool owns, and the guarantees it offers about the rest.

## 1. Motivation

The differentiator over one-shot regenerators is that human prose survives. That guarantee has to be mechanical, not best-effort: the tool must be structurally incapable of editing text it does not own.

## 2. Marker syntax

Generated regions are delimited by HTML comments, which every markdown renderer discards and every markdown parser preserves in the AST.

```markdown
<!-- autogen:start:api -->
- `parseReadme(source: string): Section[]`
<!-- autogen:end:api -->
```

- **001-R1** — A start marker MUST match `^<!--\s*autogen:start:([a-z0-9][a-z0-9-]*)\s*-->$` on a line of its own.
- **001-R2** — An end marker MUST match `^<!--\s*autogen:end:([a-z0-9][a-z0-9-]*)\s*-->$` on a line of its own.
- **001-R3** — Section IDs are lowercase kebab-case, 1–64 characters. IDs MUST be unique within a document.
- **001-R4** — Markers MUST NOT nest. A start marker encountered while a region is open is a parse error.
- **001-R5** — Every start marker MUST have a matching end marker with an identical ID. Unmatched or mismatched markers are parse errors.

Marker recognition is line-based and performed on raw source, not on the rendered AST. A marker indented inside a list item or blockquote is **not** recognised, and its content stays human-owned — deliberately, since a region that moves with surrounding structure cannot be patched safely.

- **001-R6** — Markers inside fenced code blocks MUST be ignored. The README documents its own marker syntax inside fences; the tool must not treat its own documentation as a live region.

## 3. Data model

```ts
type SectionId = string;

interface HumanSection {
  kind: 'human';
  /** Raw source, including all whitespace and line endings. */
  content: string;
}

interface GeneratedSection {
  kind: 'generated';
  id: SectionId;
  /** Raw source between the markers, excluding the marker lines. */
  content: string;
  /** Byte offsets into the original source, for precise patching. */
  range: { start: number; end: number };
  /** Marker lines verbatim, so they round-trip unchanged. */
  markers: { start: string; end: string };
}

type Section = HumanSection | GeneratedSection;
```

- **001-R7** — `parseReadme(source: string): Section[]` MUST return sections in document order, covering the input with no gaps and no overlaps.
- **001-R8** — Concatenating every section's source representation MUST reproduce the input byte-for-byte. This is the round-trip invariant and is the tool's core safety property.

## 4. Ownership

- **001-R9** — Content inside a marker pair is **tool-owned** and MAY be rewritten.
- **001-R10** — Everything else — prose, badges, headings, tables, the marker lines themselves — is **human-owned** and MUST be preserved byte-for-byte.
- **001-R11** — A section ID present in the document but absent from config is **orphaned**. The tool MUST leave orphaned regions untouched and report them; an ID removed from config must never silently delete committed content.
- **001-R12** — A section ID present in config but absent from the document is **unplaced**. The tool MUST NOT invent a location for it. It is reported, and placement is a human decision.

## 5. Patching

```ts
interface Patch {
  edits: Array<{ id: SectionId; content: string }>;
}

function applyPatch(sections: Section[], patch: Patch): string;
```

- **001-R13** — `applyPatch` MUST apply edits by byte range, longest offset first, so earlier edits do not invalidate later offsets.
- **001-R14** — An edit naming an unknown or orphaned section ID MUST fail the whole patch. Patches are atomic: all edits apply, or none do.
- **001-R15** — Replacement content MUST be normalised to end with exactly one newline before the closing marker, so regeneration is idempotent regardless of extractor output.
- **001-R16** — The file's dominant line ending (LF or CRLF) MUST be detected and preserved in generated content.

## 6. Idempotence

- **001-R17** — Running a generation twice against an unchanged codebase MUST produce a byte-identical file on the second run. Non-idempotent extractors — timestamps, unstable ordering, nondeterministic LLM prose — are defects under [003](003-extractors.md).

## 7. Edge cases

| Case | Behaviour |
|---|---|
| Empty region (markers adjacent) | Valid. Parses as a generated section with `content: ''`. |
| Marker inside a fenced code block | Ignored (001-R6). |
| Marker indented or inside a list | Not recognised; content stays human-owned. |
| Duplicate IDs | Parse error. |
| End marker with no start | Parse error. |
| No markers at all | Valid. One human section; the tool has nothing to own and exits cleanly. |
| File absent | Not an error for `check`; `init` is the command that creates one. |
| CRLF line endings | Preserved (001-R16). |
| Byte-order mark | Preserved as part of the leading human section. |

## 8. Acceptance criteria

- Round-trip: for a corpus of real-world READMEs, `applyPatch(parseReadme(s), { edits: [] }) === s`.
- Property test: for arbitrary generated documents, the round-trip invariant (001-R8) holds.
- Every parse error in §7 is reported with a line number and the offending marker text.
- Mutation test: an implementation that writes outside a marker range fails at least one test.

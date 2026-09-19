# Specifications

Technical specs for the incremental, section-aware README synchroniser described in the [root README](../README.md).

The root README is the problem statement. These documents are the design: they fix the data model, the algorithms, and the failure behaviour precisely enough to implement against.

## Index

| Spec | Title | Covers |
|---|---|---|
| [001](001-section-model.md) | Section model | Marker syntax, parsing, ownership, byte-preservation invariant |
| [002](002-change-detection.md) | Change detection | Last-run tracking, diff scoping, change→section mapping, confidence |
| [003](003-extractors.md) | Extractors | The extractor contract and the five built-in extractors |
| [004](004-configuration.md) | Configuration | Config file schema, section declarations, monorepo scoping |
| [005](005-cli.md) | CLI | Commands, flags, exit codes, output formats |
| [006](006-ci-integration.md) | CI integration | GitHub Action, loop guard, merge safety, PR commenting |

## Conventions

**Requirement levels** follow [RFC 2119](https://datatracker.ietf.org/doc/html/rfc2119): MUST, SHOULD, MAY.

**Requirement IDs** are stable and citable, formatted `<spec>-R<n>` — for example `001-R4`. Once assigned, an ID is never reused for a different requirement; a withdrawn requirement is struck through and kept in place.

**Code samples** are TypeScript. This follows the root README, which specifies signatures such as `parseReadme(source: string): Section[]` and names `package.json` as a first-class input.

## Status

All specs are **draft**. Nothing here has been implemented; no spec has been ratified by a second reader.

## Open questions

Decisions made here that the root README left unresolved, and which the repo owner may want to overturn:

1. **Config filename.** These specs use `readmesync.config.json`. The root README records this as "name TBD".
2. **Last-run tracking mechanism.** [002](002-change-detection.md) selects a committed state file over git notes or commit trailers, and documents why. Git notes are the strongest alternative.
3. **Language and runtime.** TypeScript on Node, inferred from the root README rather than stated by it.

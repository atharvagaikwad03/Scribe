# 004 — Configuration

**Status:** draft

Defines the config file: which sections exist, what feeds them, and how scope is set in a monorepo.

## 1. File

- **004-R1** — Config is read from `readmesync.config.json` at the scope root.

> The root README records this name as TBD. It is the one naming decision these specs take unilaterally; see the open questions in the [index](README.md).

- **004-R2** — A missing config is not an error for `init`. For every other command it is a fatal error with a pointer to `init`.
- **004-R3** — Config MUST be validated against a published JSON Schema before use. Validation errors name the JSON path and the expectation.
- **004-R4** — Unknown keys MUST be rejected, not ignored. A typo in a section name silently disabling regeneration is precisely the rot this tool exists to prevent.

## 2. Schema

```json
{
  "version": 1,
  "readme": "README.md",
  "confidenceThreshold": 0.8,
  "sections": {
    "status":       { "extractor": "static" },
    "structure":    { "extractor": "structure",    "inputs": ["src/**", "*.config.*"], "options": { "maxDepth": 3 } },
    "install":      { "extractor": "install",      "inputs": ["package.json", "Makefile", "Dockerfile"] },
    "dependencies": { "extractor": "dependencies", "inputs": ["package.json", "package-lock.json"] },
    "api":          { "extractor": "api-surface",  "inputs": ["src/**/*.ts"], "options": { "entry": "src/index.ts" } },
    "changes":      { "extractor": "changelog",    "inputs": ["src/**"], "options": { "limit": 10 } }
  },
  "scopes": []
}
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `version` | integer | required | Schema version. Unrecognised values are fatal. |
| `readme` | string | `README.md` | Target document, relative to scope root. |
| `confidenceThreshold` | number | `0.8` | Below this, warn instead of edit (002-R13). |
| `sections` | object | required | Section ID to definition. Keys MUST satisfy 001-R3. |
| `scopes` | array | `[]` | Monorepo scopes. Empty means single-scope. |

### Section definition

| Field | Type | Default | Meaning |
|---|---|---|---|
| `extractor` | string | required | Built-in name or module path (003-R16, 003-R17). |
| `inputs` | string[] | `[]` | Globs. A section with no inputs is never affected by a diff and regenerates only on `--all`. |
| `options` | object | `{}` | Passed through as `ctx.options`. Validated by the extractor. |
| `confidenceThreshold` | number | inherited | Per-section override. |

- **004-R5** — `inputs` globs are relative to the scope root and MUST NOT escape it. A leading `../` is a validation error.

## 3. Monorepo scoping

The root README lists monorepos as a designed-against failure mode: one root README versus per-package READMEs.

```json
{
  "version": 1,
  "scopes": [
    { "root": ".",             "readme": "README.md",         "sections": { "structure": { "extractor": "structure", "inputs": ["packages/*"] } } },
    { "root": "packages/core", "readme": "README.md",         "sections": { "api": { "extractor": "api-surface", "inputs": ["src/**"] } } },
    { "root": "packages/cli",  "readme": "docs/reference.md", "sections": { "api": { "extractor": "api-surface", "inputs": ["src/**"] } } }
  ]
}
```

- **004-R6** — Each scope is processed independently: its own README, sections, state, and diff filter.
- **004-R7** — A scope MUST only observe changes under its `root`. A change in `packages/cli` MUST NOT regenerate the `packages/core` README.
- **004-R8** — Scopes MUST NOT overlap. Two scopes writing the same `readme` path is a validation error.
- **004-R9** — State is per-scope, at `<root>/.autoreadme/state.json`, so one scope's cold start does not force others.
- **004-R10** — A scope whose `root` does not exist is a validation error, not a skip. Silently skipping a renamed package reintroduces rot.

## 4. Precedence

CLI flags override config; config overrides defaults. Environment variables are not a configuration source: an invisible input contradicts reproducibility.

## 5. Acceptance criteria

- A config with an unknown key fails validation naming the key and its path (004-R4).
- A config with two scopes targeting one README fails validation (004-R8).
- An `inputs` entry escaping the scope root fails validation (004-R5).
- In a three-scope monorepo, a change in one scope regenerates exactly one README (004-R7).
- Every documented default matches the published schema, verified by test rather than by review.

import { z } from 'zod';

export const SECTION_IDS = [
  'structure',
  'api',
  'commands',
  'dependencies',
  'changelog',
  'packages',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export const sectionIdSchema = z.enum(SECTION_IDS);

export const sectionConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Heading text under which `init` inserts the markers, e.g. "## API". */
    anchor: z.string().optional(),
    /** Globs (relative to the package root) whose changes affect this section. Replaces the default list. */
    watch: z.array(z.string()).optional(),
    /** Extra globs appended to the default watch list. */
    watchExtra: z.array(z.string()).default([]),
    /** Directory depth for the `structure` tree. */
    depth: z.number().int().min(1).max(6).optional(),
    /** Free-form, extractor-specific options. */
    options: z.record(z.unknown()).default({}),
  })
  .strict();
export type SectionConfig = z.infer<typeof sectionConfigSchema>;

export const sectionsSchema = z
  .object({
    structure: sectionConfigSchema.default({}),
    api: sectionConfigSchema.default({}),
    commands: sectionConfigSchema.default({}),
    dependencies: sectionConfigSchema.default({}),
    changelog: sectionConfigSchema.default({}),
    packages: sectionConfigSchema.default({ enabled: false }),
  })
  .strict();
export type SectionsConfig = z.infer<typeof sectionsSchema>;

/** Partial per-package override: every field optional so it can layer on the root defaults. */
export const packageSectionsOverrideSchema = z
  .object({
    structure: sectionConfigSchema.partial().optional(),
    api: sectionConfigSchema.partial().optional(),
    commands: sectionConfigSchema.partial().optional(),
    dependencies: sectionConfigSchema.partial().optional(),
    changelog: sectionConfigSchema.partial().optional(),
    packages: sectionConfigSchema.partial().optional(),
  })
  .strict();

export const packageConfigSchema = z
  .object({
    /** Package root relative to the repo root. "." is the repo itself. */
    path: z.string().default('.'),
    /** README path relative to the package root. */
    readme: z.string().default('README.md'),
    sections: packageSectionsOverrideSchema.default({}),
    /** Globs (relative to the package root) that never affect any section. */
    ignore: z.array(z.string()).default([]),
  })
  .strict();
export type PackageConfig = z.infer<typeof packageConfigSchema>;

export const llmConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(['anthropic', 'mock']).default('anthropic'),
    model: z.string().default('claude-sonnet-5'),
    maxTokens: z.number().int().positive().default(1024),
  })
  .strict();

export const configSchema = z
  .object({
    version: z.literal(1).default(1),
    /** Explicit packages. Empty means: auto-discover workspaces, else single root package. */
    packages: z.array(packageConfigSchema).default([]),
    /** Auto-discover npm/pnpm/yarn workspaces as packages. */
    discoverWorkspaces: z.boolean().default(true),
    /** Root-level section defaults, inherited by every package. */
    sections: sectionsSchema.default({}),
    /** Repo-relative globs that never affect any section (in addition to built-ins). */
    ignore: z.array(z.string()).default([]),
    /** Sections whose extractor confidence is below this are flagged, not written. */
    confidenceThreshold: z.number().min(0).max(1).default(0.7),
    /** Exit non-zero (and fail the Action) when any stale flag is raised. */
    failOnStale: z.boolean().default(false),
    changelog: z
      .object({
        maxEntries: z.number().int().positive().default(50),
        /** Commit trailer used to recognise the tool's own commits. */
        skipTrailer: z.string().default('readme-sync: auto'),
      })
      .strict()
      .default({}),
    llm: llmConfigSchema.default({}),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;

/** Headings `init` uses when a section has no `anchor` configured. */
export const DEFAULT_ANCHORS: Record<SectionId, string> = {
  structure: '## Project structure',
  api: '## API',
  commands: '## Commands',
  dependencies: '## Dependencies',
  changelog: '## Changelog',
  packages: '## Packages',
};

export const CONFIG_FILENAME = '.readme-sync.yml';
export const STATE_DIR = '.readme-sync';
export const COMMENT_MARKER = '<!-- readme-sync:comment -->';

import type { Config, SectionConfig, SectionId } from '../config/schema.js';
import type { ResolvedPackage } from '../config/packages.js';
import type { Git, ChangedFile } from '../git/index.js';
import type { PackageState } from '../state/index.js';
import type { LlmProvider } from '../llm/provider.js';
import type { ApiSurface, ApiDiff } from './api/surface.js';

/** Result of running an extractor. `data` must be deterministic and JSON-serialisable. */
export interface ExtractResult<T = unknown> {
  data: T;
  /** 0..1. Below the configured threshold the section is flagged, not written. */
  confidence: number;
  /** Human-readable notes explaining low confidence or skipped inputs. */
  diagnostics: string[];
}

/** Data shared between extractors within one run (api -> changelog). */
export interface SharedRunData {
  previousSurface?: ApiSurface;
  surface?: ApiSurface;
  apiDiff?: ApiDiff;
}

export interface ExtractContext {
  repoRoot: string;
  pkg: ResolvedPackage;
  section: SectionConfig;
  config: Config;
  git: Git;
  headSha: string;
  state: PackageState;
  /** Mutable copy that will be persisted if the run is applied. Extractors that keep history (changelog) update it. */
  stateAfter: PackageState;
  /** True when there is no usable lastSha and every enabled section is re-derived. */
  fullMode: boolean;
  /** Changed files (package-relative) since lastSha, all of them, not just the ones this section watches. */
  changedFiles: ChangedFile[];
  /** Changed files (package-relative) that matched this section's watch globs. */
  watchedChanges: ChangedFile[];
  shared: SharedRunData;
  /** All files in the package (package-relative POSIX paths), excluding VCS/build dirs. Cached. */
  listFiles(): Promise<string[]>;
  llm?: LlmProvider;
  /** All resolved packages, for the monorepo `packages` table. */
  allPackages: ResolvedPackage[];
}

export interface SectionGenerator<T = unknown> {
  id: SectionId;
  /** Package-relative globs that mark a changed file as affecting this section. Negative globs allowed. */
  defaultWatch: string[];
  /** Limit which change statuses count for the watch globs (default: all). */
  statuses?: Array<ChangedFile['status']>;
  /** Globs that count regardless of `statuses` (e.g. manifests for the structure section). */
  watchAnyStatus?: string[];
  /** Run on every invocation where HEAD != lastSha regardless of changed files. */
  alwaysRun?: boolean;
  extract(ctx: ExtractContext): Promise<ExtractResult<T>>;
  render(data: T, ctx: ExtractContext): string;
  /** Called after a successful write so the generator can persist snapshots (e.g. api-surface.json). */
  afterWrite?(data: T, ctx: ExtractContext): Promise<string[] | void>;
}

export function ok<T>(data: T, diagnostics: string[] = [], confidence = 1): ExtractResult<T> {
  return { data, confidence, diagnostics };
}

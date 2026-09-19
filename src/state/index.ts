import path from 'node:path';
import type { ResolvedPackage } from '../config/packages.js';
import type { SectionId } from '../config/schema.js';
import { readJsonIfExists, writeJson } from '../util/fs.js';

export const STATE_VERSION = 1;

export interface SectionState {
  /** Hash of the normalised extractor output the body was rendered from. */
  inputHash: string;
  /** Hash of the body as written into the README. */
  bodyHash: string;
}

export interface ChangelogEntry {
  sha: string;
  type: string;
  scope?: string;
  breaking: boolean;
  subject: string;
}

export interface ApiChangeEntry {
  /** Head commit at which the change was observed. */
  sha: string;
  kind: 'added' | 'removed' | 'changed';
  category: string;
  name: string;
  signature?: string;
  previous?: string;
}

export interface PackageState {
  version: number;
  toolVersion: string;
  /** Last commit the tool generated against. */
  lastSha: string | null;
  sections: Partial<Record<SectionId, SectionState>>;
  changelog: {
    entries: ChangelogEntry[];
    apiChanges: ApiChangeEntry[];
  };
}

export function emptyState(toolVersion: string): PackageState {
  return {
    version: STATE_VERSION,
    toolVersion,
    lastSha: null,
    sections: {},
    changelog: { entries: [], apiChanges: [] },
  };
}

export function statePath(repoRoot: string, pkg: ResolvedPackage): string {
  return path.join(repoRoot, pkg.stateDir, 'state.json');
}

export function surfacePath(repoRoot: string, pkg: ResolvedPackage): string {
  return path.join(repoRoot, pkg.stateDir, 'api-surface.json');
}

export async function loadState(
  repoRoot: string,
  pkg: ResolvedPackage,
  toolVersion: string,
): Promise<PackageState> {
  const loaded = await readJsonIfExists<Partial<PackageState>>(statePath(repoRoot, pkg));
  const base = emptyState(toolVersion);
  if (!loaded) return base;
  return {
    ...base,
    ...loaded,
    toolVersion,
    sections: loaded.sections ?? {},
    changelog: {
      entries: loaded.changelog?.entries ?? [],
      apiChanges: loaded.changelog?.apiChanges ?? [],
    },
  };
}

export async function saveState(
  repoRoot: string,
  pkg: ResolvedPackage,
  state: PackageState,
): Promise<void> {
  await writeJson(statePath(repoRoot, pkg), state);
}

export async function loadSurface<T>(
  repoRoot: string,
  pkg: ResolvedPackage,
): Promise<T | undefined> {
  return readJsonIfExists<T>(surfacePath(repoRoot, pkg));
}

export async function saveSurface(
  repoRoot: string,
  pkg: ResolvedPackage,
  surface: unknown,
): Promise<void> {
  await writeJson(surfacePath(repoRoot, pkg), surface);
}

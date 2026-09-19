import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { exists, readJsonIfExists, readTextIfExists } from '../util/fs.js';

export interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  private?: boolean;
  type?: string;
  main?: string;
  module?: string;
  types?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  packageManager?: string;
  workspaces?: string[] | { packages?: string[] };
}

/** Missing -> undefined. Malformed -> throws (a manifest we cannot read is a reason to fail closed, not to guess). */
export async function readPackageJson(dir: string): Promise<PackageJson | undefined> {
  const file = path.join(dir, 'package.json');
  try {
    return await readJsonIfExists<PackageJson>(file);
  } catch (err) {
    throw new Error(`package.json is not valid JSON: ${(err as Error).message}`);
  }
}

export type PyProject = Record<string, any>;

export async function readPyProject(dir: string): Promise<PyProject | undefined> {
  const text = await readTextIfExists(path.join(dir, 'pyproject.toml'));
  if (text === undefined) return undefined;
  try {
    return parseToml(text) as PyProject;
  } catch (err) {
    throw new Error(`pyproject.toml is not valid TOML: ${(err as Error).message}`);
  }
}

export async function readToml(file: string): Promise<Record<string, any> | undefined> {
  const text = await readTextIfExists(file);
  if (text === undefined) return undefined;
  try {
    return parseToml(text) as Record<string, any>;
  } catch {
    return undefined;
  }
}

export type NodePackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

/** Detect the Node package manager from lockfiles (checking the package dir, then the repo root). */
export async function detectNodePackageManager(
  pkgDir: string,
  repoRoot: string,
  pkgJson?: PackageJson,
): Promise<{ pm: NodePackageManager; source: string } | undefined> {
  const pmField = pkgJson?.packageManager?.split('@')[0];
  if (pmField && ['pnpm', 'npm', 'yarn', 'bun'].includes(pmField)) {
    return { pm: pmField as NodePackageManager, source: 'package.json#packageManager' };
  }
  const candidates: Array<[string, NodePackageManager]> = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
  ];
  for (const dir of [pkgDir, repoRoot]) {
    for (const [file, pm] of candidates) {
      if (await exists(path.join(dir, file))) return { pm, source: file };
    }
  }
  return undefined;
}

export function runScriptCommand(pm: NodePackageManager | undefined, script: string): string {
  switch (pm) {
    case 'pnpm':
      return `pnpm ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
    case 'npm':
    default:
      return `npm run ${script}`;
  }
}

export function installCommand(pm: NodePackageManager | undefined): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm install';
    case 'yarn':
      return 'yarn install';
    case 'bun':
      return 'bun install';
    case 'npm':
    default:
      return 'npm install';
  }
}

export type PythonTool = 'poetry' | 'uv' | 'pdm' | 'hatch' | 'pip';

export async function detectPythonTool(
  dir: string,
  py?: PyProject,
): Promise<{ tool: PythonTool; source: string } | undefined> {
  if (!py && !(await exists(path.join(dir, 'requirements.txt')))) return undefined;
  if (py?.tool?.poetry) return { tool: 'poetry', source: 'pyproject.toml [tool.poetry]' };
  if (await exists(path.join(dir, 'uv.lock'))) return { tool: 'uv', source: 'uv.lock' };
  if (py?.tool?.uv) return { tool: 'uv', source: 'pyproject.toml [tool.uv]' };
  if ((await exists(path.join(dir, 'pdm.lock'))) || py?.tool?.pdm)
    return { tool: 'pdm', source: 'pdm.lock' };
  if (py?.tool?.hatch) return { tool: 'hatch', source: 'pyproject.toml [tool.hatch]' };
  return { tool: 'pip', source: py ? 'pyproject.toml' : 'requirements.txt' };
}

/** Parse a PEP 508 requirement string into name + version spec (best effort, deterministic). */
export function parseRequirement(
  req: string,
): { name: string; spec: string; extras?: string } | undefined {
  const cleaned = req.split('#')[0]!.trim();
  if (!cleaned || cleaned.startsWith('-')) return undefined;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([^;]*)/.exec(cleaned);
  if (!m) return undefined;
  const spec = (m[3] ?? '').trim().replace(/\s+/g, '');
  return { name: m[1]!.toLowerCase().replace(/_/g, '-'), spec: spec || '*', extras: m[2] };
}

/** Normalise a dependency map into a sorted array of {name, declared}. */
export function depList(
  map: Record<string, string> | undefined,
): Array<{ name: string; declared: string }> {
  if (!map) return [];
  return Object.keys(map)
    .sort()
    .map((name) => ({ name, declared: String(map[name]) }));
}

export interface DockerfileInfo {
  file: string;
  from: string[];
  entrypoint?: string;
  cmd?: string;
  expose: string[];
}

export function parseDockerfile(file: string, text: string): DockerfileInfo {
  const info: DockerfileInfo = { file, from: [], expose: [] };
  const lines = text
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  for (const line of lines) {
    const m = /^([A-Za-z]+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const instr = m[1]!.toUpperCase();
    const arg = m[2]!.trim();
    switch (instr) {
      case 'FROM':
        info.from.push(arg.split(/\s+/)[0]!);
        break;
      case 'ENTRYPOINT':
        info.entrypoint = normaliseExec(arg);
        break;
      case 'CMD':
        info.cmd = normaliseExec(arg);
        break;
      case 'EXPOSE':
        info.expose.push(...arg.split(/\s+/));
        break;
      default:
        break;
    }
  }
  info.expose = [...new Set(info.expose)].sort();
  return info;
}

function normaliseExec(arg: string): string {
  if (arg.startsWith('[')) {
    try {
      const parts = JSON.parse(arg) as string[];
      return parts.join(' ');
    } catch {
      return arg;
    }
  }
  return arg;
}

export interface MakeTarget {
  target: string;
  description?: string;
}

/** Targets from a Makefile. `## text` after the rule is used as the description. */
export function parseMakefile(text: string): MakeTarget[] {
  const out: MakeTarget[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith('\t') || raw.startsWith('#')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9_./-]*)\s*:(?!=)[^#]*(?:##\s*(.*))?$/.exec(raw);
    if (!m) continue;
    const target = m[1]!;
    if (target.startsWith('.') || target.includes('%') || target.includes('$') || seen.has(target))
      continue;
    seen.add(target);
    out.push({ target, description: m[2]?.trim() || undefined });
  }
  // Prefer the documented subset (`target: ## text`); fall back to every target when nothing is documented.
  const documented = out.filter((t) => t.description);
  return (documented.length ? documented : out).sort((a, b) => a.target.localeCompare(b.target));
}

export interface JustRecipe {
  recipe: string;
  params?: string;
  description?: string;
}

export function parseJustfile(text: string): JustRecipe[] {
  const out: JustRecipe[] = [];
  let pendingDoc: string | undefined;
  let privateNext = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s/.test(raw)) continue;
    if (raw.startsWith('#')) {
      pendingDoc = raw.replace(/^#+\s?/, '').trim();
      continue;
    }
    if (raw.startsWith('[')) {
      if (/\[private\]/.test(raw)) privateNext = true;
      continue;
    }
    const m = /^(@)?([A-Za-z_][A-Za-z0-9_-]*)((?:\s+[^:=\s]+)*)\s*:(?!=)/.exec(raw);
    if (m && !/^(set|alias|export|import|mod)\b/.test(raw)) {
      if (!privateNext && !m[2]!.startsWith('_')) {
        out.push({ recipe: m[2]!, params: m[3]?.trim() || undefined, description: pendingDoc });
      }
    }
    pendingDoc = undefined;
    privateNext = false;
  }
  return out.sort((a, b) => a.recipe.localeCompare(b.recipe));
}

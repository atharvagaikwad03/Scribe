import path from 'node:path';
import YAML from 'yaml';
import type { ExtractContext, ExtractResult, SectionGenerator } from '../types.js';
import { ok } from '../types.js';
import {
  depList,
  parseRequirement,
  readPackageJson,
  readPyProject,
  readToml,
} from '../manifest.js';
import { readTextIfExists, readJsonIfExists, exists } from '../../util/fs.js';
import { table } from '../render.js';

export interface Dep {
  name: string;
  declared: string;
  resolved?: string;
}

export interface DependenciesData {
  name?: string;
  version?: string;
  engines: Record<string, string>;
  requiresPython?: string;
  node?: {
    lockfile?: string;
    runtime: Dep[];
    dev: Dep[];
    peer: Dep[];
    optional: Dep[];
  };
  python?: {
    lockfile?: string;
    runtime: Dep[];
    dev: Dep[];
    optional: Record<string, Dep[]>;
  };
}

export const dependenciesGenerator: SectionGenerator<DependenciesData> = {
  id: 'dependencies',
  defaultWatch: [
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    'pyproject.toml',
    'poetry.lock',
    'pdm.lock',
    'uv.lock',
    'Pipfile',
    'Pipfile.lock',
    'requirements*.txt',
    'requirements/*.txt',
    'setup.py',
    'setup.cfg',
  ],

  async extract(ctx: ExtractContext): Promise<ExtractResult<DependenciesData>> {
    const dir = ctx.pkg.absPath;
    const diagnostics: string[] = [];
    const data: DependenciesData = { engines: {} };

    const pkgJson = await readPackageJson(dir);
    if (pkgJson) {
      data.name = pkgJson.name;
      data.version = pkgJson.version;
      data.engines = { ...(pkgJson.engines ?? {}) };
      const resolver = await loadNodeLockfile(dir, ctx.repoRoot, ctx.pkg.path);
      const withResolved = (deps: Dep[]) =>
        deps.map((d) => {
          const r = resolver?.resolve(d.name);
          return r ? { ...d, resolved: r } : d;
        });
      data.node = {
        lockfile: resolver?.file,
        runtime: withResolved(depList(pkgJson.dependencies)),
        dev: withResolved(depList(pkgJson.devDependencies)),
        peer: depList(pkgJson.peerDependencies),
        optional: withResolved(depList(pkgJson.optionalDependencies)),
      };
      if (!resolver) diagnostics.push('No Node lockfile found; showing declared versions only.');
    }

    const py = await readPyProject(dir);
    const hasReq = await exists(path.join(dir, 'requirements.txt'));
    if (py || hasReq) {
      const project = py?.project ?? {};
      data.name ??= project.name ?? py?.tool?.poetry?.name;
      data.version ??= project.version ?? py?.tool?.poetry?.version;
      data.requiresPython = project['requires-python'] ?? py?.tool?.poetry?.dependencies?.python;
      const resolver = await loadPythonLockfile(dir);
      const withResolved = (deps: Dep[]) =>
        deps.map((d) => {
          const r = resolver?.resolve(d.name);
          return r ? { ...d, resolved: r } : d;
        });
      const runtime: Dep[] = [];
      const dev: Dep[] = [];
      const optional: Record<string, Dep[]> = {};

      for (const req of (project.dependencies as string[] | undefined) ?? []) {
        const p = parseRequirement(req);
        if (p) runtime.push({ name: p.name, declared: p.spec });
      }
      const optDeps =
        (project['optional-dependencies'] as Record<string, string[]> | undefined) ?? {};
      for (const group of Object.keys(optDeps).sort()) {
        optional[group] = (optDeps[group] ?? [])
          .map(parseRequirement)
          .filter((p): p is NonNullable<typeof p> => !!p)
          .map((p) => ({ name: p.name, declared: p.spec }));
      }
      // PEP 735 dependency groups (uv/pdm "dev" groups)
      const groups = (py?.['dependency-groups'] as Record<string, unknown[]> | undefined) ?? {};
      for (const group of Object.keys(groups).sort()) {
        const list = (groups[group] ?? [])
          .filter((x): x is string => typeof x === 'string')
          .map(parseRequirement);
        const deps = list
          .filter((p): p is NonNullable<typeof p> => !!p)
          .map((p) => ({ name: p.name, declared: p.spec }));
        if (group === 'dev') dev.push(...deps);
        else optional[group] = deps;
      }
      const poetry = py?.tool?.poetry;
      if (poetry) {
        for (const [name, spec] of Object.entries(poetry.dependencies ?? {})) {
          if (name === 'python') continue;
          runtime.push({ name: name.toLowerCase(), declared: poetrySpec(spec) });
        }
        for (const [name, spec] of Object.entries(poetry['dev-dependencies'] ?? {})) {
          dev.push({ name: name.toLowerCase(), declared: poetrySpec(spec) });
        }
        for (const [group, g] of Object.entries((poetry.group ?? {}) as Record<string, any>)) {
          const deps = Object.entries(g?.dependencies ?? {}).map(([name, spec]) => ({
            name: name.toLowerCase(),
            declared: poetrySpec(spec),
          }));
          if (group === 'dev') dev.push(...deps);
          else optional[group] = deps;
        }
      }
      if (!py && hasReq) {
        const text = (await readTextIfExists(path.join(dir, 'requirements.txt'))) ?? '';
        for (const line of text.split(/\r?\n/)) {
          const p = parseRequirement(line);
          if (p) runtime.push({ name: p.name, declared: p.spec });
        }
      }
      const sortDeps = (d: Dep[]) => d.sort((a, b) => a.name.localeCompare(b.name));
      data.python = {
        lockfile: resolver?.file,
        runtime: withResolved(sortDeps(runtime)),
        dev: withResolved(sortDeps(dev)),
        optional: Object.fromEntries(
          Object.entries(optional).map(([k, v]) => [k, withResolved(sortDeps(v))]),
        ),
      };
    }

    if (!pkgJson && !py && !hasReq)
      diagnostics.push('No package.json, pyproject.toml or requirements.txt found.');
    return ok(data, diagnostics);
  },

  render(data: DependenciesData): string {
    const parts: string[] = [];
    const meta: string[][] = [];
    if (data.name) meta.push(['Package', `\`${data.name}\``]);
    if (data.version) meta.push(['Version', `\`${data.version}\``]);
    for (const [k, v] of Object.entries(data.engines).sort())
      meta.push([`Engine: ${k}`, `\`${v}\``]);
    if (data.requiresPython) meta.push(['Python', `\`${data.requiresPython}\``]);
    if (meta.length) parts.push(table(['', ''], meta));

    const depTable = (title: string, deps: Dep[], lock?: string) => {
      if (!deps.length) return;
      const hasResolved = deps.some((d) => d.resolved);
      const headers = hasResolved
        ? ['Package', 'Declared', `Resolved (${lock ?? 'lockfile'})`]
        : ['Package', 'Declared'];
      parts.push(`**${title}**\n`);
      parts.push(
        table(
          headers,
          deps.map((d) =>
            hasResolved
              ? [`\`${d.name}\``, `\`${d.declared}\``, d.resolved ? `\`${d.resolved}\`` : '']
              : [`\`${d.name}\``, `\`${d.declared}\``],
          ),
        ),
      );
    };

    if (data.node) {
      depTable('Runtime dependencies', data.node.runtime, data.node.lockfile);
      depTable('Peer dependencies', data.node.peer);
      depTable('Optional dependencies', data.node.optional, data.node.lockfile);
      depTable('Dev dependencies', data.node.dev, data.node.lockfile);
    }
    if (data.python) {
      depTable('Python dependencies', data.python.runtime, data.python.lockfile);
      for (const [group, deps] of Object.entries(data.python.optional).sort())
        depTable(`Optional group: ${group}`, deps, data.python.lockfile);
      depTable('Python dev dependencies', data.python.dev, data.python.lockfile);
    }
    if (!parts.length) return '_No dependency manifest was found._';
    return parts.join('\n');
  },
};

function poetrySpec(spec: unknown): string {
  if (typeof spec === 'string') return spec;
  if (spec && typeof spec === 'object') {
    const s = spec as Record<string, unknown>;
    if (typeof s.version === 'string') return s.version;
    if (typeof s.git === 'string') return `git+${s.git}`;
    if (typeof s.path === 'string') return `path:${s.path}`;
  }
  return '*';
}

interface Resolver {
  file: string;
  resolve(name: string): string | undefined;
}

async function loadNodeLockfile(
  pkgDir: string,
  repoRoot: string,
  pkgRel: string,
): Promise<Resolver | undefined> {
  for (const dir of [pkgDir, repoRoot]) {
    const importer = dir === repoRoot && pkgRel !== '.' ? pkgRel : '.';
    const pnpm = await readTextIfExists(path.join(dir, 'pnpm-lock.yaml'));
    if (pnpm !== undefined) {
      let doc: any;
      try {
        doc = YAML.parse(pnpm);
      } catch {
        return undefined;
      }
      const imp = doc?.importers?.[importer] ?? (importer === '.' ? doc : undefined);
      const lookup = (name: string) => {
        for (const bucket of ['dependencies', 'devDependencies', 'optionalDependencies']) {
          const entry = imp?.[bucket]?.[name];
          if (!entry) continue;
          const v = typeof entry === 'string' ? entry : entry.version;
          if (typeof v === 'string') return v.replace(/\(.*$/, '').replace(/^link:.*/, 'link');
        }
        return undefined;
      };
      return { file: 'pnpm-lock.yaml', resolve: lookup };
    }
    const npm = await readJsonIfExists<any>(path.join(dir, 'package-lock.json')).catch(
      () => undefined,
    );
    if (npm) {
      const prefix = importer === '.' ? '' : importer + '/';
      return {
        file: 'package-lock.json',
        resolve: (name) =>
          npm.packages?.[`${prefix}node_modules/${name}`]?.version ??
          npm.packages?.[`node_modules/${name}`]?.version ??
          npm.dependencies?.[name]?.version,
      };
    }
    const yarn = await readTextIfExists(path.join(dir, 'yarn.lock'));
    if (yarn !== undefined) {
      const map = parseYarnLock(yarn);
      return { file: 'yarn.lock', resolve: (name) => map.get(name) };
    }
    const bun = await readTextIfExists(path.join(dir, 'bun.lock'));
    if (bun !== undefined) {
      const map = parseBunLock(bun);
      return { file: 'bun.lock', resolve: (name) => map.get(name) };
    }
  }
  return undefined;
}

/** Handles both yarn v1 and berry formats well enough to map name -> version. */
export function parseYarnLock(text: string): Map<string, string> {
  const map = new Map<string, string>();
  let currentNames: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!raw.startsWith(' ')) {
      const key = raw.replace(/:\s*$/, '');
      currentNames = key
        .split(',')
        .map((k) => k.trim().replace(/^"|"$/g, ''))
        .map((k) => {
          const at = k.startsWith('@') ? k.indexOf('@', 1) : k.indexOf('@');
          return at > 0 ? k.slice(0, at) : k;
        });
      continue;
    }
    const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(raw);
    if (m) for (const n of currentNames) if (!map.has(n)) map.set(n, m[1]!);
  }
  return map;
}

export function parseBunLock(text: string): Map<string, string> {
  const map = new Map<string, string>();
  // bun.lock is JSONC; strip comments and trailing commas leniently.
  try {
    const cleaned = text.replace(/\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1');
    const doc = JSON.parse(cleaned) as { packages?: Record<string, unknown[]> };
    for (const [name, entry] of Object.entries(doc.packages ?? {})) {
      const spec = entry?.[0];
      if (typeof spec === 'string') {
        const at = spec.lastIndexOf('@');
        if (at > 0) map.set(name, spec.slice(at + 1));
      }
    }
  } catch {
    /* ignore */
  }
  return map;
}

async function loadPythonLockfile(dir: string): Promise<Resolver | undefined> {
  for (const file of ['poetry.lock', 'uv.lock', 'pdm.lock']) {
    const doc = await readToml(path.join(dir, file));
    if (!doc) continue;
    const map = new Map<string, string>();
    for (const p of (doc.package as Array<{ name?: string; version?: string }> | undefined) ?? []) {
      if (p.name && p.version) map.set(p.name.toLowerCase().replace(/_/g, '-'), p.version);
    }
    return { file, resolve: (name) => map.get(name.toLowerCase().replace(/_/g, '-')) };
  }
  return undefined;
}

import path from 'node:path';
import type { ExtractContext, ExtractResult, SectionGenerator } from '../types.js';
import { ok } from '../types.js';
import {
  detectNodePackageManager,
  detectPythonTool,
  installCommand,
  parseDockerfile,
  parseJustfile,
  parseMakefile,
  readPackageJson,
  readPyProject,
  runScriptCommand,
  type DockerfileInfo,
  type JustRecipe,
  type MakeTarget,
} from '../manifest.js';
import { readTextIfExists } from '../../util/fs.js';
import { code, table } from '../render.js';

export interface CommandEntry {
  name: string;
  command: string;
  description?: string;
  source: string;
}

export interface CommandsData {
  install: CommandEntry[];
  scripts: CommandEntry[];
  make: MakeTarget[];
  just: JustRecipe[];
  docker: DockerfileInfo[];
  pythonScripts: Array<{ name: string; target: string; source: string }>;
}

export const commandsGenerator: SectionGenerator<CommandsData> = {
  id: 'commands',
  defaultWatch: [
    'package.json',
    'Makefile',
    'makefile',
    'GNUmakefile',
    'Dockerfile',
    'Dockerfile.*',
    '*.Dockerfile',
    'docker/Dockerfile*',
    'pyproject.toml',
    'setup.py',
    'setup.cfg',
    'requirements*.txt',
    'justfile',
    'Justfile',
    '.justfile',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
  ],

  async extract(ctx: ExtractContext): Promise<ExtractResult<CommandsData>> {
    const dir = ctx.pkg.absPath;
    const diagnostics: string[] = [];
    const data: CommandsData = {
      install: [],
      scripts: [],
      make: [],
      just: [],
      docker: [],
      pythonScripts: [],
    };

    const pkgJson = await readPackageJson(dir);
    if (pkgJson) {
      const pm = await detectNodePackageManager(dir, ctx.repoRoot, pkgJson);
      data.install.push({
        name: 'install',
        command: installCommand(pm?.pm),
        source: pm
          ? `package.json + ${pm.source}`
          : 'package.json (no lockfile found; npm assumed)',
      });
      if (!pm)
        diagnostics.push('No lockfile or packageManager field found; install command assumes npm.');
      for (const name of Object.keys(pkgJson.scripts ?? {}).sort()) {
        const cmd = pkgJson.scripts![name]!;
        if (
          /^(pre|post)[a-z]/.test(name) &&
          Object.hasOwn(pkgJson.scripts!, name.replace(/^(pre|post)/, ''))
        ) {
          continue; // lifecycle hooks are implied by their main script
        }
        data.scripts.push({
          name,
          command: runScriptCommand(pm?.pm, name),
          description: cmd,
          source: 'package.json#scripts',
        });
      }
    }

    const py = await readPyProject(dir);
    const pyTool = await detectPythonTool(dir, py);
    if (pyTool) {
      const install: Record<string, string> = {
        poetry: 'poetry install',
        uv: 'uv sync',
        pdm: 'pdm install',
        hatch: 'hatch env create',
        pip: py ? 'pip install -e .' : 'pip install -r requirements.txt',
      };
      data.install.push({
        name: 'install (python)',
        command: install[pyTool.tool]!,
        source: pyTool.source,
      });
      const scripts: Record<string, string> = {
        ...(py?.project?.scripts ?? {}),
        ...(py?.tool?.poetry?.scripts ?? {}),
      };
      for (const name of Object.keys(scripts).sort()) {
        data.pythonScripts.push({
          name,
          target: String(scripts[name]),
          source: py?.project?.scripts?.[name]
            ? 'pyproject.toml [project.scripts]'
            : 'pyproject.toml [tool.poetry.scripts]',
        });
      }
      const pdmScripts = py?.tool?.pdm?.scripts as Record<string, unknown> | undefined;
      if (pdmScripts) {
        for (const name of Object.keys(pdmScripts).sort()) {
          const v = pdmScripts[name];
          const target =
            typeof v === 'string'
              ? v
              : typeof v === 'object' && v
                ? String((v as any).cmd ?? (v as any).shell ?? (v as any).call ?? '')
                : '';
          if (name !== '_' && target)
            data.scripts.push({
              name,
              command: `pdm run ${name}`,
              description: target,
              source: 'pyproject.toml [tool.pdm.scripts]',
            });
        }
      }
    }

    for (const mf of ['Makefile', 'makefile', 'GNUmakefile']) {
      const text = await readTextIfExists(path.join(dir, mf));
      if (text !== undefined) {
        data.make = parseMakefile(text);
        break;
      }
    }

    for (const jf of ['justfile', 'Justfile', '.justfile']) {
      const text = await readTextIfExists(path.join(dir, jf));
      if (text !== undefined) {
        data.just = parseJustfile(text);
        break;
      }
    }

    const files = await ctx.listFiles();
    const dockerfiles = files
      .filter((f) => {
        const base = path.posix.basename(f);
        return (
          (base === 'Dockerfile' ||
            base.startsWith('Dockerfile.') ||
            base.endsWith('.Dockerfile')) &&
          f.split('/').length <= 3
        );
      })
      .sort();
    for (const f of dockerfiles) {
      const text = await readTextIfExists(path.join(dir, f));
      if (text !== undefined) data.docker.push(parseDockerfile(f, text));
    }

    return ok(data, diagnostics);
  },

  render(data: CommandsData): string {
    const parts: string[] = [];
    if (data.install.length) {
      parts.push('**Install**\n');
      parts.push(code(data.install.map((i) => i.command).join('\n'), 'sh'));
    }
    if (data.scripts.length) {
      parts.push('**Scripts**\n');
      parts.push(
        table(
          ['Command', 'Runs'],
          data.scripts.map((s) => [`\`${s.command}\``, `\`${escapePipes(s.description ?? '')}\``]),
        ),
      );
    }
    if (data.pythonScripts.length) {
      parts.push('**Console scripts** (from `pyproject.toml`)\n');
      parts.push(
        table(
          ['Command', 'Entry point'],
          data.pythonScripts.map((s) => [`\`${s.name}\``, `\`${s.target}\``]),
        ),
      );
    }
    if (data.make.length) {
      parts.push('**Make targets**\n');
      parts.push(
        table(
          ['Target', 'Description'],
          data.make.map((m) => [`\`make ${m.target}\``, m.description ?? '']),
        ),
      );
    }
    if (data.just.length) {
      parts.push('**Just recipes**\n');
      parts.push(
        table(
          ['Recipe', 'Description'],
          data.just.map((j) => [
            `\`just ${j.recipe}${j.params ? ' ' + j.params : ''}\``,
            j.description ?? '',
          ]),
        ),
      );
    }
    for (const d of data.docker) {
      parts.push(`**Docker** (\`${d.file}\`)\n`);
      const rows: string[][] = [];
      rows.push(['Build', `\`docker build -f ${d.file} .\``]);
      if (d.from.length) rows.push(['Base image', d.from.map((f) => `\`${f}\``).join(', ')]);
      if (d.entrypoint) rows.push(['Entrypoint', `\`${d.entrypoint}\``]);
      if (d.cmd) rows.push(['Command', `\`${d.cmd}\``]);
      if (d.expose.length) rows.push(['Exposes', d.expose.map((p) => `\`${p}\``).join(', ')]);
      parts.push(table(['', ''], rows));
    }
    if (!parts.length)
      return '_No install, run or build commands were found in project configuration._';
    return parts.join('\n');
  },
};

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|');
}

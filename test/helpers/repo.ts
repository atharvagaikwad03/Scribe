import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Git } from '../../src/git/index.js';

export interface TempRepo {
  root: string;
  git: Git;
  write(files: Record<string, string>): Promise<void>;
  remove(paths: string[]): Promise<void>;
  read(file: string): Promise<string>;
  exists(file: string): Promise<boolean>;
  commit(message: string, opts?: { author?: string; email?: string }): Promise<string>;
  cleanup(): Promise<void>;
}

/** Create a throwaway git repository under the OS temp dir with an initial commit of `files`. */
export async function createTempRepo(
  files: Record<string, string> = {},
  opts: { initialCommit?: boolean } = {},
): Promise<TempRepo> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'readme-sync-')));
  const git = new Git(root);
  await git.git(['init', '-q', '-b', 'main']);
  await git.setUser('Test User', 'test@example.com');
  await git.git(['config', 'commit.gpgsign', 'false']);

  const repo: TempRepo = {
    root,
    git,
    async write(f) {
      for (const [rel, content] of Object.entries(f)) {
        const abs = path.join(root, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, 'utf8');
      }
    },
    async remove(paths) {
      for (const p of paths) await fs.rm(path.join(root, p), { recursive: true, force: true });
    },
    read: (file) => fs.readFile(path.join(root, file), 'utf8'),
    exists: (file) =>
      fs
        .access(path.join(root, file))
        .then(() => true)
        .catch(() => false),
    async commit(message, o = {}) {
      await git.git(['add', '-A']);
      return git.commit(message, { authorName: o.author, authorEmail: o.email });
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
  await repo.write(files);
  if (opts.initialCommit !== false) await repo.commit('chore: initial commit');
  return repo;
}

/** A README with markers for the given sections and some human prose around them. */
export function readmeWith(
  sections: string[],
  opts: { intro?: string; outro?: string } = {},
): string {
  const intro =
    opts.intro ??
    '# Fixture\n\nHand-written intro. **Do not touch.**\n\n![badge](https://example.com/b.svg)\n';
  const body = sections
    .map(
      (id) =>
        `## ${id[0]!.toUpperCase() + id.slice(1)}\n\n<!-- autogen:start:${id} -->\n<!-- autogen:end:${id} -->\n`,
    )
    .join('\n');
  const outro =
    opts.outro ??
    '\n## Why this project exists\n\nBecause. Human-owned prose with `code` and a [link](x).\n';
  return `${intro}\n${body}${outro}`;
}

export const TS_PACKAGE_FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'fixture-ts',
      version: '1.2.3',
      type: 'module',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
      bin: { fixture: './dist/cli.js' },
      scripts: { build: 'tsc -p .', test: 'vitest run', lint: 'eslint .' },
      dependencies: { zod: '^3.23.0', yaml: '^2.4.0' },
      devDependencies: { typescript: '^5.4.0', vitest: '^1.6.0' },
      engines: { node: '>=20' },
    },
    null,
    2,
  ),
  'pnpm-lock.yaml': `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      yaml:
        specifier: ^2.4.0
        version: 2.4.5
      zod:
        specifier: ^3.23.0
        version: 3.23.8
    devDependencies:
      typescript:
        specifier: ^5.4.0
        version: 5.4.5
      vitest:
        specifier: ^1.6.0
        version: 1.6.0
`,
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      declaration: true,
      outDir: 'dist',
    },
    include: ['src'],
  }),
  'src/index.ts': `export { greet } from './greet.js';\nexport interface Options {\n  loud?: boolean;\n}\nexport class Greeter {\n  constructor(private readonly name: string) {}\n  hello(opts: Options = {}): string { return opts.loud ? this.name.toUpperCase() : this.name; }\n}\nexport const VERSION = '1.2.3';\nexport type Mode = 'a' | 'b';\n`,
  'src/greet.ts': `export function greet(name: string, punctuation = '!'): string {\n  return \`Hello, \${name}\${punctuation}\`;\n}\nfunction internal(): void {}\nexport { internal as _internal };\n`,
  'src/cli.ts': `import { Command } from 'commander';\nconst program = new Command();\nprogram.command('greet <name>').description('Say hello');\nprogram.command('version');\nprogram.parse();\n`,
  Makefile: `.PHONY: build test\nbuild: ## Build the project\n\tpnpm build\ntest: ## Run tests\n\tpnpm test\ninternal-target:\n\techo hi\n`,
  Dockerfile: `FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n`,
  'README.md': readmeWith(['structure', 'api', 'commands', 'dependencies', 'changelog']),
  '.readme-sync.yml': 'version: 1\n',
};

export const PY_PACKAGE_FILES: Record<string, string> = {
  'pyproject.toml': `[project]
name = "fixture-py"
version = "0.4.0"
requires-python = ">=3.9"
dependencies = ["fastapi>=0.110", "click~=8.1", "pydantic"]

[project.optional-dependencies]
dev = ["pytest>=8", "ruff"]

[project.scripts]
fixture = "fixture_py.cli:main"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
`,
  'src/fixture_py/__init__.py': `"""Fixture package."""\nfrom .core import add, Widget\n\n__all__ = ["add", "Widget", "VERSION"]\nVERSION = "0.4.0"\n`,
  'src/fixture_py/core.py': `from dataclasses import dataclass\n\n\ndef add(a: int, b: int = 0) -> int:\n    return a + b\n\n\ndef _private() -> None:\n    pass\n\n\n@dataclass\nclass Widget:\n    name: str\n\n    def render(self, indent: int = 0) -> str:\n        return " " * indent + self.name\n`,
  'src/fixture_py/cli.py': `import click\n\n\n@click.group()\ndef main():\n    pass\n\n\n@main.command()\n@click.argument("name")\ndef greet(name):\n    click.echo(name)\n\n\n@main.command("list-things")\ndef list_things():\n    pass\n`,
  'src/fixture_py/api.py': `from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/items")\ndef list_items():\n    return []\n\n\n@app.post("/items/{item_id}")\ndef create_item(item_id: int):\n    return item_id\n`,
  'README.md': readmeWith(['structure', 'api', 'commands', 'dependencies', 'changelog']),
  '.readme-sync.yml': 'version: 1\n',
};

import type { ExtractContext, ExtractResult, SectionGenerator } from '../types.js';
import { ok } from '../types.js';
import { readPackageJson, readPyProject } from '../manifest.js';
import { exists } from '../../util/fs.js';
import { table } from '../render.js';

export interface PackageRow {
  path: string;
  name: string;
  version?: string;
  description?: string;
  readme?: string;
  private: boolean;
}

export interface PackagesData {
  packages: PackageRow[];
}

/** Root-README table of workspace packages (monorepos). */
export const packagesGenerator: SectionGenerator<PackagesData> = {
  id: 'packages',
  defaultWatch: ['**/package.json', '**/pyproject.toml', 'pnpm-workspace.yaml', 'package.json'],

  async extract(ctx: ExtractContext): Promise<ExtractResult<PackagesData>> {
    const rows: PackageRow[] = [];
    const diagnostics: string[] = [];
    for (const pkg of ctx.allPackages) {
      if (pkg.path === '.') continue;
      let name = pkg.path.split('/').pop()!;
      let version: string | undefined;
      let description: string | undefined;
      let isPrivate = false;
      const pj = await readPackageJson(pkg.absPath).catch((e: Error) => {
        diagnostics.push(`${pkg.path}: ${e.message}`);
        return undefined;
      });
      if (pj) {
        name = pj.name ?? name;
        version = pj.version;
        description = pj.description;
        isPrivate = !!pj.private;
      } else {
        const py = await readPyProject(pkg.absPath).catch(() => undefined);
        if (py?.project) {
          name = py.project.name ?? name;
          version = py.project.version;
          description = py.project.description;
        }
      }
      rows.push({
        path: pkg.path,
        name,
        version,
        description,
        readme: (await exists(pkg.absReadme)) ? pkg.readme : undefined,
        private: isPrivate,
      });
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));
    if (!rows.length) diagnostics.push('No workspace packages found.');
    return ok({ packages: rows }, diagnostics);
  },

  render(data: PackagesData): string {
    if (!data.packages.length) return '_No workspace packages._';
    return table(
      ['Package', 'Path', 'Version', 'Description'],
      data.packages.map((p) => [
        p.readme ? `[\`${p.name}\`](${p.readme})` : `\`${p.name}\``,
        `\`${p.path}\``,
        p.version ? `\`${p.version}\`` : p.private ? '_private_' : '',
        (p.description ?? '').replace(/\|/g, '\\|'),
      ]),
    );
  },
};

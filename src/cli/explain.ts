import { createTwoFilesPatch } from 'diff';
import type { SectionId } from '../config/schema.js';
import { plan, type RunOptions } from '../engine/index.js';
import { mapChangedFiles, watchGlobsFor } from '../engine/mapping.js';
import { generatorFor } from '../extractors/registry.js';
import { log } from '../util/log.js';
import { ReadmeSyncError } from '../util/errors.js';

export async function explain(section: SectionId, opts: RunOptions): Promise<void> {
  const gen = generatorFor(section);
  const run = await plan({ ...opts, sections: undefined, forceExtract: true });
  const pkgPlan = opts.packages?.length
    ? run.packages.find((p) => opts.packages!.includes(p.pkg.path))
    : run.packages[0];
  if (!pkgPlan) throw new ReadmeSyncError('CONFIG', 'package not found');
  const sp = pkgPlan.sections.find((s) => s.id === section);
  if (!sp) throw new ReadmeSyncError('CONFIG', `unknown section ${section}`);

  log.out(`section: ${section}   package: ${pkgPlan.pkg.path}   status: ${sp.status}`);
  log.out(`reason: ${sp.reason}`);
  log.out(
    `base: ${pkgPlan.fullMode ? `full (${pkgPlan.fullModeReason})` : `${pkgPlan.baseSha!.slice(0, 7)}..${pkgPlan.headSha.slice(0, 7)}`}`,
  );
  log.out(`\nwatch globs:`);
  for (const g of watchGlobsFor(gen, pkgPlan.pkg)) log.out(`  ${g}`);
  const claimed = mapChangedFiles(
    pkgPlan.files.map((f) => f.file),
    pkgPlan.pkg,
    [gen],
    opts.config.ignore,
  ).filter((m) => m.outcome.kind === 'claimed');
  log.out(`\nchanged files matching this section (${claimed.length}):`);
  for (const m of claimed) log.out(`  ${m.file.status} ${m.file.path}`);
  if (sp.diagnostics.length) {
    log.out('\ndiagnostics:');
    for (const d of sp.diagnostics) log.out(`  - ${d}`);
  }
  if (sp.confidence !== undefined) log.out(`\nconfidence: ${sp.confidence}`);
  if (sp.data !== undefined) {
    log.out('\nextractor output:');
    log.out(JSON.stringify(sp.data, null, 2));
  } else {
    log.out('\nextractor was not run for this section (see reason above).');
  }
  if (sp.newBody !== undefined && sp.oldBody !== undefined) {
    log.out('\nbody diff:');
    if (sp.newBody === sp.oldBody) log.out('  (identical)');
    else
      log.out(
        createTwoFilesPatch(
          `current:${section}`,
          `rendered:${section}`,
          sp.oldBody + '\n',
          sp.newBody + '\n',
          '',
          '',
          { context: 3 },
        ),
      );
  }
}

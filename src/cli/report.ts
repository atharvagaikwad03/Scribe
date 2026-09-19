import { createTwoFilesPatch } from 'diff';
import type { RunPlan, PackagePlan } from '../engine/index.js';
import { formatFlag } from '../flags/index.js';
import { log } from '../util/log.js';

export function readmeDiff(p: PackagePlan): string {
  if (!p.readmeChanged || p.readmeBefore === undefined || p.readmeAfter === undefined) return '';
  return createTwoFilesPatch(
    `a/${p.pkg.readme}`,
    `b/${p.pkg.readme}`,
    p.readmeBefore,
    p.readmeAfter,
    '',
    '',
    { context: 3 },
  );
}

export function printPlan(run: RunPlan, opts: { diff?: boolean; verbose?: boolean } = {}): void {
  for (const p of run.packages) {
    const title = p.pkg.path === '.' ? p.pkg.readme : `${p.pkg.path} (${p.pkg.readme})`;
    log.out(`\n${title}`);
    if (p.error) {
      log.out(`  ERROR: ${p.error}`);
      continue;
    }
    const range = p.fullMode
      ? `full regeneration: ${p.fullModeReason}`
      : `${p.baseSha!.slice(0, 7)}..${p.headSha.slice(0, 7)}`;
    log.out(`  base: ${range}`);
    const counts = { claimed: 0, ignored: 0, unmapped: 0 };
    for (const f of p.files) counts[f.outcome.kind]++;
    log.out(
      `  changed files: ${p.files.length} (claimed ${counts.claimed}, ignored ${counts.ignored}, unmapped ${counts.unmapped})`,
    );
    if (opts.verbose) {
      for (const f of p.files) {
        const o = f.outcome;
        const desc =
          o.kind === 'claimed'
            ? `-> ${o.sections.join(', ')}`
            : o.kind === 'ignored'
              ? `(ignored: ${o.by})`
              : '(unmapped)';
        log.out(
          `    ${f.file.status} ${f.file.from ? f.file.from + ' -> ' : ''}${f.file.path} ${desc}`,
        );
      }
    }
    for (const s of p.sections) {
      const mark = {
        update: 'UPDATE ',
        unchanged: 'ok     ',
        flagged: 'FLAG   ',
        disabled: 'off    ',
        skipped: 'skip   ',
      }[s.status];
      const conf =
        s.confidence !== undefined && s.confidence < 1
          ? ` (confidence ${s.confidence.toFixed(2)})`
          : '';
      log.out(`  ${mark} ${s.id.padEnd(13)} ${s.reason}${conf}`);
      if (opts.verbose) for (const d of s.diagnostics) log.out(`             note: ${d}`);
    }
    if (opts.diff) {
      const d = readmeDiff(p);
      if (d) log.out('\n' + d);
    }
  }
  if (run.flags.length) {
    log.out('\nStale flags:');
    for (const f of run.flags) log.out(`  - ${formatFlag(f)}`);
  }
  log.out('');
}

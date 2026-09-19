#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { Git } from '../git/index.js';
import { plan, apply, planToJson, type RunOptions } from '../engine/index.js';
import { init, printInitResult } from './init.js';
import { printPlan, readmeDiff } from './report.js';
import { explain } from './explain.js';
import { commentCommand } from './comment.js';
import { createLlmProvider } from '../llm/index.js';
import { log, setQuiet, setVerbose } from '../util/log.js';
import { ReadmeSyncError } from '../util/errors.js';
import { TOOL_VERSION } from '../version.js';
import type { SectionId } from '../config/schema.js';

async function repoRootFrom(cwd: string): Promise<string> {
  const git = new Git(cwd);
  if (!(await git.isRepo()))
    throw new ReadmeSyncError('GIT', `${cwd} is not inside a git repository`);
  return git.toplevel();
}

export async function buildRunOptions(
  cmd: Command,
  extra: Partial<RunOptions> = {},
): Promise<RunOptions> {
  const g = cmd.optsWithGlobals() as Record<string, any>;
  const repoRoot = await repoRootFrom(path.resolve(g.cwd ?? process.cwd()));
  const { config } = await loadConfig(repoRoot, g.config);
  const llm = createLlmProvider(config, g.llm);
  return {
    repoRoot,
    config,
    base: g.base,
    force: !!g.force,
    acceptStale: !!g.acceptStale,
    packages: g.package,
    sections: g.section as SectionId[] | undefined,
    llm,
    ...extra,
  };
}

export function makeProgram(): Command {
  const program = new Command();
  program
    .name('readme-sync')
    .description(
      'Keep README.md in sync with the codebase by surgically patching tool-owned sections.',
    )
    .version(TOOL_VERSION)
    .option('-C, --cwd <dir>', 'run as if started in <dir>')
    .option('-c, --config <file>', 'config file (default: .readme-sync.yml at the repo root)')
    .option('-v, --verbose', 'verbose logging')
    .option('-q, --quiet', 'suppress informational logging')
    .hook('preAction', (thisCmd) => {
      const o = thisCmd.optsWithGlobals() as { verbose?: boolean; quiet?: boolean };
      setVerbose(!!o.verbose);
      setQuiet(!!o.quiet);
    });

  program
    .command('init')
    .description('Create .readme-sync.yml and insert autogen markers at the configured anchors')
    .option(
      '--adopt',
      'convert existing content under an anchor heading into a generated section',
      false,
    )
    .option('--dry-run', 'print the diff without writing anything', false)
    .action(async (opts: { adopt: boolean; dryRun: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { cwd?: string; config?: string };
      const repoRoot = await repoRootFrom(path.resolve(g.cwd ?? process.cwd()));
      const res = await init({
        repoRoot,
        adopt: opts.adopt,
        dryRun: opts.dryRun,
        configPath: g.config,
      });
      printInitResult(res, opts.dryRun);
    });

  const addRunOptions = (c: Command) =>
    c
      .option('--base <sha>', 'diff against this commit instead of the recorded last run')
      .option('--package <path...>', 'only process these package paths')
      .option('--section <id...>', 'only process these sections')
      .option('--force', 'overwrite sections that were manually edited inside their markers', false)
      .option(
        '--accept-stale',
        'advance the recorded commit even when stale flags are raised',
        false,
      )
      .option('--llm <mode>', 'LLM usage: off | anthropic | mock (overrides config)');

  addRunOptions(
    program
      .command('plan')
      .description(
        'Dry run: show which sections would change, which are skipped and which are flagged',
      )
      .option('--json', 'machine-readable output', false)
      .option('--diff', 'include the README diff', false),
  ).action(async (opts: { json: boolean; diff: boolean }, cmd: Command) => {
    const run = await plan(await buildRunOptions(cmd));
    if (opts.json) log.out(JSON.stringify(planToJson(run), null, 2));
    else printPlan(run, { diff: opts.diff, verbose: !!(cmd.optsWithGlobals() as any).verbose });
    if (
      run.flags.length &&
      run.packages[0] &&
      (cmd.optsWithGlobals() as any).config !== undefined
    ) {
      /* flags are informational for plan */
    }
    process.exitCode = run.packages.some((p) => p.error) ? 2 : 0;
  });

  addRunOptions(
    program
      .command('update')
      .description('Regenerate affected sections and write the README(s) and state')
      .option('--check', 'write nothing; exit 1 if the README is out of date', false)
      .option('--json', 'machine-readable output', false)
      .option('--diff', 'print the README diff', false),
  ).action(async (opts: { check: boolean; json: boolean; diff: boolean }, cmd: Command) => {
    const runOpts = await buildRunOptions(cmd);
    const run = await plan(runOpts);
    const fatal = run.packages.some((p) => p.error);
    if (opts.check) {
      if (opts.json) log.out(JSON.stringify(planToJson(run), null, 2));
      else printPlan(run, { diff: opts.diff });
      if (fatal) process.exitCode = 2;
      else if (run.changed) {
        log.error('README is out of date. Run `readme-sync update` to fix.');
        process.exitCode = 1;
      } else if (run.flags.length && runOpts.config.failOnStale) {
        log.error(`${run.flags.length} stale flag(s) raised and failOnStale is enabled.`);
        process.exitCode = 1;
      } else {
        log.info('README is up to date.');
      }
      return;
    }
    const result = await apply(run);
    if (opts.json)
      log.out(JSON.stringify({ ...(planToJson(run) as object), written: result.written }, null, 2));
    else {
      printPlan(run, { diff: opts.diff });
      if (result.written.length) log.out(`wrote: ${result.written.join(', ')}`);
      else log.out('nothing to write');
    }
    if (fatal) process.exitCode = 2;
    else if (run.flags.length && runOpts.config.failOnStale) {
      log.error(`${run.flags.length} stale flag(s) raised and failOnStale is enabled.`);
      process.exitCode = 1;
    }
  });

  addRunOptions(
    program
      .command('explain <section>')
      .description('Show the inputs, extractor output and diff for one section'),
  ).action(async (section: string, _opts: unknown, cmd: Command) => {
    await explain(section as SectionId, await buildRunOptions(cmd));
  });

  addRunOptions(
    program
      .command('comment')
      .description('Upsert the stale-warning comment on the current pull request')
      .option('--repo <owner/name>', 'GitHub repository (default: from GITHUB_REPOSITORY)')
      .option('--pr <number>', 'pull request number (default: from the GitHub event payload)')
      .option('--token <token>', 'GitHub token (default: GITHUB_TOKEN)')
      .option('--dry-run', 'print the comment body instead of posting', false),
  ).action(
    async (opts: { repo?: string; pr?: string; token?: string; dryRun: boolean }, cmd: Command) => {
      const runOpts = await buildRunOptions(cmd);
      const run = await plan(runOpts);
      await commentCommand(run, {
        ...opts,
        readmeDiff: run.packages.map(readmeDiff).filter(Boolean).join('\n'),
      });
    },
  );

  return program;
}

export async function main(argv = process.argv): Promise<void> {
  const program = makeProgram();
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof ReadmeSyncError) {
      log.error(err.message);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

const isDirectRun = (() => {
  try {
    const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return entry && (import.meta.url.endsWith(path.basename(entry)) || /readme-sync$/.test(entry));
  } catch {
    return false;
  }
})();
if (isDirectRun) {
  main().catch((err) => {
    log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 2;
  });
}

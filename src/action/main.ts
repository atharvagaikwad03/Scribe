import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { resolvePackages } from '../config/packages.js';
import { Git } from '../git/index.js';
import { plan, apply, planToJson, type RunPlan } from '../engine/index.js';
import { createLlmProvider } from '../llm/index.js';
import { buildCommentBody, upsertComment } from '../github/comment.js';
import { formatFlag } from '../flags/index.js';
import { evaluateLoopGuard } from './guard.js';
import { commitAndPush } from './git-ops.js';
import { readmeDiff } from '../cli/report.js';
import { log, setQuiet } from '../util/log.js';

type Mode = 'check' | 'commit' | 'pr';

const BOT_NAME = 'readme-sync[bot]';
const BOT_EMAIL = 'readme-sync[bot]@users.noreply.github.com';

async function writeSummary(run: RunPlan, title: string): Promise<void> {
  const s = core.summary.addHeading(`readme-sync: ${title}`, 2);
  for (const p of run.packages) {
    s.addHeading(p.pkg.readme, 3);
    if (p.error) {
      s.addRaw(`❌ ${p.error}\n\n`);
      continue;
    }
    s.addRaw(
      p.fullMode
        ? `Full regeneration: ${p.fullModeReason}\n\n`
        : `Diff: \`${p.baseSha!.slice(0, 7)}..${p.headSha.slice(0, 7)}\`\n\n`,
    );
    s.addTable([
      [
        { data: 'Section', header: true },
        { data: 'Status', header: true },
        { data: 'Reason', header: true },
      ],
      ...p.sections.map((sec) => [sec.id, sec.status, sec.reason]),
    ]);
  }
  if (run.flags.length) {
    s.addHeading(`Stale flags (${run.flags.length})`, 3);
    s.addList(run.flags.map(formatFlag));
  }
  try {
    await s.write();
  } catch (err) {
    core.warning(`Could not write job summary: ${(err as Error).message}`);
  }
}

export async function runAction(): Promise<void> {
  setQuiet(false);
  const inputMode = (core.getInput('mode') || 'commit') as Mode;
  const configPath = core.getInput('config') || undefined;
  const token = core.getInput('token') || process.env.GITHUB_TOKEN || '';
  const llmMode = core.getInput('llm') || undefined;
  const commitMessage =
    core.getInput('commit-message') || 'docs: sync README with codebase [skip ci]';
  const prBranch = core.getInput('pr-branch') || 'readme-sync/update';
  const workdir = core.getInput('working-directory') || process.cwd();

  const git = new Git(path.resolve(workdir));
  const repoRoot = await git.toplevel();
  const { config } = await loadConfig(repoRoot, configPath);
  const packages = await resolvePackages(repoRoot, config);

  const isPr = context.eventName === 'pull_request' || context.eventName === 'pull_request_target';
  const mode: Mode = isPr ? 'check' : inputMode;
  core.info(`event=${context.eventName} mode=${mode}`);

  if (await git.isShallow()) {
    core.warning(
      'Shallow clone detected: incremental diffs need full history. Use actions/checkout with fetch-depth: 0.',
    );
  }

  // Loop guard (only meaningful on push events; PR checks never commit).
  if (!isPr) {
    const guard = await evaluateLoopGuard(git, {
      trailer: config.changelog.skipTrailer,
      readmePaths: packages.map((p) => p.readme),
      actor: context.actor,
    });
    if (guard.skip) {
      core.info(`Skipping: ${guard.reason}`);
      core.setOutput('changed', 'false');
      core.setOutput('skipped', 'true');
      return;
    }
  }

  const llm = createLlmProvider(config, llmMode);
  const baseOpts = { repoRoot, config, llm, includeWorkingTree: false };

  if (mode === 'check') {
    const run = await plan(baseOpts);
    await writeSummary(run, 'check');
    core.setOutput('changed', String(run.changed));
    core.setOutput('flags', String(run.flags.length));
    core.setOutput('plan', JSON.stringify(planToJson(run)));
    if (isPr && token) {
      const prNumber = context.payload.pull_request?.number;
      if (prNumber) {
        const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
        const body = buildCommentBody(run, {
          readmeDiff: run.packages.map(readmeDiff).filter(Boolean).join('\n'),
          runUrl,
        });
        try {
          const res = await upsertComment(
            { owner: context.repo.owner, repo: context.repo.repo, number: prNumber, token },
            body,
          );
          core.info(`PR comment ${res.action}: ${res.url}`);
        } catch (err) {
          core.warning(`Could not post PR comment: ${(err as Error).message}`);
        }
      }
    }
    if (run.packages.some((p) => p.error))
      core.setFailed('readme-sync: fatal marker problem (see summary)');
    else if (run.flags.length && config.failOnStale)
      core.setFailed(`readme-sync: ${run.flags.length} stale flag(s) and failOnStale is enabled`);
    return;
  }

  // commit / pr modes: run on the target branch after merge.
  const branch = context.ref.replace(/^refs\/heads\//, '') || (await git.currentBranch());
  await git.setUser(BOT_NAME, BOT_EMAIL);
  let lastRun: RunPlan | undefined;
  const message = `${commitMessage}\n\n${config.changelog.skipTrailer}`;

  const result = await commitAndPush({
    repoRoot,
    branch,
    message,
    authorName: BOT_NAME,
    authorEmail: BOT_EMAIL,
    pushBranch: mode === 'pr' ? prBranch : undefined,
    force: mode === 'pr',
    regenerate: async () => {
      if (mode === 'pr') {
        // Rebuild the PR branch from the current target branch each attempt.
        await git.git(['checkout', '-q', '-B', prBranch]);
      }
      lastRun = await plan(baseOpts);
      if (lastRun.packages.some((p) => p.error)) return [];
      const res = await apply(lastRun);
      return res.written;
    },
  });

  if (lastRun) await writeSummary(lastRun, mode);
  core.setOutput('changed', String(result.committed));
  core.setOutput('flags', String(lastRun?.flags.length ?? 0));
  core.setOutput('sha', result.sha ?? '');
  if (result.error) {
    core.setFailed(`readme-sync: ${result.error}`);
    return;
  }
  if (!result.committed) core.info('README already in sync; nothing committed.');
  else
    core.info(
      `Committed ${result.sha} after ${result.attempts} attempt(s): ${result.written.join(', ')}`,
    );

  if (mode === 'pr' && result.committed && token) {
    const octokit = getOctokit(token);
    const { owner, repo } = context.repo;
    const open = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      head: `${owner}:${prBranch}`,
      base: branch,
    });
    const title = 'docs: sync README with codebase';
    const body = `Automated README update from readme-sync.\n\n${lastRun?.flags.length ? '⚠️ Stale flags:\n' + lastRun.flags.map((f) => `- ${formatFlag(f)}`).join('\n') : 'No stale flags.'}\n\n${config.changelog.skipTrailer}`;
    if (open.data[0]) {
      await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: open.data[0].number,
        title,
        body,
      });
      core.info(`Updated PR #${open.data[0].number}`);
    } else {
      const pr = await octokit.rest.pulls.create({
        owner,
        repo,
        head: prBranch,
        base: branch,
        title,
        body,
      });
      core.info(`Opened PR #${pr.data.number}`);
    }
  }
  if (lastRun?.packages.some((p) => p.error))
    core.setFailed('readme-sync: fatal marker problem (see summary)');
  else if (lastRun && lastRun.flags.length && config.failOnStale)
    core.setFailed(`readme-sync: ${lastRun.flags.length} stale flag(s) and failOnStale is enabled`);
}

runAction().catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  core.setFailed(err instanceof Error ? err.message : String(err));
});

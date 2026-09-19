import { promises as fs } from 'node:fs';
import { getOctokit } from '@actions/github';
import { COMMENT_MARKER } from '../config/schema.js';
import type { RunPlan } from '../engine/index.js';
import { formatFlag } from '../flags/index.js';
import { ReadmeSyncError } from '../util/errors.js';

export interface PullRequestContext {
  owner: string;
  repo: string;
  number: number;
  token: string;
}

export async function resolvePullRequestContext(opts: {
  repo?: string;
  pr?: string;
  token?: string;
}): Promise<PullRequestContext> {
  const token = opts.token ?? process.env.GITHUB_TOKEN ?? process.env.INPUT_TOKEN;
  if (!token)
    throw new ReadmeSyncError('GITHUB', 'No GitHub token (pass --token or set GITHUB_TOKEN)');
  const repoFull = opts.repo ?? process.env.GITHUB_REPOSITORY;
  if (!repoFull || !repoFull.includes('/'))
    throw new ReadmeSyncError(
      'GITHUB',
      'No repository (pass --repo owner/name or set GITHUB_REPOSITORY)',
    );
  const [owner, repo] = repoFull.split('/') as [string, string];
  let number = opts.pr ? Number(opts.pr) : NaN;
  if (!Number.isFinite(number) && process.env.GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(await fs.readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) as {
        pull_request?: { number?: number };
        number?: number;
      };
      number = event.pull_request?.number ?? event.number ?? NaN;
    } catch {
      /* ignore */
    }
  }
  if (!Number.isFinite(number))
    throw new ReadmeSyncError(
      'GITHUB',
      'No pull request number (pass --pr or run on a pull_request event)',
    );
  return { owner, repo, number, token };
}

export function buildCommentBody(
  run: RunPlan,
  opts: { readmeDiff?: string; runUrl?: string } = {},
): string {
  const lines: string[] = [COMMENT_MARKER, '## readme-sync', ''];
  const updates = run.packages.flatMap((p) =>
    p.sections.filter((s) => s.status === 'update').map((s) => ({ pkg: p.pkg.path, id: s.id })),
  );
  if (run.flags.length) {
    lines.push(`### ⚠️ README may be stale (${run.flags.length})`, '');
    for (const f of run.flags) lines.push(`- ${formatFlag(f)}`);
    lines.push('');
  } else {
    lines.push('No stale flags. ✅', '');
  }
  if (updates.length) {
    lines.push(`### Sections that will be regenerated after merge (${updates.length})`, '');
    for (const u of updates) lines.push(`- \`${u.id}\`${u.pkg === '.' ? '' : ` in \`${u.pkg}\``}`);
    lines.push('');
  } else if (!run.packages.some((p) => p.error)) {
    lines.push('Generated README sections are up to date with this change.', '');
  }
  for (const p of run.packages) if (p.error) lines.push(`- ❌ \`${p.pkg.readme}\`: ${p.error}`);
  if (opts.readmeDiff) {
    const trimmed =
      opts.readmeDiff.length > 12_000
        ? opts.readmeDiff.slice(0, 12_000) + '\n… (truncated)'
        : opts.readmeDiff;
    lines.push(
      '<details><summary>README diff preview</summary>',
      '',
      '```diff',
      trimmed.replace(/```/g, '` ` `'),
      '```',
      '',
      '</details>',
      '',
    );
  }
  if (opts.runUrl) lines.push(`<sub>[workflow run](${opts.runUrl})</sub>`);
  return lines.join('\n');
}

/** The subset of Octokit we use, so tests can inject a fake. */
export interface CommentClient {
  listComments(p: {
    owner: string;
    repo: string;
    issue_number: number;
  }): Promise<Array<{ id: number; body?: string; html_url: string }>>;
  updateComment(p: {
    owner: string;
    repo: string;
    comment_id: number;
    body: string;
  }): Promise<{ html_url: string }>;
  createComment(p: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }): Promise<{ html_url: string }>;
}

export function octokitClient(token: string): CommentClient {
  const octokit = getOctokit(token);
  return {
    listComments: (p) =>
      octokit.paginate(octokit.rest.issues.listComments, { ...p, per_page: 100 }),
    updateComment: async (p) => (await octokit.rest.issues.updateComment(p)).data,
    createComment: async (p) => (await octokit.rest.issues.createComment(p)).data,
  };
}

export async function upsertComment(
  ctx: PullRequestContext,
  body: string,
  client: CommentClient = octokitClient(ctx.token),
): Promise<{ action: 'created' | 'updated' | 'unchanged'; url: string }> {
  const existing = await client.listComments({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.number,
  });
  const mine = existing.find((c) => c.body?.includes(COMMENT_MARKER));
  if (mine) {
    if (mine.body === body) return { action: 'unchanged', url: mine.html_url };
    const res = await client.updateComment({
      owner: ctx.owner,
      repo: ctx.repo,
      comment_id: mine.id,
      body,
    });
    return { action: 'updated', url: res.html_url };
  }
  const res = await client.createComment({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.number,
    body,
  });
  return { action: 'created', url: res.html_url };
}

import type { RunPlan } from '../engine/index.js';
import { buildCommentBody, upsertComment, resolvePullRequestContext } from '../github/comment.js';
import { log } from '../util/log.js';

export async function commentCommand(
  run: RunPlan,
  opts: { repo?: string; pr?: string; token?: string; dryRun: boolean; readmeDiff: string },
): Promise<void> {
  const body = buildCommentBody(run, { readmeDiff: opts.readmeDiff });
  if (opts.dryRun) {
    log.out(body);
    return;
  }
  const ctx = await resolvePullRequestContext({ repo: opts.repo, pr: opts.pr, token: opts.token });
  const res = await upsertComment(ctx, body);
  log.info(`${res.action} comment ${res.url}`);
}

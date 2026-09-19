import type { Git } from '../git/index.js';
import { STATE_DIR } from '../config/schema.js';

export interface GuardInput {
  /** Commit trailer that marks the tool's own commits. */
  trailer: string;
  /** Repo-relative README paths managed by the tool. */
  readmePaths: string[];
  /** GitHub actor that triggered the run, if known. */
  actor?: string;
  /** Actor names treated as the bot. */
  botActors?: string[];
}

export interface GuardResult {
  skip: boolean;
  reason?: string;
}

const DEFAULT_BOTS = ['github-actions[bot]', 'readme-sync[bot]', 'dependabot[bot]'];

/**
 * Loop guard, evaluated before any generation:
 *  (b) the head commit carries the tool trailer, or the actor is the bot;
 *  (c) the head commit touches only managed READMEs and the state directory.
 * Layer (a) is the `[skip ci]` tag we put in our own commit messages and
 * layer (e) is `paths-ignore` in the example workflow.
 */
export async function evaluateLoopGuard(git: Git, input: GuardInput): Promise<GuardResult> {
  const message = await git.commitMessage('HEAD');
  if (message.toLowerCase().includes(input.trailer.toLowerCase())) {
    return {
      skip: true,
      reason: `head commit carries the "${input.trailer}" trailer (readme-sync's own commit)`,
    };
  }
  const bots = new Set([...DEFAULT_BOTS, ...(input.botActors ?? [])]);
  if (input.actor && bots.has(input.actor)) {
    return { skip: true, reason: `triggered by bot actor ${input.actor}` };
  }
  const author = await git.commitAuthor('HEAD');
  if (/readme-sync/i.test(author.name) || /readme-sync/i.test(author.email)) {
    return { skip: true, reason: `head commit authored by ${author.name} <${author.email}>` };
  }
  const files = await git.filesInCommit('HEAD');
  if (files.length) {
    const managed = new Set(input.readmePaths);
    const onlyReadme = files.every(
      (f) => managed.has(f) || f === `${STATE_DIR}` || f.startsWith(`${STATE_DIR}/`),
    );
    if (onlyReadme)
      return {
        skip: true,
        reason: 'head commit changes only managed README(s) and .readme-sync/**',
      };
  }
  return { skip: false };
}

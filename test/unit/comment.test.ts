import { describe, expect, it } from 'vitest';
import { buildCommentBody, upsertComment, type CommentClient } from '../../src/github/comment.js';
import { COMMENT_MARKER } from '../../src/config/schema.js';
import type { RunPlan } from '../../src/engine/index.js';

function fakeRun(flags: RunPlan['flags'], updates: string[] = []): RunPlan {
  return {
    repoRoot: '/r',
    headSha: 'abc',
    changed: updates.length > 0,
    flags,
    packages: [
      {
        pkg: { path: '.', readme: 'README.md' } as any,
        headSha: 'abc',
        baseSha: null,
        fullMode: false,
        files: [],
        sections: updates.map((id) => ({
          id: id as any,
          status: 'update',
          reason: '',
          affectedBy: [],
          diagnostics: [],
          extracted: true,
        })),
        flags,
        readmeChanged: updates.length > 0,
        stateBefore: {} as any,
        stateAfter: {} as any,
      },
    ],
  };
}

describe('buildCommentBody', () => {
  it('lists flags with section, reason and files, and includes the hidden marker', () => {
    const body = buildCommentBody(
      fakeRun([
        {
          pkg: '.',
          section: 'api',
          reason: 'low-confidence',
          message: 'src/routes/v2.ts changed but no endpoint could be resolved with confidence',
          files: ['src/routes/v2.ts'],
        },
      ]),
    );
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain(
      'README may be stale here: `api` — src/routes/v2.ts changed but no endpoint could be resolved with confidence — `src/routes/v2.ts`',
    );
  });

  it('reports a clean run and pending regenerations with a diff preview', () => {
    const body = buildCommentBody(fakeRun([], ['api', 'changelog']), {
      readmeDiff: '--- a\n+++ b\n+new line',
    });
    expect(body).toContain('No stale flags');
    expect(body).toContain('- `api`');
    expect(body).toContain('```diff');
    expect(body).toContain('+new line');
  });
});

describe('upsertComment', () => {
  function client(existing: Array<{ id: number; body?: string; html_url: string }>) {
    const calls: string[] = [];
    const c: CommentClient = {
      async listComments() {
        calls.push('list');
        return existing;
      },
      async updateComment(p) {
        calls.push(`update:${p.comment_id}`);
        return { html_url: 'u' };
      },
      async createComment() {
        calls.push('create');
        return { html_url: 'c' };
      },
    };
    return { c, calls };
  }
  const ctx = { owner: 'o', repo: 'r', number: 1, token: 't' };

  it('creates when no marker comment exists', async () => {
    const { c, calls } = client([{ id: 1, body: 'unrelated', html_url: 'x' }]);
    expect(await upsertComment(ctx, `${COMMENT_MARKER}\nhello`, c)).toEqual({
      action: 'created',
      url: 'c',
    });
    expect(calls).toEqual(['list', 'create']);
  });

  it('updates the existing marker comment instead of adding another', async () => {
    const { c, calls } = client([{ id: 7, body: `${COMMENT_MARKER}\nold`, html_url: 'x' }]);
    expect(await upsertComment(ctx, `${COMMENT_MARKER}\nnew`, c)).toEqual({
      action: 'updated',
      url: 'u',
    });
    expect(calls).toEqual(['list', 'update:7']);
  });

  it('does nothing when the body is unchanged', async () => {
    const body = `${COMMENT_MARKER}\nsame`;
    const { c, calls } = client([{ id: 7, body, html_url: 'x' }]);
    expect(await upsertComment(ctx, body, c)).toEqual({ action: 'unchanged', url: 'x' });
    expect(calls).toEqual(['list']);
  });
});

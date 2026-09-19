import type { LlmProvider, LlmRequest } from './provider.js';

/**
 * Test double. Responds with a canned reply set by the test, or echoes the
 * prompt's SHAs into deterministic bullets when no reply is queued.
 */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly calls: LlmRequest[] = [];
  private queue: string[] = [];

  reply(text: string): this {
    this.queue.push(text);
    return this;
  }

  async complete(req: LlmRequest): Promise<string> {
    this.calls.push(req);
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    const shas = [...req.prompt.matchAll(/\b([0-9a-f]{7,40})\b/g)].map((m) => m[1]!);
    return shas.map((s) => `- Summarised change (${s.slice(0, 7)})`).join('\n');
  }
}

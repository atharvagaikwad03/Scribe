import type { Config } from '../config/schema.js';
import type { LlmProvider } from './provider.js';
import { AnthropicProvider } from './anthropic.js';
import { MockProvider } from './mock.js';

/**
 * Resolve the provider from config + optional CLI override. Returns undefined
 * when the LLM is disabled (the default), which every extractor must tolerate.
 */
export function createLlmProvider(config: Config, override?: string): LlmProvider | undefined {
  const mode = override ?? (config.llm.enabled ? config.llm.provider : 'off');
  switch (mode) {
    case 'off':
    case undefined:
      return undefined;
    case 'mock':
      return new MockProvider();
    case 'anthropic': {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return undefined; // no key: silently deterministic, never fail the run
      return new AnthropicProvider(key);
    }
    default:
      throw new Error(`Unknown llm mode "${mode}" (expected off | anthropic | mock)`);
  }
}

export type { LlmProvider } from './provider.js';
export { MockProvider } from './mock.js';
export { AnthropicProvider } from './anthropic.js';

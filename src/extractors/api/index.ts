import type { SectionGenerator } from '../types.js';
import { ok } from '../types.js';

export const apiGenerator: SectionGenerator<Record<string, never>> = {
  id: 'api',
  defaultWatch: [],
  async extract() {
    return ok({}, ['not implemented yet'], 0);
  },
  render() {
    return '_not implemented_';
  },
};

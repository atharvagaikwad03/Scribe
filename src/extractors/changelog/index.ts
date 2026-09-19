import type { SectionGenerator } from '../types.js';
import { ok } from '../types.js';

export const changelogGenerator: SectionGenerator<Record<string, never>> = {
  id: 'changelog',
  defaultWatch: [],
  async extract() {
    return ok({}, ['not implemented yet'], 0);
  },
  render() {
    return '_not implemented_';
  },
};

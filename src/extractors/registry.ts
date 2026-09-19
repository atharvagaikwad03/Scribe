import type { SectionId } from '../config/schema.js';
import type { SectionGenerator } from './types.js';
import { commandsGenerator } from './commands/index.js';
import { dependenciesGenerator } from './dependencies/index.js';
import { structureGenerator } from './structure/index.js';
import { apiGenerator } from './api/index.js';
import { changelogGenerator } from './changelog/index.js';
import { packagesGenerator } from './packages/index.js';

/** Order matters: `api` must run before `changelog` (which consumes the surface diff). */
export const GENERATORS: SectionGenerator<any>[] = [
  structureGenerator,
  apiGenerator,
  commandsGenerator,
  dependenciesGenerator,
  packagesGenerator,
  changelogGenerator,
];

export function generatorFor(id: SectionId): SectionGenerator<any> {
  const g = GENERATORS.find((x) => x.id === id);
  if (!g) throw new Error(`No generator registered for section "${id}"`);
  return g;
}

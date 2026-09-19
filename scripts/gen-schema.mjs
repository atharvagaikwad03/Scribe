// Generates schema/readme-sync.schema.json from the zod config schema.
// Run after `pnpm build` (imports the built library).
import { writeFileSync, mkdirSync } from 'node:fs';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { configSchema } from '../dist/index.js';

const schema = zodToJsonSchema(configSchema, {
  name: 'ReadmeSyncConfig',
  $refStrategy: 'none',
});
const out = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://raw.githubusercontent.com/atharvagaikwad03/ubiquitous-tribble/main/schema/readme-sync.schema.json',
  title: 'readme-sync configuration (.readme-sync.yml)',
  ...schema.definitions.ReadmeSyncConfig,
};
mkdirSync('schema', { recursive: true });
writeFileSync('schema/readme-sync.schema.json', JSON.stringify(out, null, 2) + '\n');
console.log('wrote schema/readme-sync.schema.json');

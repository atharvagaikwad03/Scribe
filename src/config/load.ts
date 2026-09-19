import path from 'node:path';
import YAML from 'yaml';
import { ZodError } from 'zod';
import { configSchema, CONFIG_FILENAME, type Config, type ConfigInput } from './schema.js';
import { ConfigError } from '../util/errors.js';
import { readTextIfExists } from '../util/fs.js';

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the config file, or undefined when defaults were used. */
  file: string | undefined;
}

export function parseConfig(input: unknown, sourceName = CONFIG_FILENAME): Config {
  try {
    return configSchema.parse(input ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues
        .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n');
      throw new ConfigError(`Invalid ${sourceName}:\n${issues}`);
    }
    throw err;
  }
}

export async function loadConfig(repoRoot: string, configPath?: string): Promise<LoadedConfig> {
  const file = path.resolve(repoRoot, configPath ?? CONFIG_FILENAME);
  const text = await readTextIfExists(file);
  if (text === undefined) {
    if (configPath) throw new ConfigError(`Config file not found: ${file}`);
    return { config: parseConfig({}), file: undefined };
  }
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new ConfigError(`Could not parse ${file}: ${(err as Error).message}`);
  }
  return { config: parseConfig(raw, path.basename(file)), file };
}

export function defaultConfigInput(): ConfigInput {
  return {
    version: 1,
    packages: [],
    discoverWorkspaces: true,
    sections: {
      structure: { enabled: true, anchor: '## Project structure', depth: 2 },
      api: { enabled: true, anchor: '## API' },
      commands: { enabled: true, anchor: '## Commands' },
      dependencies: { enabled: true, anchor: '## Dependencies' },
      changelog: { enabled: true, anchor: '## Changelog' },
      packages: { enabled: false, anchor: '## Packages' },
    },
    ignore: [],
    confidenceThreshold: 0.7,
    failOnStale: false,
    changelog: { maxEntries: 50 },
    llm: { enabled: false },
  };
}

export function renderDefaultConfig(): string {
  const header = [
    '# readme-sync configuration. Schema: schema/readme-sync.schema.json',
    '# Docs: https://github.com/atharvagaikwad03/ubiquitous-tribble',
    '# yaml-language-server: $schema=./schema/readme-sync.schema.json',
    '',
  ].join('\n');
  return header + YAML.stringify(defaultConfigInput());
}

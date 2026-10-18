import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; engines: { node: string }; packageManager: string };
export const VERSION = manifest.version;
export const NODE_VERSION = manifest.engines.node;
export const PNPM_VERSION = manifest.packageManager.replace(/^pnpm@/, '');
export const SCHEMA_VERSION = 15;

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from `start` until a directory containing package.json is found. */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/** Absolute path to the project root (works from both `src/` via tsx and `dist/`). */
export const PROJECT_ROOT = findProjectRoot(here);

/**
 * Where per-user state lives: config.json, token files, models, logs, output, capability cache.
 * `AIR_MCP_HOME` wins. A checkout uses its own root. A package installed from npm (the code sits
 * under `node_modules`, often in a cache that gets wiped) uses `~/.ai-image-router-mcp`.
 */
export const APP_HOME = process.env.AIR_MCP_HOME
  ? resolve(process.env.AIR_MCP_HOME)
  : PROJECT_ROOT.split(sep).includes('node_modules')
    ? join(homedir(), '.ai-image-router-mcp')
    : PROJECT_ROOT;

/** The command that starts the configuration wizard, as the user would type it. */
export const CONFIGURE_COMMAND = APP_HOME === PROJECT_ROOT
  ? 'npm run configure'
  : 'npx -p ai-image-router-mcp ai-image-router-mcp-configure';

/** Join one or more segments onto the project root (the shipped code and data). */
export function fromRoot(...segments: string[]): string {
  return join(PROJECT_ROOT, ...segments);
}

/** Join one or more segments onto the per-user state directory. */
export function fromHome(...segments: string[]): string {
  return join(APP_HOME, ...segments);
}

/** Resolve a possibly-relative path against the per-user state directory. */
export function resolvePath(p: string): string {
  return isAbsolute(p) ? p : join(APP_HOME, p);
}

export const CONFIG_PATH = process.env.AIR_MCP_CONFIG
  ? resolvePath(process.env.AIR_MCP_CONFIG)
  : fromHome('config.json');

export const DATA_DIR = fromRoot('data');
/** Persisted gateway capability lookups (git-ignored), so a server start needn't wait on the network. */
export const CAPABILITY_CACHE_PATH = fromHome('.cache', 'capabilities.json');
export const LEADERBOARDS_DIR = join(DATA_DIR, 'leaderboards');
export const ASPECT_RATIOS_PATH = join(DATA_DIR, 'aspect-ratios.json');

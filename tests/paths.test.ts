/**
 * Where per-user state lives. The path constants are fixed at import time, so each case runs a
 * fresh process with its own environment.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROJECT_ROOT } from '../src/config/paths.js';

function probe(env: Record<string, string>): { appHome: string; configPath: string; resolved: string } {
  const code =
    "import('./src/config/paths.ts').then(p => console.log(JSON.stringify({ appHome: p.APP_HOME, configPath: p.CONFIG_PATH, resolved: p.resolvePath('output') })))";
  const clean = { ...process.env };
  delete clean['AIR_MCP_HOME'];
  delete clean['AIR_MCP_CONFIG'];
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', code], { cwd: PROJECT_ROOT, env: { ...clean, ...env }, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop() ?? '{}');
}

describe('per-user state directory', () => {
  it('a checkout keeps its state in the project root', () => {
    const p = probe({});
    assert.equal(p.appHome, PROJECT_ROOT);
    assert.equal(p.configPath, join(PROJECT_ROOT, 'config.json'));
  });

  it('AIR_MCP_HOME moves config and relative paths', () => {
    const home = join(tmpdir(), 'air-mcp-home-test');
    const p = probe({ AIR_MCP_HOME: home });
    assert.equal(p.appHome, resolve(home));
    assert.equal(p.configPath, join(resolve(home), 'config.json'));
    assert.equal(p.resolved, join(resolve(home), 'output'));
  });

  it('an empty AIR_MCP_HOME or AIR_MCP_CONFIG (an unset plugin variable) is ignored', () => {
    const p = probe({ AIR_MCP_HOME: '', AIR_MCP_CONFIG: '' });
    assert.equal(p.appHome, PROJECT_ROOT);
    assert.equal(p.configPath, join(PROJECT_ROOT, 'config.json'));
  });

  it('AIR_MCP_CONFIG still wins for the config file', () => {
    const cfg = join(homedir(), 'elsewhere', 'config.json');
    assert.equal(probe({ AIR_MCP_CONFIG: cfg }).configPath, cfg);
  });
});

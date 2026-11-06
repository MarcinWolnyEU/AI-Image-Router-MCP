/**
 * The wizard's HTTP bearer-token step, through the real `configureTransport` driven by
 * `prompts.inject`. The path constants are fixed at import time, so each case runs a fresh
 * process with its own `AIR_MCP_HOME`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../src/config/paths.js';
import { HTTP_AUTH_TOKEN_FILE } from '../src/config/schema.js';

type TokenSource = { type: string; value: string };

/** Runs the transport step in `home`, answering: HTTP, default binding, require a token. `current` is the token already in the config. */
function chooseHttpWithToken(home: string, current: TokenSource | null = null): TokenSource {
  const existing = current && { http: { enabled: true, host: '127.0.0.1', port: 8787, authToken: current } };
  const code =
    "Promise.all([import('prompts'), import('./src/config/wizardLocal.ts')]).then(async ([{ default: prompts }, wizard]) => {" +
    " prompts.inject(['http', '127.0.0.1', 8787, true]);" +
    ` console.log(JSON.stringify((await wizard.configureTransport(${JSON.stringify(existing)})).authToken));` +
    ' })';
  const env = { ...process.env, AIR_MCP_HOME: home };
  delete env['AIR_MCP_CONFIG'];
  const out = execFileSync(process.execPath, ['--import', 'tsx', '-e', code], { cwd: PROJECT_ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.trim().split('\n').pop() ?? '{}');
}

const newHome = () => mkdtempSync(join(tmpdir(), 'air-wizard-'));
const DEFAULT_FILE: TokenSource = { type: 'file', value: HTTP_AUTH_TOKEN_FILE };

describe('wizard HTTP token file', () => {
  it('creates a missing home directory instead of failing on the last wizard step', () => {
    const home = join(newHome(), 'not', 'created', 'yet');
    const authToken = chooseHttpWithToken(home);
    assert.deepEqual(authToken, DEFAULT_FILE);
    const tokenPath = join(home, HTTP_AUTH_TOKEN_FILE);
    assert.ok(readFileSync(tokenPath, 'utf8').trim().length >= 32, 'a real random token was written');
    if (process.platform !== 'win32') assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  });

  it('keeps an existing token rather than rotating it', () => {
    const home = newHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, HTTP_AUTH_TOKEN_FILE), 'keep-me\n');
    chooseHttpWithToken(home);
    assert.equal(readFileSync(join(home, HTTP_AUTH_TOKEN_FILE), 'utf8'), 'keep-me\n');
    chooseHttpWithToken(home, DEFAULT_FILE);
    assert.equal(readFileSync(join(home, HTTP_AUTH_TOKEN_FILE), 'utf8'), 'keep-me\n', 'also when the config already names it');
  });

  it('recreates the default token file when the config names it but it is gone', () => {
    const home = newHome();
    assert.deepEqual(chooseHttpWithToken(home, DEFAULT_FILE), DEFAULT_FILE);
    assert.ok(readFileSync(join(home, HTTP_AUTH_TOKEN_FILE), 'utf8').trim().length >= 32, 'a real random token was written');
  });

  it('leaves a custom token source alone, even if its file is missing', () => {
    const home = newHome();
    const custom = { type: 'file', value: 'my-own-token.txt' };
    assert.deepEqual(chooseHttpWithToken(home, custom), custom);
    assert.equal(existsSync(join(home, custom.value)), false);
    assert.equal(existsSync(join(home, HTTP_AUTH_TOKEN_FILE)), false);
  });
});

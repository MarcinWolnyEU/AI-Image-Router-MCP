/**
 * The publish manifests (package.json, server.json, the Cursor plugin and its mcp.json) must agree
 * with each other. They are edited by hand and published separately, so drift is easy to miss.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../src/config/paths.js';

const readJson = (rel: string): Record<string, any> => JSON.parse(readFileSync(join(PROJECT_ROOT, rel), 'utf8'));

describe('publish manifests', () => {
  const pkg = readJson('package.json');
  const server = readJson('server.json');
  const plugin = readJson('.cursor-plugin/plugin.json');
  const mcp = readJson('mcp.json');

  it('server.json names the same package and version as package.json', () => {
    assert.equal(server['name'], pkg['mcpName']);
    assert.equal(server['version'], pkg['version']);
    const npm = server['packages'][0];
    assert.equal(npm['registryType'], 'npm');
    assert.equal(npm['identifier'], pkg['name']);
    assert.equal(npm['version'], pkg['version']);
  });

  it('server.json description fits the registry limit', () => {
    assert.ok(String(server['description']).length <= 100, 'registry descriptions are capped at 100 characters');
  });

  it('the Cursor plugin points at an mcp.json that launches the published package', () => {
    assert.equal(plugin['mcpServers'], 'mcp.json');
    assert.ok(existsSync(join(PROJECT_ROOT, 'mcp.json')));
    const entry = mcp['mcpServers']['ai-image-router'];
    assert.equal(entry['command'], 'npx');
    assert.ok((entry['args'] as string[]).includes(pkg['name']));
  });

  it('every file the package publishes exists', () => {
    for (const f of pkg['files'] as string[]) assert.ok(existsSync(join(PROJECT_ROOT, f)), `${f} is listed in package.json "files"`);
  });

  it('every env var the plugin passes is declared as a plugin variable and in server.json', () => {
    const passed = Object.keys(mcp['mcpServers']['ai-image-router']['env']);
    const declared = Object.keys(plugin['variables']['properties']);
    const registry = (server['packages'][0]['environmentVariables'] as Array<{ name: string }>).map((v) => v.name);
    for (const name of passed) {
      assert.ok(declared.includes(name), `${name} missing from plugin variables`);
      assert.ok(registry.includes(name), `${name} missing from server.json`);
    }
  });
});

/**
 * Wizard output after the config is saved: the "what was saved" summary and the
 * client-registration next steps. Pure printing, split out of `wizard.ts` (the sequence).
 */
import { APP_HOME, CONFIG_PATH, fromRoot, PROJECT_ROOT } from './paths.js';
import { type AppConfig, GATEWAY_LABELS, type GatewayId } from './schema.js';
import { type IssueLog, log } from './wizardPrompt.js';

/** `  [4:3, 1K]`-style suffix for the default image shape; empty when no aspect ratio is set. */
function describeImageShape(image: AppConfig['image']): string {
  if (!image.defaultAspectRatio) return '';
  return `  [${image.defaultAspectRatio}${image.defaultResolution ? ', ' + image.defaultResolution : ''}]`;
}

function describeBackgroundRemoval(bg: AppConfig['backgroundRemoval']): string {
  return bg.model === 'none' ? bg.model : `${bg.model} (${bg.executionProvider})`;
}

/** The model when the generation type is enabled, else `disabled`. */
function describeVideo(video: { enabled: boolean; model: string | null }): string {
  return video.enabled ? (video.model ?? '(none)') : 'disabled';
}

export function printSavedSummary(gateway: GatewayId, draft: AppConfig, issues: IssueLog): void {
  const { image, imageToVideo, textToVideo, backgroundRemoval: bg } = draft;
  // The real target: AIR_MCP_CONFIG may redirect it away from the project's config.json.
  log(`\n✅ Saved configuration to ${CONFIG_PATH}\n`);
  log(`Gateway:        ${GATEWAY_LABELS[gateway]}`);
  log(`Image model:    ${image.model ?? '(none)'}${describeImageShape(image)}`);
  log(`Image→Video:    ${describeVideo(imageToVideo)}`);
  log(`Text→Video:     ${describeVideo(textToVideo)}`);
  log(`Bg removal:     ${describeBackgroundRemoval(bg)}`);
  if (gateway === 'fal') log(`fal safety:     ${draft.fal.relaxSafety ? 'RELAXED (checker off, tolerance 5)' : 'fal defaults'}`);
  log(`Tinify:         ${draft.tinify ? 'enabled (PNG compression + WebP/AVIF/JPEG conversion)' : 'disabled'}`);
  log(`Logging:        ${draft.logging.policy}`);
  if (issues.issues.length > 0) {
    log(`\n${issues.issues.length} issue(s) were recorded during configuration (visible via the health_status tool).`);
  }
}

/**
 * Next steps. For stdio (the usual case) the MCP client *spawns* the server
 * itself from the command you register, you don't run it by hand. Only HTTP
 * mode is something you start yourself.
 */
export function printNextSteps(http: AppConfig['http']): void {
  if (APP_HOME !== PROJECT_ROOT) {
    printInstalledNextSteps(http);
    return;
  }
  const entry = fromRoot('dist/index.js').replace(/\\/g, '/');
  log('\nNext step: register this server with your MCP client. The client then');
  log('launches it for you over stdio (you do NOT run `npm start` yourself):');
  log('');
  log('  Claude Code:');
  log(`    claude mcp add ai-image-router -- node "${entry}"`);
  log('');
  log('  Claude Desktop (claude_desktop_config.json → "mcpServers"):');
  log(`    "ai-image-router": { "command": "node", "args": ["${entry}"] }`);
  log('');
  log('  (Run `npm run build` first if dist/ is missing or out of date.)');
  if (http.enabled) {
    log('');
    log('HTTP mode is the one mode you start yourself, then point the client at the URL:');
    log(`    npm start -- --http      # listens on http://${http.host}:${http.port}`);
  }
  log('');
}

/** Next steps for a package installed from npm: the client launches it through npx. */
function printInstalledNextSteps(http: AppConfig['http']): void {
  log('\nNext step: register this server with your MCP client. The client then');
  log('launches it for you over stdio:');
  log('');
  log('  Claude Code:');
  log('    claude mcp add ai-image-router -- npx -y ai-image-router-mcp');
  log('');
  log('  Claude Desktop (claude_desktop_config.json → "mcpServers"):');
  log('    "ai-image-router": { "command": "npx", "args": ["-y", "ai-image-router-mcp"] }');
  log('');
  log(`Your settings live in ${APP_HOME} (config.json, models, logs, output).`);
  log('Set AIR_MCP_HOME to use another directory, or AIR_MCP_CONFIG to point at a config file.');
  if (http.enabled) {
    log('');
    log(`HTTP mode is the one mode you start yourself: npx -y ai-image-router-mcp --http  (http://${http.host}:${http.port})`);
  }
  log('');
}

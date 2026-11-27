/**
 * Manual smoke test (not part of the build). Run with tsx:
 *   npx tsx scripts/smoke.ts list <gateway>
 *   npx tsx scripts/smoke.ts genimg <gateway> "<prompt>" [model] [edenProvider]
 *   npx tsx scripts/smoke.ts listvideo <gateway>
 * <gateway> = openrouter | mistral | edenai
 */
import { join } from 'node:path';
import { Logger } from '../src/logging/logger.js';
import { createGateway } from '../src/gateways/registry.js';
import { DEFAULT_TOKEN_FILES, resolveApiKey, type GatewayId } from '../src/config/schema.js';
import { saveMedia, extFromMime } from '../src/util/files.js';
import { findProjectRoot } from './root.mjs';

const ROOT = findProjectRoot(import.meta.url);

function log(...a: unknown[]) {
  console.error(...a);
}

type Gw = ReturnType<typeof createGateway>;
interface CmdContext {
  gw: Gw;
  gwId: string;
  /** The positional args after <gateway>. */
  args: Array<string | undefined>;
}

/** Print the source, warnings and the first 15 models of a listing result. */
function logModelList(r: { source: string; models: Array<{ id: string; created?: number }>; warnings: string[] }, withDate: boolean): void {
  log(`source=${r.source} count=${r.models.length}`);
  if (r.warnings.length) log('warnings:', r.warnings.join(' | '));
  for (const m of r.models.slice(0, 15)) {
    const date = withDate && m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : '';
    log(withDate ? `  ${m.id}  ${date}` : `  ${m.id}`);
  }
}

async function cmdList({ gw }: CmdContext): Promise<void> {
  logModelList(await gw.listImageModels(), true);
}

async function cmdListVideo({ gw }: CmdContext): Promise<void> {
  if (!gw.listVideoModels) return log('gateway has no listVideoModels');
  logModelList(await gw.listVideoModels('text-to-video'), false);
}

async function cmdGenImage({ gw, gwId, args: [a1, a2, a3] }: CmdContext): Promise<void> {
  const prompt = a1 ?? 'a friendly robot painting a watercolor of mountains at sunset';
  const model = a2 ?? null;
  const edenProvider = a3 ?? null;
  log(`generating: model=${model} edenProvider=${edenProvider} prompt="${prompt}"`);
  const t = Date.now();
  const res = await gw.generateImage({
    prompt,
    model: model ?? '',
    aspectRatio: gwId === 'edenai' ? null : '1:1',
    resolution: gwId === 'openrouter' ? '1K' : gwId === 'edenai' ? '1024x1024' : null,
    edenProvider,
  });
  log(`done in ${Date.now() - t}ms, modelUsed=${res.modelUsed}, images=${res.images.length}, cost=${res.cost ?? 'n/a'}`);
  for (const img of res.images) {
    const saved = await saveMedia(join(ROOT, 'output'), img.bytes, extFromMime(img.mimeType, 'png'), prompt);
    log(`  saved ${saved.path} (${img.bytes.length} bytes, ${img.mimeType})`);
  }
}

const COMMANDS: Record<string, (c: CmdContext) => Promise<void>> = { list: cmdList, listvideo: cmdListVideo, genimg: cmdGenImage };

async function main() {
  const [cmd, gwId, ...args] = process.argv.slice(2);
  if (!cmd || !gwId) throw new Error('usage: smoke.ts <cmd> <gateway> [...]');
  const logger = new Logger('none', 'logs');
  await logger.init();
  // Shape-checked like the server's own keys, so a token file pointing at the wrong file is not sent.
  const token = await resolveApiKey({ type: 'file', value: join(ROOT, DEFAULT_TOKEN_FILES[gwId as GatewayId]) });
  log(`[${gwId}] token length=${token.length}`);
  const gw = createGateway(gwId as GatewayId, token, logger);

  const run = COMMANDS[cmd];
  if (!run) throw new Error(`unknown cmd: ${cmd}`);
  await run({ gw, gwId, args });
}

main().catch((e) => {
  console.error('SMOKE ERROR:', e?.stack ?? e);
  process.exit(1);
});

# AGENTS.md

Guidance for working **on** this codebase. User-facing install/usage: `README.md`. Per-tool behaviour:
`docs/TOOLS.md`. Every external HTTP contract (gateways, Tinify, BiRefNet recipe, ONNX providers, MCP SDK,
clients): `docs/API-NOTES.md`; read it **before** editing a gateway/media client or debugging an API call.

`ai-image-router-mcp` is an ESM, strict-TypeScript **MCP server** (the official v2 split packages
`@modelcontextprotocol/server` + `/client` + `/node`, Node ≥ 20.6). It routes image generation, image-to-video and text-to-video across four gateways (OpenRouter,
Mistral, Eden AI, fal.ai) and does local media work: background removal (ONNX), animated GIF, ICO/icon sets,
crop/resize/convert (sharp, ffmpeg, optional Tinify).

## Commands

```bash
npm run build              # tsc -> dist/
npm run dev                # run from source (tsx src/index.ts)
npm run typecheck          # tsc --noEmit; must stay clean after every edit
npm test                   # unit + integration:nonpayment (node:test via tsx; no network, no cost)
npm run integration:paid   # live, billed API tests in tests/paid/; never part of npm test
npm run trellis            # structural-debt audit (read-only, offline); needs Bun on PATH
npm run configure          # interactive wizard -> config.json
npm start                  # stdio;  npm start -- --http  for Streamable HTTP
```

Dev harnesses live in `scripts/` (catalog: `scripts/CLAUDE.md`).

## Keep docs in sync (in the same change)

| Change | Update |
|---|---|
| Add/rename a tool, change its params or behaviour | `README.md` Tools table, `docs/TOOLS.md`, the tools → files line below |
| Gateway/dependency contract (endpoint, field, response shape, quirk) | `docs/API-NOTES.md`, plus a one-line Gotcha here if it's a trap |
| Config field, wizard step, env var | `docs/CONFIGURATION.md` (+ README Configuration table for common fields) |
| MCP client config or quirk | `docs/MCP-CLIENTS.md` |
| Version or package name | `package.json` + `server.json` (version appears twice); `tests/manifests.test.ts` checks they agree |
| Leaderboard refresh (~quarterly) | `data/leaderboards/*.json` per `docs/UPDATING-LEADERBOARDS.md` (JS-rendered pages: use a browser); bump each `captured` |

`data/leaderboards/*.json` is the top-10 the wizard flags as "Nth best as of `<date>`";
`data/aspect-ratios.json` is the wizard's fallback preset list when a gateway advertises none.

## Layout (the non-obvious parts)

Request flow: tool handler (`src/tools/*`) reads `runtime.config`/`runtime.gateway` → typed request →
gateway client (direct REST) → media saved to `runtime.outputDir()` → `{ content }`.

- `state/runtime.ts`: the `runtime` **singleton** is the single source of truth at runtime (config, tokens,
  gateway, logger, health, bg remover, async jobs). `runtime.removerFactory` is a test seam.
- `config/schema.ts`: zod `AppConfig` is the single config definition (`config.json` is git-ignored and holds
  secrets). `config/paths.ts`: `PROJECT_ROOT` = shipped code + data (`fromRoot`); `APP_HOME` = per-user state
  (`AIR_MCP_HOME`, else `~/.ai-image-router-mcp` when installed under node_modules, else the repo;
  `resolvePath`/`fromHome`).
- `server.ts` `buildServer()` runs **per connection** (per stdio process / HTTP session).
  `instrumentToolLogging` wraps `registerTool` and must be installed before any registration.
- `tools/generateImageRequest.ts` holds the tool-level pre-billing refusals, in order. `tools/video.ts`
  `runVideoGeneration` is the one submit→render flow for both video tools. `tools/jobs.ts`
  `pollGenerationJob` is the one never-throwing poll for all three generation tools.
- `gateways/openrouterImages.ts` is the pure (unit-tested) half of the OpenRouter image API;
  `gateways/falModels.ts` is the per-model fal request-spec map.
- `util/mime.ts` `detectMedia` is **the** magic-byte detector: add formats there only. `util/http.ts` owns
  retries (see Gotchas).
- `bgremoval/models.ts` holds the model catalog and the one execution-provider resolution
  (`resolveExecutionProvider`/`plannedProviders`) shared by runtime, wizard and `health_status`.

Tools → files (`src/tools/`): `generate_image` → `generateImage{,Schema,Request,Render}.ts` ·
`image_to_video` → `imageToVideo.ts` · `generate_video` → `generateVideo.ts` · `remove_background` →
`removeBackground.ts` · `crop_media`, `transform_media` → `mediaEdit.ts` · `build_icon_set` → `iconSet.ts` ·
`health_status`, `restart`, `shutdown` → `lifecycle.ts`.

Configured "model" per gateway: Mistral = the **orchestrator LLM** (the image engine is fixed); Eden =
`edenProvider` + model; fal = the bare endpoint id (`krea/v2/large/text-to-image`).

## Conventions & invariants

- **Direct REST only; never add a vendor SDK** (no OpenRouter/Mistral/Eden/fal/Tinify packages). This is an
  explicit user requirement. Auth is hand-rolled from the token files.
- **zod is `^4.2.0`**: the v2 MCP packages require Zod 4 (`zod ^4.2.0`), so the old `^3.25` invariant is
  retired. Zod 4 gotcha: `.default({})` on an object returns `{}` verbatim instead of filling inner
  defaults (Zod 3 did fill them); config defaults use `.prefault({})` to keep the fill-in behavior.
- **Never write to stdout** except MCP protocol frames. Log through `runtime.logger` (stderr).
- `onnx-proto` loads only through the dynamic `import('./cascade.js')` in `birefnet.ts` (first WebGPU use of
  a BiRefNet model). Never import `cascade.js` statically: it would load on every startup.
- New gateway-specific request fields go through `provider_options`/`extra`, not hard-coded per model.
- **Tool failures return `errorResult(describeError(err))`**, never throw. Hints are plain `text` blocks
  tagged `_meta['ai-image-router/category']:'possibleCause'`, from the optional `Gateway.diagnoseFailure`
  (catch blocks `await` it with `.catch(() => [])`). No `structuredContent`, no custom content types.
- **Never print a full API key** (hints use a masked `keyIdentifier`). HTTP failure logs carry response
  bodies and URLs only, never auth headers or request bodies.
- Media: save to `runtime.outputDir()` and return a `resource_link` plus a small inline preview (the default
  `filePath` mode never inlines video). `output_mode` is only `filePath|base64`: MCP has no raw-bytes channel.
- **Handlers read `runtime.gateway`/`runtime.config` at call time**, never a value captured at registration.
  Anything derived from config at registration (schema, description, enabled state) is re-derived on
  `restart` via `refreshOnReload` (`tools/reloadable.ts`). Gated tools are always registered and
  `disable()`d when they don't apply. `image_to_video` is never gated: its gif mode is local.
- **`restart` is atomic** (`runtime.applyConfig`): resolve everything that can fail into locals, then commit
  in one synchronous step, so a failed reload leaves the previous config, gateway and tokens fully active.
  The ONNX session must be `release()`d (dropping the reference leaks 1–4 GB of native memory). A remover
  init that finishes after a restart is stale and must not install itself.
- **Read ONNX outputs through `tensorToFloat32`** (`birefnet.ts`), never cast to `Float32Array`:
  onnxruntime-node returns an fp16 output as a `Uint16Array` of raw bits (this was the BEN2 "seams" bug).
- **Keep `npm run trellis` low**: cyclomatic complexity > 10 counts as an eroded function, so split a growing
  handler into named steps (validate → resolve → submit → render).

## Gotchas

### HTTP and billing
- **A POST is never re-sent after an ambiguous failure** (timeout, reset, 5xx, unparseable 200): the
  provider may already be billing it. POSTs retry only on 429 or a connection that never opened
  (`requestNeverSent`). Pass `idempotent:true` only for a POST that is harmless to repeat. Any extra retry
  lives in the gateway, explicit and bounded. Full rule: `docs/API-NOTES.md`.

### OpenRouter
- Images use `/api/v1/images`, not `/chat/completions`. The body is built from the model's live
  `supported_parameters` (`/images/models/{id}/endpoints`; absent key = unsupported), persisted by
  `FileCapabilityCache`. `imageResolutions` returning `{values:[], source:'api'}` means "the API says there
  is no resolution parameter", which is not the same as `null`. Inspect a model with
  `npx tsx scripts/or-image-caps.ts <id>`.
- Explicit `width`+`height` go out as `size:"WxH"` alone (combining it with `aspect_ratio`/`resolution`
  400s). On a minimum-pixel-budget rejection the gateway retries once without `size`, at
  `nearestAspectRatio`, not the configured default.
- gpt-image-2.5 silently ignores `resolution` (dropped, with a `Note:`), and its `background` is
  `auto|opaque` only, so `transparent` is refused before billing. `background` never takes a hex colour (a
  colour maps to `opaque`; the hex stays in the prompt).
- A safety block is **HTTP 502** with no `finish_reason`. Deterministic failures (moderation `reasons`,
  deterministic `error_type`) are sent once. Upstream failures (e.g. a BYOK quota) arrive as a **200 with an
  `error` body**: treat it as a deterministic error (`failOnErrorBody`), don't retry. In the
  capability-filter 400, only the "Provider rejections" clause names the offending parameter. OpenRouter's
  own 402 is never a BYOK cause.
- Video: each `frame_images[]` entry needs `type:"image_url"` (the docs omit it). Seedance 2.0 t2v returns
  500 when `duration`/`resolution` are sent; keep the core-only retry on 5xx.

### Eden AI
- Images: **sync** `/v3/universal-ai` only. The async endpoint answers 400 "Not an async feature".
- Video: the model goes in `providers:"<provider>/<model>"`. A top-level `model` is silently ignored, and the
  provider default runs and is billed. Eden doesn't validate models, so keep the pre-submit catalog check
  (a public endpoint: sending the v3 key gets a 401) and report the model from the poll's result key. The
  video URL is at `results["<provider>/<model>"].video_resource_url`.

### fal.ai
- Auth is `Authorization: Key <id>:<secret>`, not Bearer (the pair is one token). Use the
  `status_url`/`response_url` fal returns verbatim; reconstructing them 404s for sub-path models.
- A core-only resubmit happens only after a 422 (on submit or on the result), never after a submit 5xx or a
  poll failure, and is never silent (`warnings`). Put annotations in `GatewayHttpError.note`:
  `describeError` shows the provider message, not `err.message`.
- A job still running at the deadline is cancelled; a cancel answering `ALREADY_COMPLETED` means fetch the
  paid result. i2v sends one image: `image_last`/`reference_images` are refused before submitting.
- Request shapes differ per model (`falModels.ts`; entry order matters). The per-model reference gate is
  authoritative (Krea style references are `{image_url}` objects, not `{url}`). Safety overrides are sent only with
  `fal.relaxSafety`. fal ignores unknown fields and doesn't reliably honour size/format, so never rely on
  the request to control the output.

### Mistral
- Sampling args (`completion_args`) go on the agent at creation. `/v1/conversations` 422s on them when
  `agent_id` is set.

### HTTP transport and clients
- Auth is checked on every request, not just `initialize`. A failure is a **plain 401 with no
  `WWW-Authenticate`** on purpose: Le Chat would otherwise start OAuth discovery. An empty secret denies
  everything; only `null` means auth is off.
- The Host/Origin (DNS-rebinding) guard runs only while auth is off. Don't make it always-on: with a token
  set, a tunnel's public Host must pass.
- Vibe CLI rejects a `resource_link` whose `icons` is null. `normalizeResultForClients` adds `icons: []` to
  every result; keep it. Client facts: `docs/API-NOTES.md` → "MCP clients" and `docs/MCP-CLIENTS.md`.

### Async generation jobs (`wait:false` + `job_id`)
- Jobs run detached from `extra.signal` (they survive a client disconnect), are bound to the gateway captured
  at submit, and are in-memory only.
- **Render once**, eagerly at completion, memoised: every poll returns the identical reply (no duplicate
  files, no repeat Tinify bills).
- Failure hints are computed from the real error inside the background task, never from
  `new Error(job.error)` at poll time (the typed branches can't match it).
- **An unsaved result is never released**: it is the only copy of a paid generation. A failed render first
  rescues it to `<stem>-unsaved-<n>.<ext>`.

### Background removal
- BiRefNet and bria (same architecture) never run on DirectML (deform-conv `E_OUTOFMEMORY` regardless of free
  VRAM). They run on WebGPU only through the auto-generated cascaded `<file>-webgpu.onnx` (`cascade.ts`).
  `auto` = WebGPU on Windows. `create()` can succeed and `session.run()` still fail, so known-bad EPs are
  skipped up front (`usage[ep].runs === false`).
- Preprocessing must match each model's own training transform (`scaleMode` `imageMax` vs `div255`,
  `mean`/`std`, `needsSigmoid`), not a templated HF `preprocessor_config.json`. Decode once, EXIF-oriented
  (`decodeOrientedRgb`), and use the same pixels for model input and composite. The postprocess mitigations
  (`alphaFloor`/`tta`/`hysteresisSeed`) stay off by default.
- sharp resizes a raw 1-channel buffer into 3 channels: read the stride from
  `toBuffer({resolveWithObject:true}).info.channels`.
- Hugging Face downloads also fetch the repo's `config.json`, because HF counts downloads from it and the user
  wants model authors to see them. Don't add a download path that skips it.
- Downloads stream through `stream.pipeline`. The cascade writes temp + rename, because an existing
  `-webgpu.onnx` is reused forever.
- onnxruntime's native stderr warnings are benign (`logSeverityLevel: 3` suppresses most).
  `BG_NO_PREWARM=1` skips the startup model load for short-lived spawns. `BG_RAM_CHECK=off` skips the
  free-RAM guard.

### Media
- **GIF uses `gifenc` (mattdesl), not `@skyra/gifenc`**: skyra's quality knob doesn't move file size, so the
  palette-size knee can't work. Load it with `createRequire` (a static import resolves to `undefined`). Pass
  `quantize`/`applyPalette` a fresh exact-length `Uint8Array` (they ignore `byteOffset`). Alpha is 1-bit,
  `palette` and `repeat` go on the first frame only, and `delay` is in ms. Detail: `docs/API-NOTES.md`.
- **Tinify compress is format-preserving** (a "jpg → png" compress returned JPEG bytes): re-encode to PNG
  first and check the output's magic bytes (`assertProduced`). Tinify only ingests png/jpeg/webp/avif.
- sharp's default `fit` is `cover` (it crops), so downsizing uses `fit:'inside'`. ffmpeg mp4 output
  re-encodes audio to AAC (`-c:a copy` fails for PCM/Vorbis). ffmpeg/ffprobe on PATH are needed only for
  video work.
- Magic bytes are authoritative: never trust a `content-type` or a data: URL's declared mime. Raw base64 is
  recognised by content before the path heuristic (`/` is a base64 character). `sniffImageMime` defaults to
  png, so never validate with it (use `detectImageMime`). Generation is refused unless **all** reference
  images resolve.
- `transform_media` returning an un-Tinified PNG as base64 keeps `<stem>-original.png`; a video→still PNG is
  Tinified in place with no `-original`. Don't unify the two.
- **ICO**: read with our own `parseIco` (`@fiahfy/ico`'s parser only handles 32-bpp DIB entries); write with
  `@fiahfy/ico` as 32-bpp DIB + AND mask (widest OS compatibility). Widen `Ico.supportedIconSizes` with
  `.splice()`, never reassign it. Tools go through `media/ico.ts`, never `@fiahfy/ico` directly. sharp can't
  decode ICO.
- **Three ICO contracts; don't blur them.** `generate_image` ico resizes one render (square by default,
  downscale only, keeps `-original.png`). `transform_media` ico validates and merges, never resizes.
  `build_icon_set` derives a declared set from one master and writes nothing until every size is derived and
  verified.
- Squaring defaults to `pad` (a centre crop deleted off-centre subjects); surface the returned `note` in the
  result.
- `palette`/`exclude`/`background` are compiled once into the prompt, so every gateway gets them; native
  fields are additive. `reference_mode` `subject` and `style` are not interchangeable. The schema accepts both
  on purpose so the handler can refuse with a useful message.

## Validating changes

- `npm test` runs `unit` then `integration:nonpayment`. Both are **explicit file lists in `package.json`**: a
  new test file runs only after you add it to one of them.
- Use `tests/helpers/mcp.ts` (`startMcpHarness`: fake gateway + real server over an in-memory client) instead
  of hand-rolling client/server setup.
- Async is the default, so a test or harness that needs a blocking result passes `wait:true` (or sets
  `config.async=false`).
- Paid tests (`tests/paid/`, see its README) fail fast without a token, use the cheapest model that exercises
  the path, and save artifacts to `output/`.
- Live checks cost money, so be deliberate. Read the saved image. Composite cutouts over a solid colour
  (`sharp(out).flatten({background:'#00ff88'})`); for model/postprocess tuning, build a labelled side-by-side
  montage over magenta. For video, extract a frame with ffmpeg and check dimensions with ffprobe.
- **Save every test-run artifact to `output/`** (not the scratchpad), named with model + config. This is a
  user preference.

## Extending

- **Tool**: `src/tools/<x>.ts` exporting `register<X>(server)`, registered in `server.ts` (through
  `registerGated` if it depends on capability or config). Update the docs per the sync table.
- **Gateway**: implement `Gateway` (`gateways/types.ts`), add it to `registry.ts` and `GATEWAYS` in
  `config/schema.ts`, and document the contract in `docs/API-NOTES.md`.
- **Background model**: add it to `BG_MODELS` + `BgModelKey` (`bgremoval/models.ts`), the config enum in
  `schema.ts`, and `BG_MODEL_ORDER` (`config/wizardLocal.ts`); measure `usage` with `scripts/ram-test.ts`.
  First confirm the real I/O contract (scale and normalisation from the model's own training transform, and
  the output dtype). Don't add postprocess to paper over a preprocessing or decode mistake.

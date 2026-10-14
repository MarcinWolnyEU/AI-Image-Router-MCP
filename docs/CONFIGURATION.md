# Configuration

The setup wizard writes `config.json`. Every field has a default, so a hand-written file needs only `gateway` and `token`.

## Where files live

| What | npm package | Checkout |
|---|---|---|
| `config.json`, token files, `models/`, `logs/`, `output/`, `.cache/` | `~/.ai-image-router-mcp` | the project folder |
| Shipped code and data (`dist/`, `data/`) | inside `node_modules` | the project folder |

`AIR_MCP_HOME` moves the first row anywhere. `AIR_MCP_CONFIG` points at a single `config.json` somewhere else; relative paths inside it still resolve against the data directory. Empty values count as unset.

## The setup wizard

Run it with `npx -p ai-image-router-mcp ai-image-router-mcp-configure` (or `npm run configure` in a checkout). It walks through:

1. **Gateway**: OpenRouter, Mistral, Eden AI or fal.ai.
2. **Token source**: it detects a default token file in the data directory, or you can paste the token or name an environment variable.
3. **Image model**, pulled live from the gateway API. Models that appear in the Artificial Analysis leaderboard top 10 are marked `⭐ #N` and floated to the top, best rank first. Ranked models the gateway does not offer cannot be selected, so the wizard prints a note listing them. See [UPDATING-LEADERBOARDS.md](UPDATING-LEADERBOARDS.md) for how those lists are refreshed.
4. **Default aspect ratio**, from the API or from a curated preset list with explanations (default `4:3`).
5. **Default resolution**, from the API, defaulting to the highest. The question is skipped for a model with no resolution parameter.
6. **Sync or async** for each generation type, right after the model is chosen. Async (the default) returns a `job_id` to poll. Sync blocks until the result is ready. A per-call `wait: true` or `wait: false` overrides it.
7. **Image to video and text to video**, if the gateway supports them: model, sync or async, fps, resolution, duration. Whether an image-to-video model accepts several reference images comes from the gateway and is not asked.
8. **Background removal**: the execution provider first (`auto`, `cpu`, `dml`, `webgpu`, `cuda`, `coreml`), then a model. The wizard shows your free RAM and VRAM and annotates each model with its measured memory use on that provider and whether it runs there at all.
9. **fal safety settings** (fal only): whether to relax fal's safety checker. The default is no.
10. **Tinify**: optional token for PNG compression and WebP/AVIF output.
11. **Logging and output**: log policy (`none`, `today`, `persistent-daily`), output folder, inline previews.
12. **Transport**: stdio (recommended) or HTTP, with an optional generated bearer token saved as `mcp http token.txt`.

The result goes to `config.json` together with a `diagnostics` block that records any errors or missing data hit while pulling model lists. `health_status` shows it.

Running the wizard again with an existing `config.json` pre-selects your current settings for every prompt, so you can press Enter through the ones you want to keep. Switching to a different gateway resets the gateway-specific choices (model, token, aspect ratio, resolution, video) to their defaults, because the old selections no longer apply.

## Background removal models

| Model | Notes |
|---|---|
| `birefnet-general` (default) | Best quality. About 7.5 GB RAM on CPU (about 25 s). On WebGPU the server converts it once to a GPU-compatible variant on first use (about 7 to 8 s). Does not run on DirectML, so `dml` falls back to CPU. |
| `birefnet-massive` | Broader training set. Same resource profile as general. |
| `bria-rmbg` | BRIA RMBG-2.0. Same resource profile as BiRefNet. |
| `isnet-general-use` | Lighter. About 1 GB RAM, runs on every provider (WebGPU about 2.5 s). |
| `ben2-base` | MIT-licensed, higher quality than IS-Net. About 4 GB RAM, runs on every provider. |
| `finegrain-box-segmenter` | MIT-licensed MVANet (Finegrain), int8-quantized with fp16 activations. Small: a 117 MB download, about 1.2-1.6 GB VRAM and about a second per image on WebGPU/DirectML/CUDA. It is a GPU model: on CPU it takes about 14 s. |
| `none` | Disables `remove_background`. |

`auto` resolves to WebGPU on Windows, CoreML on macOS, CUDA on Linux x64 and CPU elsewhere. A provider the bundled ONNX Runtime does not ship for your platform (CUDA is Linux x64 only, CoreML is macOS only, DirectML is Windows only) is not offered and falls back to CPU. If free RAM is too low, the tool fails with a message saying how much it needs and how much you have. `BG_RAM_CHECK=off` skips that check.

## `config.json` reference

| Key | Notes |
|-----|-------|
| `gateway` | `openrouter`, `mistral`, `edenai` or `fal`. |
| `token` | `{ "type": "file" \| "inline" \| "env", "value": "..." }`. An empty value (blank inline string, empty env var, empty file) is a configuration error. |
| `fal` | `relaxSafety` (default `false`). When `true`, fal image requests carry `enable_safety_checker: false` and `safety_tolerance: "5"` (the most permissive level) on the models whose schema has those fields. When `false`, nothing is sent and fal's own defaults apply. A `provider_options` value on a call always wins over both. Ignored for the other gateways. |
| `image` | `model`, `edenProvider`, `defaultAspectRatio`, `defaultResolution` (not sent to a model with no resolution parameter, such as gpt-image-2.5), `async` (default `true`), and the supported lists. `width` in pixels is the size lever, and `output_format: "ico"` uses it as the square icon size (default `256`). |
| `imageToVideo`, `textToVideo` | `enabled`, `model`, `defaultFps`, `defaultResolution`, `defaultDuration`, `async` (default `true`), and `multiReference` for image to video. |
| `backgroundRemoval` | `model` (`none`, `birefnet-general`, `birefnet-massive`, `bria-rmbg`, `isnet-general-use`, `ben2-base`, `finegrain-box-segmenter`), `executionProvider` (`auto`, `dml`, `cuda`, `coreml`, `webgpu`, `cpu`), `modelsDir`. |
| `tinify` | `{ "token": { ... } }` or `null`. When set, enables PNG compression and WebP/AVIF output. |
| `logging` | `policy` (`none`, `today`, `persistent-daily`) and `dir`. |
| `output` | `dir`, `inlinePreview`, `previewMaxBytes`. |
| `mistralAgentModel` | The orchestrator model that drives Mistral's image generation tool (default `mistral-medium-latest`). |
| `http` | See below. |
| `diagnostics` | Wizard timestamp and recorded issues. Written by the wizard, read by `health_status`. |

## HTTP transport

```bash
npm start -- --http                       # checkout
npx -y ai-image-router-mcp --http         # npm package
```

The endpoint is `http://<host>:<port>/mcp` (default `127.0.0.1:8765`). Setting `http.enabled: true` makes HTTP the default transport, so stdio registrations stop connecting.

| Field | Default | Description |
|---|---|---|
| `enabled` | `false` | Serve HTTP when started without `--http`. |
| `host`, `port` | `127.0.0.1`, `8765` | Bind address. |
| `authToken` | `null` | `{ "type", "value" }`. When set, every request needs `Authorization: Bearer <token>` or `X-API-Key: <token>`, and anything else gets a plain `401`. Set one before exposing the port beyond localhost, because the tools read and write local paths. |
| `allowedHosts` | `[]` | Extra hostnames accepted in `Host` and `Origin` while no token is set. |
| `sessionIdleMinutes` | `30` | Close a session after this long without a request. |

Without a token the server still refuses requests whose `Host` or `Origin` names a foreign domain (`403`). This guards against DNS rebinding, where a malicious web page reaches `127.0.0.1` through its own domain and drives the tools from your browser. Loopback names and IP literals always pass. With a token set the check is skipped, so a tunnel's public hostname works.

A client using an expired session id gets a `404` and re-initializes, as the MCP specification prescribes.

## Environment variables

| Variable | Description |
|---|---|
| `AIR_MCP_HOME` | Data directory (see above). |
| `AIR_MCP_CONFIG` | Path to a `config.json`. |
| `BG_NO_PREWARM` | `1` skips loading the background-removal model at startup (it still loads on first use). Set it for clients that start a fresh process per call. |
| `BG_RAM_CHECK` | `off` skips the free-RAM check before background removal. |
| `BG_ALPHA_FLOOR`, `BG_TTA`, `BG_HYST_SEED` | Per-image background-removal postprocessing overrides, off by default. See the notes in `CLAUDE.md` before touching them. |

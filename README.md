<!-- mcp-name: io.github.MarcinWolnyEU/ai-image-router-mcp -->

# AI Image Router MCP

[![CI](https://github.com/MarcinWolnyEU/ai-image-router-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/MarcinWolnyEU/ai-image-router-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/ai-image-router-mcp)](https://www.npmjs.com/package/ai-image-router-mcp)
[![Node.js](https://img.shields.io/node/v/ai-image-router-mcp)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/MarcinWolnyEU/ai-image-router-mcp/blob/main/LICENSE)
[![TypeScript: strict](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.MarcinWolnyEU%2Fai--image--router--mcp-informational)](https://registry.modelcontextprotocol.io/)

An MCP server that gives an AI agent everything it needs to produce and prepare images for a website. It generates images, animates stills, generates videos, icons, does a bit of processing & more, all through one of four gateways ([OpenRouter](https://openrouter.ai/), [Mistral AI](https://mistral.ai/), [Eden AI](https://www.edenai.co/) or [fal.ai](https://fal.ai/)).

> **Note:** this project is not affiliated with OpenRouter, Mistral, Eden AI, fal.ai or Tinify. It is a solo project that routes to their public APIs.

## Capabilities

- **Image generation**: one tool, four gateways. The tool's schema is built from the configured model, so an agent only sees options the model supports (quality tiers, resolutions, reference images, transparent backgrounds).
- **Image to video and text to video**: the gateway's own models, run as background jobs so a slow render never trips a client timeout.
- **Background removal**: runs locally with ONNX Runtime (BiRefNet, BRIA RMBG-2.0, IS-Net, BEN2, Finegrain box segmenter). No upload, no per-image cost.
- **Animated GIFs**: assembled locally from ordered frames, with per-frame timing and an automatic palette size that balances quality against file size.
- **Favicons and icon sets**: single-size and multi-size `.ico` files, a whole declared set derived from one master, and unpacking an existing `.ico` into PNGs.
- **Crop, resize, convert**: images with sharp, video with ffmpeg. Optional [Tinify](https://tinify.com/) compression and WebP/AVIF output.
- **Colour and content constraints**: pin a palette, exclude elements, require a background, then get the result measured against what you asked for.
- **Honest errors**: gateway failures come back explained (status meaning, offending parameter, moderation reasons) with hints about account settings that commonly cause them.

## Try it

```text
Generate a 1536x1024 hero image of a foggy harbor at dawn, then cut out the lighthouse as a transparent PNG.
```
The agent calls `generate_image`, then `remove_background` on the saved file.

```text
Make a favicon from logo.png with 16, 32, 48 and 256 px in one .ico. Use mark-only.png for the 16 and 32 sizes.
```
`build_icon_set` derives every size from the sources you name, checks that the `.ico` holds exactly that set, and only then writes files.

```text
Turn these four PNG frames into a looping GIF at 8 fps and keep it under 500 KB if the palette allows.
```
`image_to_video` with `output_format: "gif"` assembles it locally, no gateway call.

```text
Animate hero.png into a 5 second 1080p clip with a slow push-in.
```
The job is submitted in the background; the agent polls it with the returned `job_id` and the video lands in your output folder.

## Quickstart

You need Node.js 20.6 or newer and an API token from at least one gateway: [OpenRouter](https://openrouter.ai/), [Mistral](https://mistral.ai/), [Eden AI](https://www.edenai.co/) or [fal.ai](https://fal.ai/). The wizard accepts a token file, an environment variable or a pasted value.

**1. Run the setup wizard once.** It asks for the gateway, your token and a model, and writes `~/.ai-image-router-mcp/config.json`:

```bash
npx -p ai-image-router-mcp ai-image-router-mcp-configure
```

Use a terminal with real keyboard input (PowerShell, Windows Terminal, macOS Terminal, any Linux terminal). The wizard uses arrow-key menus.

**2. Register the server with your MCP client.** This exact JSON works in Claude Desktop and Cursor:

```json
{
  "mcpServers": {
    "ai-image-router": {
      "command": "npx",
      "args": ["-y", "ai-image-router-mcp"]
    }
  }
}
```

Claude Code, VS Code and others use a different format: see [Client configuration](#client-configuration).

**3. Check it.** Ask the agent to call `health_status`. It reports the active gateway, the configured models, the background-removal provider and any problem the wizard recorded.

If you are an LLM or need more detail, keep reading.

## How it works

```
MCP client ──stdio──▶ ai-image-router-mcp (one process per client session)
                         ├─ gateway client ──REST──▶ OpenRouter | Mistral | Eden AI | fal.ai
                         ├─ local tools: ONNX background removal, sharp, gifenc, ffmpeg
                         └─ output folder: every result is saved to disk first
```

A tool call reads the current configuration, builds a validated request, calls the gateway, saves the result to the output folder and returns the file path as a `resource_link` with a small inline preview. Large video is never inlined.

Generation runs as an in-process background job by default. The tool returns a `job_id` straight away, and calling it again with that id polls the job. The result is written to disk the moment the job finishes, even if nobody polls, and every later poll returns the same files. Jobs live in memory, so restarting the server drops jobs that are still running.

The `restart` tool reloads `config.json` without dropping the connection. The change is all or nothing: if the new configuration cannot be applied (a missing token file, say), the old one stays fully active.

## Supported gateways

| Gateway | Image generation | Text to video | Image to video |
|---------|:---------------:|:----------:|:-----------:|
| [OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/image-generation) | yes (`/images`, reference images via `input_references`) | yes (`/videos`, async) | yes (frame images) |
| [Mistral AI](https://docs.mistral.ai/agents/connectors/image_generation/) | yes (Agents `image_generation`, FLUX1.1 [pro] Ultra) | no | no |
| [Eden AI](https://www.edenai.co/docs/api-reference/universal-ai/universal-ai) | yes (`/v3/universal-ai`, sync) | yes (`/v2/video/generation_async`; a `model` override is checked against Eden's public catalog before anything is submitted) | yes (single and multiple references) |
| [fal.ai](https://fal.ai/docs) | yes (queue: FLUX 2 Pro, FLUX 1.1, Recraft, Cosmos, Krea 2, Ideogram) | yes (queue: Veo, Kling and others; not Cosmos) | yes (queue: Cosmos 3, single image) |

Pick one gateway per configuration. `generate_video` only appears when the active gateway supports text to video, so Mistral never lists it. Request shapes, endpoints and the quirks found along the way are written down in [docs/API-NOTES.md](docs/API-NOTES.md).

## When not to use it

- **Hosted, multi-user deployments**: the tools read and write the local disk of the machine running the server. It is built for one person's workstation.
- **Machines with little RAM**: background removal with BiRefNet or BRIA needs about 7.5 GB free RAM. IS-Net needs about 1 GB. The setup wizard will inform you about the constrains.
- **Image editing with masks or inpainting**: the generation tools take prompts and reference images, nothing too fancy yet.

## What it exposes

An agent connected to this server can spend your gateway credit, write files into the output folder and read any image or video path you or the agent hands it. Connect only MCP clients you trust.

Prompts and reference images are sent to the gateway you chose, and nowhere else. Background removal, GIF assembly, icon building, cropping and (without a Tinify key) format conversion run locally. With a Tinify key, images you compress or convert are uploaded to Tinify.

Tokens come from a file, an environment variable or the config file itself. They are never logged and never returned in tool results, and `health_status` shows only where a token came from. Log files collapse base64 payloads and data URLs, so they stay small and do not contain image data.

**fal.ai safety settings stay at fal's defaults.** The server sends no safety overrides, so fal's own checker and tolerance apply. You can opt in to relaxed settings with `fal.relaxSafety` (see [Configuration](#configuration)). Turning it on sends `enable_safety_checker: false` and `safety_tolerance: "5"` to the fal image models that accept those fields. You are responsible for what you generate with it enabled. Other gateways apply their own moderation and the server does not try to bypass it.

The HTTP transport is off by default. If you turn it on, set a bearer token before exposing the port beyond localhost. See [Security](#security).

There is no analytics and no telemetry. The only network calls are to the gateway you configured, Tinify if you enabled it, and GitHub (or Hugging Face for BEN2 and the Finegrain box segmenter) when a background-removal model is downloaded for the first time. The download is between 117 MB and 1 GB and is checked against a stored hash. A model from Hugging Face also gets its repo's small `config.json` fetched into the models folder (overwriting the one a previous Hugging Face model left there), because that request is how Hugging Face counts a download for the model's authors.

## Tools

| Tool | What it does |
|------|--------------|
| `generate_image` | Generate images from a prompt, with optional reference images, palette and exclusion constraints, Tinify output formats, or a single-entry `.ico`. |
| `image_to_video` | Animate stills with the gateway (`mp4`), or assemble supplied frames into an animated GIF locally (`gif`, no cost). |
| `generate_video` | Text to video. Offered only when the active gateway supports it. |
| `remove_background` | Local background removal to a transparent PNG. Offered unless the model is set to `none`. |
| `crop_media` | Crop an exact pixel region from an image or video. |
| `transform_media` | Downsize, convert format, extract a still from a video, batch several images, build or unpack `.ico` files. |
| `build_icon_set` | Derive a whole declared icon set from one master, emit each size as a file and assemble a verified `.ico`. |
| `health_status` | Gateway, models, execution provider, memory, logging and recorded problems. |
| `restart` | Reload `config.json` without dropping the connection. |
| `shutdown` | Flush logs and stop the process. |

Parameters, output shapes and behavior notes for every tool are in [docs/TOOLS.md](docs/TOOLS.md). Every media tool accepts `output_mode`: `filePath` (default, saves and returns the path) or `base64` (also saves, then returns the bytes inline).

## Client configuration

The examples start the server with `npx`. Run the [setup wizard](#quickstart) first.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings, Developer, Edit Config):

```json
{
  "mcpServers": {
    "ai-image-router": {
      "command": "npx",
      "args": ["-y", "ai-image-router-mcp"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add ai-image-router -- npx -y ai-image-router-mcp
```

Add `--scope user` to make it available in every project, or `--scope project` to write a shareable `.mcp.json`.

### VS Code

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "ai-image-router": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "ai-image-router-mcp"]
    }
  }
}
```

### Cursor

Create `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "ai-image-router": {
      "command": "npx",
      "args": ["-y", "ai-image-router-mcp"]
    }
  }
}
```

The repository is also a Cursor plugin ([`.cursor-plugin/plugin.json`](.cursor-plugin/plugin.json) and [`mcp.json`](mcp.json)). The plugin runs the same `npx` command and offers two optional variables, `AIR_MCP_CONFIG` and `AIR_MCP_HOME`, for keeping the configuration somewhere other than `~/.ai-image-router-mcp`.

### Pi, Le Chat, Mistral Vibe and others

Setup for Pi, Le Chat (custom connector over HTTP) and Mistral Vibe CLI is in [docs/MCP-CLIENTS.md](docs/MCP-CLIENTS.md). Any client that can launch a stdio command works with `npx -y ai-image-router-mcp`.

### From a checkout

```bash
git clone https://github.com/MarcinWolnyEU/ai-image-router-mcp.git
cd ai-image-router-mcp
npm install
npm run build
npm run configure
```

Then point your client at the built entry point, using the absolute path of your clone:

```json
{
  "mcpServers": {
    "ai-image-router": {
      "command": "node",
      "args": ["/absolute/path/to/ai-image-router-mcp/dist/index.js"]
    }
  }
}
```

A checkout keeps its configuration, token files, models, logs and output inside the project folder. The npm package keeps them in `~/.ai-image-router-mcp`.

## Configuration

The wizard writes `config.json`, and every field has a default, so a hand-edited file only needs `gateway` and `token`. The full field reference is in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

Wizard was designed to be re-run. If you already have a configuration, you can just smack \[enter] all the way through (except the things you want to change) - it will leave it all as-was.

Environment variables:

| Variable | Description |
|---|---|
| `AIR_MCP_HOME` | Directory for config, token files, models, logs and output. Defaults to `~/.ai-image-router-mcp` for the npm package and to the project folder for a checkout. |
| `AIR_MCP_CONFIG` | Path to a `config.json` outside the home directory. |
| `BG_NO_PREWARM` | Set to `1` to skip loading the background-removal model at startup. It still loads on first use. Short-lived stdio clients should set it. |
| `BG_RAM_CHECK` | Set to `off` to skip the free-memory check before background removal. |

Empty values count as unset, so an unfilled variable in a client config does no harm.

## Security

### Credentials

- Gateway tokens are read from an environment variable, the config file, or a dedicated .txt file (useful if you frequently swap tokens within the same provider), and held in memory. They are not logged, not echoed in errors and not part of any tool result.
- The server never forwards an inbound HTTP token upstream.
- Keep token files out of version control. A checkout's `.gitignore` already excludes `config.json` and `*.txt`.

### HTTP transport

Stdio is the default and needs no network listener. The Streamable HTTP transport (`npm start -- --http` or `npx -y ai-image-router-mcp --http`) is meant for connectors that cannot spawn a process.

- With `http.authToken` set, every request needs `Authorization: Bearer <token>` or `X-API-Key: <token>`. Failures get a plain `401`. A token that resolves to an empty string stops the server from starting instead of silently running without auth.
- With no token, requests whose `Host` or `Origin` names a foreign domain get a `403`. This blocks DNS rebinding, where a web page reaches `127.0.0.1` through its own domain. Loopback names and IP literals pass. Add other names with `http.allowedHosts`.
- Unknown or expired session ids get a `404` so the client re-initializes. Sessions idle for `http.sessionIdleMinutes` (default 30) are closed. Request bodies over 64 MiB get a `413`.

### Threat model

| Threat | Mitigation | Residual risk |
|---|---|---|
| Someone else spends your gateway credit through an exposed HTTP port | HTTP is off by default. Token auth when enabled. Host and Origin checks while no token is set. | A token on a tunnel is only as private as the tunnel. |
| A web page drives the local HTTP server from your browser | `Host` and `Origin` validation (DNS-rebinding guard). | A wildcard-like `allowedHosts` entry weakens it. |
| Token leakage through logs or errors | Tokens are never logged. Base64 and data URLs are collapsed in logs. | Your own client or proxy may log tool arguments. |
| A prompt-injected model asks for a file it should not touch | Tools only open the paths and URLs the caller names, and refuse non-image content by magic bytes. | The server runs with your user's file permissions. Do not give an agent that reads untrusted content other powerful tools without review. |
| Cost amplification (large `n`, many video jobs) | Requests are validated before they are billed. A POST that may have started a billed generation is never re-sent after an ambiguous failure. | One call can still be expensive. Use the gateway's spending limits. |
| A crafted image, ICO or video | Decoders check sizes before allocating. Background removal checks free RAM first. | Native decoders (sharp, ffmpeg, ONNX Runtime) are third-party code. Keep them updated. |

To report a vulnerability, use a [private security advisory](https://github.com/MarcinWolnyEU/ai-image-router-mcp/security/advisories/new), not a public issue. See [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No configuration found at ...` | Run the setup wizard (`npx -p ai-image-router-mcp ai-image-router-mcp-configure`, or `npm run configure` in a checkout). |
| The wizard says it needs an interactive terminal | Run it in PowerShell, cmd, Windows Terminal or any real terminal. In Git Bash use `winpty`. |
| `Token file not found` | The token file path in `config.json` is wrong. Relative paths resolve against the data directory (`~/.ai-image-router-mcp` or the project folder). |
| `generate_video` is missing from the tool list | The active gateway has no text to video (Mistral), or `textToVideo.enabled` is false. |
| `remove_background` is missing | `backgroundRemoval.model` is `none`. |
| `needs ~N GB free, you have Y GB` | The background model does not fit in free RAM. Close other programs, pick `isnet-general-use`, or set `BG_RAM_CHECK=off` if you know better. |
| Video crop or conversion fails with an ffmpeg message | Install [ffmpeg](https://ffmpeg.org/) and put it on your `PATH`. Image tools do not need it. |
| A generation fails with a 404 about guardrails or data policy (OpenRouter) | An account setting excludes every provider for that model. The error names the likely setting, usually **Ignored Providers** or a Zero Data Retention requirement at `openrouter.ai/settings/privacy`. |
| A generation fails with a quota error although OpenRouter shows credit | The key may have **Include BYOK** enabled, so the request is routed through an upstream key that is out of quota. The error names the key (masked). |
| `job not found` when polling | The server restarted and dropped the in-memory job. Submit again. |
| HTTP client gets `403` | The `Host` or `Origin` is not allowed. Set `http.authToken`, or add the name to `http.allowedHosts`. |
| Le Chat shows tools but you cannot open results | Paths are on the server's disk. Ask for `output_mode: "base64"`. |
| Nothing appears in the client | Run `npx -y ai-image-router-mcp` in a terminal and read stderr. Never expect output on stdout; it carries the protocol. |

## Development

You need Node.js 20.6 or newer.

```bash
git clone https://github.com/MarcinWolnyEU/ai-image-router-mcp.git
cd ai-image-router-mcp
npm install
npm run dev          # run the server from source with tsx
```

The quality gates, all run in CI:

```bash
npm run typecheck                 # tsc --noEmit, strict
npm run build                     # tsc -> dist/
npm test                          # unit + integration:nonpayment, no network, no cost
```

- `npm run unit` runs the pure unit tests. `npm run integration:nonpayment` runs the real subsystems (sharp, ffmpeg, gifenc, the MCP tool handlers over an in-memory transport) against fake gateways.
- `npm run integration:paid` runs live tests that call real, billed APIs (`tests/paid/`). It needs tokens and costs money, so it never runs in CI or in `npm test`.
- `npm run trellis` audits structural debt (complexity, duplication, import cycles). It needs [Bun](https://bun.sh/) on the `PATH`.
- Helper scripts for poking at a gateway or spawning the server as a client are in `scripts/`.

Start with [CLAUDE.md](CLAUDE.md) if you are working on the code, or point your coding agent at it. It holds the architecture, conventions and the hard-won gotchas. [docs/API-NOTES.md](docs/API-NOTES.md) has the exact gateway contracts, and [docs/UPDATING-LEADERBOARDS.md](docs/UPDATING-LEADERBOARDS.md) explains how the wizard's model rankings are refreshed.

The project is built primarily with [Pi](https://github.com/earendil-works/pi) and [Claude Code](https://claude.com/claude-code) + dependencies listed in [package.json](package.json).

## Contributing

Open an issue before starting anything non-trivial, and keep each change small. Open a [pull request](https://github.com/MarcinWolnyEU/ai-image-router-mcp/pulls), make sure `npm run typecheck` and `npm test` pass, and describe **why** the change is needed and what **risks** it carries. Add or update tests that would fail if the code were wrong. Do not commit tokens, config files or absolute local paths.

Pull requests are reviewed personally and answered within 2 weeks.

## Providing feedback and bug reports

Report bugs, ask questions and request features through [Issues](https://github.com/MarcinWolnyEU/ai-image-router-mcp/issues). Include your version, gateway, transport and OS, plus the `health_status` output with tokens removed. For security issues use the [dedicated form](https://github.com/MarcinWolnyEU/ai-image-router-mcp/security/advisories/new).

Issues are answered within 2 weeks, security advisories within 48 hours.

## License

[MIT](LICENSE) (c) 2026 Marcin Wolny.

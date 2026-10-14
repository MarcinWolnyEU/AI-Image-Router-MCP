# MCP clients

The README covers Claude Desktop, Claude Code, VS Code and Cursor. This page covers the clients that need more explanation. All examples use `npx -y ai-image-router-mcp`. From a checkout, replace that with `node /absolute/path/to/ai-image-router-mcp/dist/index.js`.

Run the [setup wizard](../README.md#quickstart) before registering the server anywhere.

## Pi

Add the server to Pi's MCP config. The global file is `~/.pi/agent/mcp.json`. Project-scoped servers go in `.pi/mcp.json`.

```json
{
  "mcpServers": {
    "ai-image-router": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "ai-image-router-mcp"],
      "env": {}
    }
  }
}
```

Pi reads its MCP config at startup. If Pi is already running, run `/reload` in the chat to pick up the new server without quitting.

After `/reload` the server may show as not connected in `mcp({})` or `/mcp`. Reconnect it with:

```
/mcp reconnect ai-image-router
```

or `mcp({ connect: "ai-image-router" })`. Once connected, the tools appear as `ai-image-router_*`.

## Le Chat (custom connector over HTTP)

Le Chat connects from Mistral's cloud, so the server must be reachable at a public HTTPS URL with a valid TLS certificate. `localhost` cannot work.

1. Run the setup wizard and enable HTTP with an auth token (it writes `mcp http token.txt`), or set `http.enabled: true` and `http.authToken` in `config.json`. Then start the server with `--http`.
2. Expose it, for example with a tunnel: `cloudflared tunnel --url http://127.0.0.1:8765`. Use the printed `https://...trycloudflare.com` URL plus `/mcp`.
3. In Le Chat, open **Connectors**, choose **Add connector**, then **Add a custom connector**. Give it a name made of letters and digits only (for example `aiimagerouter`; an underscore keeps the form disabled), the URL (`https://<tunnel-host>/mcp`) and a description. Auto-detect selects **API Token Authentication** with **Bearer**. Paste the token and click **Add connector**. The page should then show *Valid* and the tool list. Adding a connector is an admin action (the account owner on Free and Pro).
4. Check the public path first with `npx tsx scripts/connector-test.ts https://<tunnel-host>/mcp` from a checkout.

Le Chat uses tools only, not MCP resources or prompts. Each tool has an "Always allow" toggle.

The server answers an unauthenticated request with a plain `401` and no `WWW-Authenticate` challenge, on purpose. With a challenge, Le Chat tries OAuth discovery instead of offering token entry.

Returned file paths are on the server's disk. A later tool call can read them, so chaining by path works, but you cannot open them from Le Chat. Ask for `output_mode: "base64"` for media you want to see there.

## Mistral Vibe CLI

Vibe reads `~/.vibe/config.toml`, or a trusted project `./.vibe/config.toml`. Each server is a `[[mcp_servers]]` entry, and its tools appear as `{name}_{tool}` (for example `air_generate_image`).

Over stdio, Vibe starts a fresh server process for each tool call. `BG_NO_PREWARM` skips the roughly 1 GB background-model load at startup, so set it:

```toml
[[mcp_servers]]
name = "air"
transport = "stdio"
command = "npx"
args = ["-y", "ai-image-router-mcp"]
env = { BG_NO_PREWARM = "1" }
startup_timeout_sec = 60
tool_timeout_sec = 300
```

Over HTTP, start the server separately with `--http`. Vibe has no OAuth, so use a static header:

```toml
[[mcp_servers]]
name = "air"
transport = "streamable-http"   # "http" also works
url = "http://127.0.0.1:8765/mcp"
headers = { Authorization = "Bearer <token from mcp http token.txt>" }
startup_timeout_sec = 60
tool_timeout_sec = 300
```

In Vibe, `/mcp` lists the servers and `/mcp air` lists that server's tools. Vibe keeps only the text blocks of a result, so images and file links are dropped on its side.

## Other clients

Any client that can launch a stdio command works with `npx -y ai-image-router-mcp`. For clients that only speak HTTP, run the server with `--http` and set an auth token. The wire-level details for each client are in [API-NOTES.md](API-NOTES.md).

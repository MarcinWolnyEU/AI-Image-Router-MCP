import type { McpServer, RegisteredTool, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { runtime } from '../state/runtime.js';

/** The config-dependent parts of a registered tool that a reload can change. */
export interface ToolRefresh {
  paramsSchema?: StandardSchemaWithJSON;
  description?: string;
  enabled?: boolean;
}

/**
 * Re-derive a registered tool's config-dependent parts after every successful
 * `restart`. Tools are registered once per connection, so anything computed from the
 * gateway/model at registration time (input-schema enums, whether the tool applies at
 * all) would otherwise keep describing the PREVIOUS configuration. `update()` swaps it
 * in place and notifies the client (`notifications/tools/list_changed`). The
 * subscription ends when the connection closes (HTTP sessions come and go).
 */
export function refreshOnReload(server: McpServer, tool: RegisteredTool, derive: () => ToolRefresh): void {
  const off = runtime.onReload(() => tool.update(derive()));
  const previous = server.server.onclose;
  server.server.onclose = () => {
    off();
    previous?.();
  };
}

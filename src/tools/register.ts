import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import type { Runtime } from "../runtime.js";

type Handler = (args: any) => Promise<any>;

/**
 * A pre-parity tool name kept for callers that still use it (dev.factory, dev.harness).
 * `shape` and `handler` are the legacy ones, so old arguments keep working unchanged;
 * the handler usually maps them onto the canonical implementation.
 */
export type LegacyAlias = {
  name: string;
  shape: ZodRawShape;
  handler: Handler;
};

/**
 * Registers a deprecated alias only when DEV_MCP_LEGACY_TOOL_NAMES is on (default).
 * The description points to the canonical tool so agents migrate.
 */
export function registerLegacyAlias(
  server: McpServer,
  runtime: Runtime,
  canonical: string,
  alias: LegacyAlias,
  summary?: string,
): void {
  if (!runtime.config.legacyToolNames) return;
  const text = `Deprecated alias of ${canonical}${summary ? ` (${summary})` : ""}. Prefer ${canonical}; this name is removed when DEV_MCP_LEGACY_TOOL_NAMES=0.`;
  server.tool(alias.name, text, alias.shape, alias.handler);
}

/** First defined value among several argument spellings (official snake_case first, then legacy camelCase). */
export function arg<T>(...values: Array<T | undefined>): T | undefined {
  for (const v of values) if (v !== undefined && v !== null) return v;
  return undefined;
}

/**
 * Registers a write tool that did not exist before 1.3.0. dev.factory read-only agents block
 * writes by listing tool names, so these new names are hidden unless DEV_MCP_PARITY_WRITES=1.
 * Write tools that already existed under the same name stay registered through server.tool.
 */
export function registerWriteTool<S extends ZodRawShape>(
  server: McpServer,
  runtime: Runtime,
  name: string,
  description: string,
  shape: S,
  handler: ToolCallback<S>,
): void {
  if (!runtime.config.parityWrites) return;
  server.tool(name, description, shape, handler);
}

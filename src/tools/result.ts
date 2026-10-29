import { errorMessage } from "../errors.js";

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const RAW = Symbol.for("dev.mcp.raw-result");

export function jsonResult(data: unknown): {
  content: McpContent[];
} {
  return {
    content: [{ type: "text", text: stringify(data) }],
  };
}

export function rawResult(content: McpContent[]): { content: McpContent[] } & Record<symbol, true> {
  return { [RAW]: true, content };
}

export function errorResult(err: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    isError: true,
    content: [{ type: "text", text: errorMessage(err) }],
  };
}

export function wrapTool<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      const data = await fn(args);
      if (isRawResult(data)) return { content: data.content };
      return jsonResult(data);
    } catch (err) {
      return errorResult(err);
    }
  };
}

function isRawResult(data: unknown): data is { content: McpContent[] } {
  return Boolean(data && typeof data === "object" && RAW in data);
}

function stringify(data: unknown): string {
  if (typeof data === "string") return data;
  return JSON.stringify(data);
}

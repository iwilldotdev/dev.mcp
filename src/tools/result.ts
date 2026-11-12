import { errorMessage } from "../errors.js";
import { z } from "zod";
import { precheckSave, prettyJson, saveJson, saveJsonWithImages, spillBytes, spillFile, spillHint } from "../save.js";

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

const overwriteShape = z
  .boolean()
  .optional()
  .describe("Replace save_to if it already exists. Default: false (an existing file is an error).");

export const saveToShape = {
  save_to: z
    .string()
    .optional()
    .describe(
      "Absolute .json path. Writes the full payload there and returns only {saved_to, bytes, sha256, kind, summary}; embedded images (Jira) are saved next to it as <name>.images/<n>.<ext> and listed in summary.images. Must be inside DEV_MCP_SAVE_ROOTS (default: <os tmpdir>/dev.mcp); dot-folders such as .ssh or .claude are refused.",
    ),
  overwrite: overwriteShape,
};

export const saveToImageShape = {
  save_to: z
    .string()
    .optional()
    .describe(
      "Absolute path for PNG bytes: a .png file, or a directory / path ending in / or \ (required for several nodes) that gets <node-id-dashed>.png per node. Returns only {saved_to, bytes, sha256, kind, summary}, no image content. Must be inside DEV_MCP_SAVE_ROOTS (default: <os tmpdir>/dev.mcp); dot-folders such as .ssh or .claude are refused.",
    ),
  overwrite: overwriteShape,
};

type PayloadImage = { data: Buffer; mime: string };

function payloadOf(data: unknown): { payload: unknown; images: PayloadImage[] } {
  if (isRawResult(data)) {
    const first = data.content.find((c) => c.type === "text");
    const images: PayloadImage[] = data.content.flatMap((c) =>
      c.type === "image" ? [{ data: Buffer.from(c.data, "base64"), mime: c.mimeType }] : [],
    );
    let payload: unknown = first && first.type === "text" ? first.text : null;
    try {
      payload = JSON.parse(payload as string);
    } catch {
      /* keep text */
    }
    return { payload, images };
  }
  if (typeof data === "string") {
    try {
      return { payload: JSON.parse(data), images: [] };
    } catch {
      /* keep text */
    }
  }
  return { payload: data, images: [] };
}

function sizeOf(data: unknown): number {
  if (isRawResult(data)) {
    return data.content.reduce((n, c) => n + (c.type === "text" ? Buffer.byteLength(c.text) : c.data.length), 0);
  }
  return Buffer.byteLength(typeof data === "string" ? data : (JSON.stringify(data) ?? ""));
}

/**
 * Like wrapTool, but honours an optional save_to: writes the payload as JSON (images next to it)
 * and returns a compact summary. With DEV_MCP_SPILL_KB set, an oversized payload is saved to the
 * spill folder the same way.
 */
export function wrapSaveTool<T extends { save_to?: string; overwrite?: boolean }>(
  tool: string,
  summarize: (payload: any) => Record<string, unknown>,
  fn: (args: T) => Promise<unknown>,
) {
  return wrapTool(async (args: T) => {
    // Fail before any network call: path, roots, extension, overwrite.
    if (args.save_to) await precheckSave(args.save_to, "json", { overwrite: args.overwrite });
    const data = await fn(args);
    const limit = args.save_to ? 0 : spillBytes();
    if (!args.save_to && !(limit > 0 && sizeOf(data) > limit)) return data;
    const { payload, images } = payloadOf(data);
    const target = args.save_to ?? (await spillFile(tool, prettyJson(payload), "json"));
    const opts = { overwrite: args.save_to ? args.overwrite : false };
    const summary: Record<string, unknown> = { ...(summarize(payload) ?? {}) };
    let saved;
    if (images.length) {
      const r = await saveJsonWithImages(target, payload, images, opts);
      saved = r.json;
      summary.images = r.images;
    } else {
      saved = await saveJson(target, payload, opts);
    }
    return args.save_to
      ? { ...saved, summary }
      : { ...saved, summary, spilled: true, hint: spillHint(saved.saved_to) };
  });
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireFigma } from "../config.js";
import { FigmaClient } from "../clients/figma.js";
import { buildDesignContext } from "../figma/design-context.js";
import {
  collectFrames,
  nodeToXml,
  parseFigmaFileKey,
  parseFigmaNodeIds,
  parseFigmaUrl,
  summarizeVariables,
  type FigmaNode,
} from "../figma/parse.js";
import type { Runtime } from "../runtime.js";
import { rawResult, saveToImageShape, saveToShape, wrapSaveTool, wrapTool } from "./result.js";
import { precheckSave, savePngs, spillBytes, spillFile, spillHint } from "../save.js";
import { sumFigmaContext, sumFigmaFile, sumFigmaFrames, sumFigmaMeta, sumFigmaVars } from "./summaries.js";

async function downloadPngs(
  figma: FigmaClient,
  rendered: { images?: Record<string, string | null> },
  ids: string[],
): Promise<Array<{ nodeId: string; data: Buffer; width?: number; height?: number }>> {
  const out = [];
  for (const id of ids) {
    const url = rendered.images?.[id] ?? rendered.images?.[id.replaceAll(":", "-")];
    if (!url) throw new Error(`No render URL for node ${id}; nothing was saved.`);
    const image = await figma.fetchImage(url);
    if (image.mime !== "image/png") throw new Error(`Node ${id} did not render as PNG (${image.mime}); nothing was saved.`);
    out.push({ nodeId: id, data: image.data, width: image.width, height: image.height });
  }
  return out;
}

async function saveImageSummary(
  saveTo: string,
  images: Array<{ nodeId: string; data: Buffer; width?: number; height?: number }>,
  extra: Record<string, unknown>,
  overwrite?: boolean,
) {
  const saved = await savePngs(saveTo, images, { overwrite });
  const first = saved[0]!;
  return {
    saved_to: saved.length === 1 ? first.saved_to : saveTo,
    bytes: saved.reduce((n, x) => n + x.bytes, 0),
    sha256: first.sha256,
    kind: "png",
    summary: {
      ...extra,
      images: saved.map((x, i) => ({
        nodeId: images[i]!.nodeId,
        saved_to: x.saved_to,
        bytes: x.bytes,
        sha256: x.sha256,
        width: images[i]!.width,
        height: images[i]!.height,
      })),
    },
  };
}

function client(runtime: Runtime): FigmaClient {
  return new FigmaClient(requireFigma(runtime.config), runtime.http, runtime.figmaCache);
}

function fileKeyFrom(args: { fileKey?: string; url?: string }): string {
  const raw = args.fileKey ?? args.url;
  if (!raw) throw new Error("Provide fileKey or a Figma file URL.");
  return parseFigmaFileKey(raw);
}

const fileKeyShape = {
  fileKey: z
    .string()
    .optional()
    .describe("Figma file key or full URL (figma.com/design/...)."),
  url: z.string().optional().describe("Figma file or node URL."),
};

export function registerFigmaTools(server: McpServer, runtime: Runtime): void {
  server.tool(
    "figma_whoami",
    "Returns the authenticated Figma user (GET /v1/me).",
    {},
    wrapTool(async () => client(runtime).me()),
  );

  server.tool(
    "figma_get_file",
    "Gets the Figma document (GET /v1/files/:key). Use depth/ids to shrink the payload. To keep or hand off the payload, pass save_to (absolute path); the response becomes a compact summary.",
    {
      ...saveToShape,
      ...fileKeyShape,
      depth: z.number().int().min(1).max(8).optional().describe("Tree depth."),
      ids: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Node IDs (comma-separated or array). URL node-id (1-2) is accepted."),
    },
    wrapSaveTool("figma_get_file", sumFigmaFile, async (args) => {
      const fileKey = fileKeyFrom(args);
      const ids = parseFigmaNodeIds(args.ids);
      return client(runtime).getFile(fileKey, { depth: args.depth, ids });
    }),
  );

  server.tool(
    "figma_get_metadata",
    "Slim XML tree (id, name, type, size) via GET /v1/files/:key/nodes. To keep or hand off the payload, pass save_to (absolute path); the response becomes a compact summary.",
    {
      ...saveToShape,
      ...fileKeyShape,
      nodeIds: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Nodes to include. If omitted, tries the URL node-id; otherwise uses the root document."),
      depth: z.number().int().min(1).max(8).optional(),
    },
    wrapSaveTool("figma_get_metadata", sumFigmaMeta, async (args) => {
      const figma = client(runtime);
      const parsed = args.url ? parseFigmaUrl(args.url) : { fileKey: fileKeyFrom(args) };
      const fileKey = args.fileKey ? parseFigmaFileKey(args.fileKey) : parsed.fileKey;
      const requested = parseFigmaNodeIds(args.nodeIds) ?? parsed.nodeIds;
      if (requested?.length) {
        const nodes = await figma.getNodes(fileKey, requested, { depth: args.depth });
        const xml = Object.entries(nodes.nodes)
          .map(([id, entry]) => {
            if (!entry?.document) return `<!-- missing ${id} -->`;
            return nodeToXml(entry.document as FigmaNode);
          })
          .join("\n");
        return { fileKey, name: nodes.name, lastModified: nodes.lastModified, xml };
      }
      const file = await figma.getFile(fileKey, { depth: args.depth ?? 2 });
      return {
        fileKey,
        name: file.name,
        lastModified: file.lastModified,
        xml: nodeToXml(file.document as FigmaNode),
      };
    }),
  );

  server.tool(
    "figma_get_screenshot",
    "Renders nodes as images (GET /v1/images/:key) and returns temporary URLs. With save_to, downloads the PNG bytes and writes them to disk (a .png file, or a directory for several nodes); the response becomes a compact summary with no image content.",
    {
      ...fileKeyShape,
      ...saveToImageShape,
      nodeIds: z
        .union([z.string(), z.array(z.string())])
        .describe("Node IDs to render."),
      format: z.enum(["png", "jpg", "svg", "pdf"]).optional(),
      scale: z.number().min(0.01).max(4).optional(),
    },
    wrapTool(async (args) => {
      if (args.save_to && args.format && args.format !== "png") throw new Error("save_to supports format png only.");
      const fileKey = fileKeyFrom(args);
      const fromUrl = args.url ? parseFigmaUrl(args.url).nodeIds : undefined;
      const ids = parseFigmaNodeIds(args.nodeIds) ?? fromUrl;
      if (!ids?.length) throw new Error("Provide nodeIds (or a URL with node-id).");
      if (args.save_to) await precheckSave(args.save_to, "png", { nodeIds: ids, overwrite: args.overwrite });
      const figma = client(runtime);
      const rendered = await figma.getImages(fileKey, ids, {
        format: args.save_to ? "png" : args.format,
        scale: args.scale,
      });
      if (!args.save_to) return rendered;
      const downloaded = await downloadPngs(figma, rendered, ids);
      return saveImageSummary(args.save_to, downloaded, { fileKey, scale: args.scale ?? 1 }, args.overwrite);
    }),
  );

  server.tool(
    "figma_get_variable_defs",
    "Local (and optionally published) variables for the file (GET /v1/files/:key/variables/...). To keep or hand off the payload, pass save_to (absolute path); the response becomes a compact summary.",
    {
      ...saveToShape,
      ...fileKeyShape,
      includePublished: z.boolean().optional().describe("Also fetch published variables."),
    },
    wrapSaveTool("figma_get_variable_defs", sumFigmaVars, async (args) => {
      const fileKey = fileKeyFrom(args);
      const figma = client(runtime);
      const local = summarizeVariables(await figma.getLocalVariables(fileKey));
      if (!args.includePublished) return { fileKey, local };
      const published = summarizeVariables(await figma.getPublishedVariables(fileKey));
      return { fileKey, local, published };
    }),
  );

  server.tool(
    "figma_get_design_context",
    "Implementation context (layout, fixed sizing, effects, text, hidden layers, masks, component variants, style names, hyperlink/prototype pointers, screenshot URL) composed via REST. Variables are off unless includeVariables is true; a variables failure is a warning and does not drop nodes or truncate the tree. A node id returns its subtree until depth or the node/byte cap cuts it; a cut sets truncated, truncation.hint and truncation.nextChildIds (refetch those ids). fields selects blocks (layout, visual, fills, strokes, text, component) to shrink the payload. The payload carries lastModified for pack freshness checks. A call without a node id is cut at file depth 3. Missing ids are listed in missingNodeIds. A screenshot failure is a warning and does not drop nodes. Rotation is passed through as REST returns it (unit not documented). Not the official MCP proprietary codegen. To keep or hand off the payload, pass save_to (absolute path); the response becomes a compact summary.",
    {
      ...saveToShape,
      ...fileKeyShape,
      nodeIds: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Target nodes. Recommended for smaller payloads."),
      depth: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Levels of children below each node id. Default: full subtree."),
      includeScreenshot: z.boolean().optional().describe("Default: true."),
      includeVariables: z.boolean().optional().describe("Default: false. Optional; a 403 does not affect the rest of the context."),
      includeMetadataXml: z
        .boolean()
        .optional()
        .describe("Default: false. The same tree as XML; figma_get_metadata returns it alone."),
      fields: z
        .array(z.enum(["layout", "visual", "fills", "strokes", "text", "component"]))
        .optional()
        .describe("Emit only these blocks per node. Default: all."),
      screenshotScale: z
        .number()
        .min(0.01)
        .max(4)
        .optional()
        .describe("Screenshot scale. Default 1, so pixels match CSS pixels."),
      screenshotFormat: z.enum(["png", "jpg", "svg", "pdf"]).optional().describe("Default: png."),
    },
    wrapSaveTool("figma_get_design_context", sumFigmaContext, async (args) => {
      const parsed = args.url ? parseFigmaUrl(args.url) : { fileKey: fileKeyFrom(args) };
      const fileKey = args.fileKey ? parseFigmaFileKey(args.fileKey) : parsed.fileKey;
      const nodeIds = parseFigmaNodeIds(args.nodeIds) ?? parsed.nodeIds;
      // Compact on purpose: a full screen subtree is large, and wrapTool leaves a string as-is.
      return JSON.stringify(
        await buildDesignContext(client(runtime), {
          fileKey,
          nodeIds,
          depth: args.depth,
          includeScreenshot: args.includeScreenshot,
          includeVariables: args.includeVariables,
          includeMetadataXml: args.includeMetadataXml,
          fields: args.fields,
          screenshotScale: args.screenshotScale,
          screenshotFormat: args.screenshotFormat,
        }),
      );
    }),
  );

  server.tool(
    "figma_fetch_screenshot",
    "Downloads rendered node images and returns image bytes plus sha256, MIME, and dimensions. Does not rely on a temporary Figma URL remaining valid. Canonical scale is 1. With save_to, writes the PNG bytes to disk (a .png file, or a directory for several nodes) and returns only a compact summary with no image content; with DEV_MCP_SPILL_KB set, oversized images are spilled to disk the same way.",
    {
      ...fileKeyShape,
      ...saveToImageShape,
      nodeIds: z.union([z.string(), z.array(z.string())]).describe("Node IDs to render."),
      format: z.enum(["png", "jpg", "svg", "pdf"]).optional(),
      scale: z.number().min(0.01).max(4).optional().describe("Default: 1."),
    },
    wrapTool(async (args) => {
      if (args.save_to && args.format && args.format !== "png") throw new Error("save_to supports format png only.");
      const fileKey = fileKeyFrom(args);
      const fromUrl = args.url ? parseFigmaUrl(args.url).nodeIds : undefined;
      const ids = parseFigmaNodeIds(args.nodeIds) ?? fromUrl;
      if (!ids?.length) throw new Error("Provide nodeIds (or a URL with node-id).");
      if (args.save_to) await precheckSave(args.save_to, "png", { nodeIds: ids, overwrite: args.overwrite });
      const figma = client(runtime);
      const rendered = await figma.getImages(fileKey, ids, {
        format: args.format ?? "png",
        scale: args.scale ?? 1,
      });
      if (args.save_to) {
        const downloaded = await downloadPngs(figma, rendered, ids);
        return saveImageSummary(args.save_to, downloaded, { fileKey, scale: args.scale ?? 1 }, args.overwrite);
      }
      const images = [];
      const pngBuffers: Array<{ nodeId: string; data: Buffer }> = [];
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
      for (const id of ids) {
        const url = rendered.images?.[id] ?? rendered.images?.[id.replaceAll(":", "-")];
        if (!url) {
          images.push({ nodeId: id, error: "missing render URL" });
          continue;
        }
        const image = await figma.fetchImage(url);
        images.push({
          nodeId: id,
          sha256: image.sha256,
          mime: image.mime,
          width: image.width,
          height: image.height,
          byteLength: image.byteLength,
        });
        if (image.mime.startsWith("image/")) {
          if (image.mime === "image/png") pngBuffers.push({ nodeId: id, data: image.data });
          content.push({ type: "image", data: image.data.toString("base64"), mimeType: image.mime });
        }
      }
      const limit = spillBytes();
      const totalBytes = pngBuffers.reduce((n, i) => n + i.data.length, 0);
      if (limit > 0 && pngBuffers.length && totalBytes > limit) {
        const spilled = [];
        for (const img of pngBuffers) {
          const file = await spillFile("figma_fetch_screenshot", img.data, "png");
          const [r] = await savePngs(file, [img]);
          spilled.push({ nodeId: img.nodeId, ...r! });
        }
        return {
          ...spilled[0]!,
          summary: { fileKey, scale: args.scale ?? 1, images, files: spilled.map((x) => ({ nodeId: x.nodeId, saved_to: x.saved_to, bytes: x.bytes, sha256: x.sha256 })) },
          spilled: true,
          hint: spillHint(spilled.map((x) => x.saved_to).join(", ")),
        };
      }
      content.unshift({
        type: "text",
        text: JSON.stringify({ schemaVersion: 1, fileKey, scale: args.scale ?? 1, images }),
      });
      return rawResult(content);
    }),
  );

  server.tool(
    "figma_get_file_meta",
    "Cheap freshness check: file name and lastModified (GET /v1/files/:key at depth 1). Use it to decide whether a persisted Figma pack is stale before refetching node contexts. To keep or hand off the payload, pass save_to (absolute path); the response becomes a compact summary.",
    { ...fileKeyShape, ...saveToShape },
    wrapSaveTool("figma_get_file_meta", sumFigmaMeta, async (args) => {
      const fileKey = fileKeyFrom(args);
      const file = await client(runtime).getFile(fileKey, { depth: 1 });
      return {
        fileKey,
        name: file.name,
        lastModified: file.lastModified,
        version: file.version,
      };
    }),
  );

  server.tool(
    "figma_get_frames",
    "Recursive frame index (GET /v1/files/:key): id, name, type, size, pagePath, and sectionPath, including frames nested in sections. One REST call; pageName filters pages. To keep or hand off the payload, pass save_to (absolute path); the response becomes a compact summary.",
    {
      ...saveToShape,
      ...fileKeyShape,
      pageName: z.string().optional().describe("Case-insensitive substring filter on the page name."),
      depth: z.number().int().min(1).max(8).optional().describe("Document depth. Default: 4."),
    },
    wrapSaveTool("figma_get_frames", sumFigmaFrames, async (args) => {
      const fileKey = fileKeyFrom(args);
      const file = await client(runtime).getFile(fileKey, { depth: args.depth ?? 4 });
      const indexed = collectFrames(file.document as FigmaNode | undefined, {
        pageName: args.pageName,
      });
      return {
        schemaVersion: 1,
        fileKey,
        name: file.name,
        lastModified: file.lastModified,
        version: file.version,
        truncated: indexed.truncated,
        frames: indexed.frames,
      };
    }),
  );

  server.tool(
    "figma_download_assets",
    "Export URLs (GET /v1/images) and image fills for the file (GET /v1/files/:key/images).",
    {
      ...fileKeyShape,
      nodeIds: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Nodes to export. If omitted, returns image fills only."),
      format: z.enum(["png", "jpg", "svg", "pdf"]).optional(),
      scale: z.number().min(0.01).max(4).optional(),
      includeImageFills: z.boolean().optional().describe("Default: true."),
    },
    wrapTool(async (args) => {
      const fileKey = fileKeyFrom(args);
      const figma = client(runtime);
      const fromUrl = args.url ? parseFigmaUrl(args.url).nodeIds : undefined;
      const ids = parseFigmaNodeIds(args.nodeIds) ?? fromUrl;
      const includeFills = args.includeImageFills !== false;
      const [exports, fills] = await Promise.all([
        ids?.length
          ? figma.getImages(fileKey, ids, { format: args.format ?? "png", scale: args.scale })
          : Promise.resolve(undefined),
        includeFills ? figma.getImageFills(fileKey) : Promise.resolve(undefined),
      ]);
      return { fileKey, exports, imageFills: fills };
    }),
  );

  server.tool(
    "figma_get_comments",
    "File comments (GET /v1/files/:key/comments).",
    fileKeyShape,
    wrapTool(async (args) => {
      const fileKey = fileKeyFrom(args);
      return client(runtime).getComments(fileKey);
    }),
  );
}

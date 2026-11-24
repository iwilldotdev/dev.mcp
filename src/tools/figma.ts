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
import {
  collectFigjamTexts,
  collectIds,
  collectUsage,
  filterComments,
  mergeNodeIds,
  scopeVariables,
  type FigmaComment,
} from "../figma/parity.js";
import type { Runtime } from "../runtime.js";
import { rawResult, saveToImageShape, saveToShape, wrapSaveTool, wrapTool } from "./result.js";
import { type ImageExt, maxSaveBytes, precheckSave, savePngs, spillBytes, spillFile, spillHint } from "../save.js";
import { sumFigmaContext, sumFigmaFile, sumFigmaFrames, sumFigmaMeta, sumFigmaVars } from "./summaries.js";

const FORMAT_MIME: Record<ImageExt, string[]> = {
  png: ["image/png"],
  jpg: ["image/jpeg", "image/jpg"],
  svg: ["image/svg+xml", "text/xml", "application/xml", "text/plain"],
  pdf: ["application/pdf"],
};

/** Downloads rendered jpg/svg/pdf exports (pre-signed S3 URLs, no auth header) without image decoding. */
async function downloadExports(
  figma: FigmaClient,
  rendered: { images?: Record<string, string | null> },
  ids: string[],
  ext: ImageExt,
): Promise<Array<{ nodeId: string; data: Buffer }>> {
  const out = [];
  for (const id of ids) {
    const url = rendered.images?.[id] ?? rendered.images?.[id.replaceAll(":", "-")];
    if (!url) throw new Error(`No render URL for node ${id}; nothing was saved.`);
    const file = await figma.fetchBytes(url, maxSaveBytes());
    const mime = file.mime.toLowerCase();
    if (!FORMAT_MIME[ext].includes(mime) && mime !== "application/octet-stream" && mime !== "binary/octet-stream") {
      throw new Error(`Node ${id} did not render as ${ext} (${file.mime}); nothing was saved.`);
    }
    out.push({ nodeId: id, data: file.data });
  }
  return out;
}

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
  ext: ImageExt = "png",
) {
  const saved = await savePngs(saveTo, images, { overwrite, ext });
  const first = saved[0]!;
  return {
    saved_to: saved.length === 1 ? first.saved_to : saveTo,
    bytes: saved.reduce((n, x) => n + x.bytes, 0),
    sha256: first.sha256,
    kind: ext,
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

const nodeIdShape = {
  nodeId: z
    .string()
    .optional()
    .describe('Official singular node id, "1:2" or "1-2". Merged with nodeIds.'),
};

const nodeIdsArg = z.union([z.string(), z.array(z.string())]);

/** nodeIds + official nodeId, falling back to the node-id of a Figma URL. */
function nodeIdsFrom(args: { nodeIds?: string | string[]; nodeId?: string; url?: string }): string[] | undefined {
  return mergeNodeIds(args.nodeIds, args.nodeId) ?? (args.url ? parseFigmaUrl(args.url).nodeIds : undefined);
}

type ScreenshotArgs = {
  fileKey?: string;
  url?: string;
  nodeIds?: string | string[];
  nodeId?: string;
  format?: "png" | "jpg" | "svg" | "pdf";
  scale?: number;
  save_to?: string;
  overwrite?: boolean;
};

const SCREENSHOT_DESC =
  "Downloads rendered node images and returns the image itself (plus sha256, MIME and dimensions as text). Does not rely on a temporary Figma URL remaining valid; use figma_get_image_urls for URLs. Canonical scale is 1. With save_to, writes the PNG bytes to disk (a .png file, or a directory for several nodes) and returns only a compact summary with no image content; with DEV_MCP_SPILL_KB set, oversized images are spilled to disk the same way. Accepts nodeId (official) or nodeIds.";

const screenshotShape = {
  ...fileKeyShape,
  ...saveToImageShape,
  nodeId: nodeIdShape.nodeId.describe('Official singular node id, "1:2" or "1-2".'),
  nodeIds: nodeIdsArg.optional().describe("Node IDs to render (alternative to nodeId)."),
  format: z.enum(["png", "jpg", "svg", "pdf"]).optional(),
  scale: z.number().min(0.01).max(4).optional().describe("Default: 1."),
};

function screenshotHandler(runtime: Runtime, toolName: string) {
  return async (args: ScreenshotArgs) => {
    if (args.save_to && args.format && args.format !== "png") throw new Error("save_to supports format png only.");
    const fileKey = fileKeyFrom(args);
    const ids = nodeIdsFrom(args);
    if (!ids?.length) throw new Error("Provide nodeId/nodeIds (or a URL with node-id).");
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
        const file = await spillFile(toolName, img.data, "png");
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
  };
}

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
      ...nodeIdShape,
    },
    wrapSaveTool("figma_get_file", sumFigmaFile, async (args) => {
      const fileKey = fileKeyFrom(args);
      const ids = mergeNodeIds(args.ids, args.nodeId);
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
      ...nodeIdShape,
      depth: z.number().int().min(1).max(8).optional(),
    },
    wrapSaveTool("figma_get_metadata", sumFigmaMeta, async (args) => {
      const figma = client(runtime);
      const parsed = args.url ? parseFigmaUrl(args.url) : { fileKey: fileKeyFrom(args) };
      const fileKey = args.fileKey ? parseFigmaFileKey(args.fileKey) : parsed.fileKey;
      const requested = mergeNodeIds(args.nodeIds, args.nodeId) ?? parsed.nodeIds;
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
    SCREENSHOT_DESC,
    screenshotShape,
    wrapTool(screenshotHandler(runtime, "figma_get_screenshot")),
  );

  server.tool(
    "figma_get_image_urls",
    "Renders nodes as images (GET /v1/images/:key) and returns temporary render URLs (they expire). Use figma_get_screenshot to see the image itself. With save_to, downloads the PNG bytes and writes them to disk (a .png file, or a directory for several nodes); the response becomes a compact summary with no image content.",
    {
      ...fileKeyShape,
      ...saveToImageShape,
      nodeIds: nodeIdsArg.optional().describe("Node IDs to render."),
      ...nodeIdShape,
      format: z.enum(["png", "jpg", "svg", "pdf"]).optional(),
      scale: z.number().min(0.01).max(4).optional(),
    },
    wrapTool(async (args) => {
      if (args.save_to && args.format && args.format !== "png") throw new Error("save_to supports format png only.");
      const fileKey = fileKeyFrom(args);
      const ids = nodeIdsFrom(args);
      if (!ids?.length) throw new Error("Provide nodeId/nodeIds (or a URL with node-id).");
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
    "Variables (and, with nodeId, styles) for the file. Without nodeId: the whole file's local (and optionally published) variables (GET /v1/files/:key/variables/...). With nodeId/nodeIds: only the variables and styles used under that node (bound variable ids and style ids found in the subtree, resolved against local variables). The variables API needs an Enterprise plan: on a 403 the result degrades to styles plus the bound variable ids, with a warning. To keep or hand off the payload, pass save_to (absolute path); the response becomes a compact summary.",
    {
      ...saveToShape,
      ...fileKeyShape,
      ...nodeIdShape,
      nodeIds: nodeIdsArg.optional().describe("Alternative to nodeId; limits the result to what these nodes use."),
      includePublished: z.boolean().optional().describe("Also fetch published variables (whole-file mode only)."),
    },
    wrapSaveTool("figma_get_variable_defs", sumFigmaVars, async (args) => {
      const fileKey = fileKeyFrom(args);
      const figma = client(runtime);
      const ids = nodeIdsFrom(args);
      if (!ids?.length) {
        const local = summarizeVariables(await figma.getLocalVariables(fileKey));
        if (!args.includePublished) return { fileKey, local };
        const published = summarizeVariables(await figma.getPublishedVariables(fileKey));
        return { fileKey, local, published };
      }
      const warnings: string[] = [];
      const nodes = await figma.getNodes(fileKey, ids);
      const usage = collectUsage(undefined);
      const styleDefs: Record<string, { key?: string; name?: string; styleType?: string }> = {};
      const missingNodeIds: string[] = [];
      for (const id of ids) {
        const entry = nodes.nodes[id];
        if (!entry?.document) {
          missingNodeIds.push(id);
          continue;
        }
        collectUsage(entry.document, usage);
        Object.assign(styleDefs, entry.styles ?? {});
      }
      let local: ReturnType<typeof scopeVariables> | undefined;
      if (usage.variableIds.size) {
        try {
          local = scopeVariables(summarizeVariables(await figma.getLocalVariables(fileKey)) as never, usage);
        } catch (err) {
          warnings.push(
            `Variables API unavailable (${err instanceof Error ? err.message : String(err)}); returning bound variable ids only.`,
          );
        }
      }
      const styles = [...usage.styles.entries()].map(([id, use]) => ({
        id,
        name: styleDefs[id]?.name,
        styleType: styleDefs[id]?.styleType,
        kinds: [...use.kinds],
        usedBy: [...use.nodes].filter(Boolean),
      }));
      const unresolved = local ? local.unresolved : [...usage.variableIds.keys()];
      return {
        fileKey,
        nodeIds: ids,
        ...(missingNodeIds.length ? { missingNodeIds } : {}),
        local: local
          ? { variables: local.variables, variableCollections: local.variableCollections }
          : { variables: {}, variableCollections: {} },
        styles,
        boundVariableIds: [...usage.variableIds.entries()].map(([id, nodesUsing]) => ({
          id,
          usedBy: [...nodesUsing].filter(Boolean),
          resolved: !unresolved.includes(id),
        })),
        ...(warnings.length ? { warnings } : {}),
      };
    }),
  );

  server.tool(
    "figma_get_design_context",
    "Implementation context via the Figma REST API. It does NOT generate code (unlike the official figma MCP get_design_context): layout, fixed sizing, effects, text, hidden layers, masks, component variants, style names, hyperlink/prototype pointers, screenshot URL) composed via REST. Variables are off unless includeVariables is true; a variables failure is a warning and does not drop nodes or truncate the tree. A node id returns its subtree until depth or the node/byte cap cuts it; a cut sets truncated, truncation.hint and truncation.nextChildIds (refetch those ids). fields selects blocks (layout, visual, fills, strokes, text, component) to shrink the payload. The payload carries lastModified for pack freshness checks. A call without a node id is cut at file depth 3. Missing ids are listed in missingNodeIds. A screenshot failure is a warning and does not drop nodes. Rotation is passed through as REST returns it (unit not documented). No code generation. To keep or hand off the payload, pass save_to (absolute path); the response becomes a compact summary.",
    {
      ...saveToShape,
      ...fileKeyShape,
      nodeIds: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Target nodes. Recommended for smaller payloads."),
      ...nodeIdShape,
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
      const nodeIds = mergeNodeIds(args.nodeIds, args.nodeId) ?? parsed.nodeIds;
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
    SCREENSHOT_DESC + " Extra kept from earlier releases; identical to figma_get_screenshot.",
    screenshotShape,
    wrapTool(screenshotHandler(runtime, "figma_fetch_screenshot")),
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
    "Export URLs (GET /v1/images) and image fills for the file (GET /v1/files/:key/images). defaultFormat/defaultScale apply when format/scale are omitted. With save_to (a directory, or one file for one node, whose extension must match the format: png, jpg, svg or pdf) the rendered files are downloaded to disk instead of returning URLs and the response is a compact summary.",
    {
      ...fileKeyShape,
      ...saveToImageShape,
      nodeIds: nodeIdsArg.optional().describe("Nodes to export. If omitted, returns image fills only."),
      ...nodeIdShape,
      format: z.enum(["png", "jpg", "svg", "pdf"]).optional(),
      scale: z.number().min(0.01).max(4).optional(),
      defaultFormat: z.enum(["png", "jpg", "svg", "pdf"]).optional().describe("Used when format is omitted. Default: png."),
      defaultScale: z.number().min(0.01).max(4).optional().describe("Used when scale is omitted."),
      includeImageFills: z.boolean().optional().describe("Default: true (ignored with save_to)."),
    },
    wrapTool(async (args) => {
      const fileKey = fileKeyFrom(args);
      const figma = client(runtime);
      const ids = nodeIdsFrom(args);
      const format = args.format ?? args.defaultFormat ?? "png";
      const scale = args.scale ?? args.defaultScale;
      if (args.save_to) {
        if (!ids?.length) throw new Error("save_to needs nodeId/nodeIds to export.");
        await precheckSave(args.save_to, "png", { nodeIds: ids, overwrite: args.overwrite, ext: format });
        const rendered = await figma.getImages(fileKey, ids, { format, scale });
        const downloaded =
          format === "png" ? await downloadPngs(figma, rendered, ids) : await downloadExports(figma, rendered, ids, format);
        return saveImageSummary(args.save_to, downloaded, { fileKey, format, scale: scale ?? 1 }, args.overwrite, format);
      }
      const includeFills = args.includeImageFills !== false;
      const [exports, fills] = await Promise.all([
        ids?.length ? figma.getImages(fileKey, ids, { format, scale }) : Promise.resolve(undefined),
        includeFills ? figma.getImageFills(fileKey) : Promise.resolve(undefined),
      ]);
      return { fileKey, exports, imageFills: fills };
    }),
  );

  server.tool(
    "figma_get_comments",
    "File comments (GET /v1/files/:key/comments). Optional local filters: resolved (true/false), author (handle or id), mention (handle, matched in the message or mentions), page (page name substring or page node id; matches comments anchored on any node of that page, replies follow their thread root).",
    {
      ...fileKeyShape,
      resolved: z.boolean().optional().describe("true: only resolved threads; false: only open threads."),
      author: z.string().optional().describe("Comment author handle or user id."),
      mention: z.string().optional().describe("Handle mentioned in the comment."),
      page: z.string().optional().describe("Page name (substring) or page node id."),
    },
    wrapTool(async (args) => {
      const fileKey = fileKeyFrom(args);
      const figma = client(runtime);
      const res = (await figma.getComments(fileKey)) as { comments?: FigmaComment[]; [k: string]: unknown };
      if (args.resolved === undefined && !args.author && !args.mention && !args.page) return res;
      let pageNodeIds: Set<string> | undefined;
      if (args.page) {
        const file = await figma.getFile(fileKey, { depth: 1 });
        const needle = args.page.toLowerCase();
        const wanted = args.page.replace(/-/g, ":");
        const pages = ((file.document as FigmaNode | undefined)?.children ?? []).filter(
          (p) => p.id === wanted || (p.name ?? "").toLowerCase().includes(needle),
        );
        pageNodeIds = new Set<string>();
        if (pages.length) {
          const nodes = await figma.getNodes(fileKey, pages.map((p) => p.id));
          for (const entry of Object.values(nodes.nodes)) collectIds(entry?.document, pageNodeIds);
        }
      }
      const comments = filterComments(res.comments ?? [], {
        resolved: args.resolved,
        author: args.author,
        mention: args.mention,
        pageNodeIds,
      });
      return { ...res, comments, filtered: true };
    }),
  );

  server.tool(
    "figma_get_figjam",
    "FigJam board context via REST: slim XML of the FigJam nodes (id, name, type, size), the text of stickies/shapes/text as a texts list, and a screenshot image of the first requested node (or the first page). No connector graph. Set includeScreenshot=false to skip the image.",
    {
      ...fileKeyShape,
      ...nodeIdShape,
      nodeIds: nodeIdsArg.optional().describe("Nodes to include. Default: the board pages."),
      depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 4."),
      includeScreenshot: z.boolean().optional().describe("Default: true."),
    },
    wrapTool(async (args) => {
      const figma = client(runtime);
      const parsed = args.url ? parseFigmaUrl(args.url) : { fileKey: fileKeyFrom(args) };
      const fileKey = args.fileKey ? parseFigmaFileKey(args.fileKey) : parsed.fileKey;
      const requested = mergeNodeIds(args.nodeIds, args.nodeId) ?? parsed.nodeIds;
      const depth = args.depth ?? 4;
      let name: string | undefined;
      let roots: FigmaNode[] = [];
      const warnings: string[] = [];
      if (requested?.length) {
        const nodes = await figma.getNodes(fileKey, requested, { depth });
        name = nodes.name;
        for (const id of requested) {
          const doc = nodes.nodes[id]?.document as FigmaNode | undefined;
          if (doc) roots.push(doc);
          else warnings.push(`Node ${id} not found.`);
        }
      } else {
        const file = await figma.getFile(fileKey, { depth });
        name = file.name;
        roots = ((file.document as FigmaNode | undefined)?.children ?? []) as FigmaNode[];
      }
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
      let screenshot: Record<string, unknown> | undefined;
      const target = roots[0]?.id;
      if (args.includeScreenshot !== false && target) {
        try {
          const rendered = await figma.getImages(fileKey, [target], { format: "png", scale: 1 });
          const url = rendered.images?.[target] ?? rendered.images?.[target.replaceAll(":", "-")];
          if (!url) throw new Error("missing render URL");
          const image = await figma.fetchImage(url);
          screenshot = { nodeId: target, sha256: image.sha256, mime: image.mime, width: image.width, height: image.height };
          if (image.mime.startsWith("image/")) {
            content.push({ type: "image", data: image.data.toString("base64"), mimeType: image.mime });
          }
        } catch (err) {
          warnings.push(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      content.unshift({
        type: "text",
        text: JSON.stringify({
          schemaVersion: 1,
          fileKey,
          name,
          nodeIds: roots.map((r) => r.id),
          xml: roots.map((r) => nodeToXml(r)).join("\n"),
          texts: roots.flatMap((r) => collectFigjamTexts(r)),
          screenshot,
          ...(warnings.length ? { warnings } : {}),
        }),
      });
      return rawResult(content);
    }),
  );
}

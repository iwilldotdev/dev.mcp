import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireFigma } from "../config.js";
import { FigmaClient } from "../clients/figma.js";
import { buildDesignContext } from "../figma/design-context.js";
import {
  nodeToXml,
  parseFigmaFileKey,
  parseFigmaNodeIds,
  parseFigmaUrl,
  summarizeVariables,
  type FigmaNode,
} from "../figma/parse.js";
import type { Runtime } from "../runtime.js";
import { wrapTool } from "./result.js";

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
    "Gets the Figma document (GET /v1/files/:key). Use depth/ids to shrink the payload.",
    {
      ...fileKeyShape,
      depth: z.number().int().min(1).max(8).optional().describe("Tree depth."),
      ids: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Node IDs (comma-separated or array). URL node-id (1-2) is accepted."),
    },
    wrapTool(async (args) => {
      const fileKey = fileKeyFrom(args);
      const ids = parseFigmaNodeIds(args.ids);
      return client(runtime).getFile(fileKey, { depth: args.depth, ids });
    }),
  );

  server.tool(
    "figma_get_metadata",
    "Slim XML tree (id, name, type, size) via GET /v1/files/:key/nodes.",
    {
      ...fileKeyShape,
      nodeIds: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Nodes to include. If omitted, tries the URL node-id; otherwise uses the root document."),
      depth: z.number().int().min(1).max(8).optional(),
    },
    wrapTool(async (args) => {
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
    "Renders nodes as images (GET /v1/images/:key) and returns temporary URLs.",
    {
      ...fileKeyShape,
      nodeIds: z
        .union([z.string(), z.array(z.string())])
        .describe("Node IDs to render."),
      format: z.enum(["png", "jpg", "svg", "pdf"]).optional(),
      scale: z.number().min(0.01).max(4).optional(),
    },
    wrapTool(async (args) => {
      const fileKey = fileKeyFrom(args);
      const fromUrl = args.url ? parseFigmaUrl(args.url).nodeIds : undefined;
      const ids = parseFigmaNodeIds(args.nodeIds) ?? fromUrl;
      if (!ids?.length) throw new Error("Provide nodeIds (or a URL with node-id).");
      return client(runtime).getImages(fileKey, ids, {
        format: args.format,
        scale: args.scale,
      });
    }),
  );

  server.tool(
    "figma_get_variable_defs",
    "Local (and optionally published) variables for the file (GET /v1/files/:key/variables/...).",
    {
      ...fileKeyShape,
      includePublished: z.boolean().optional().describe("Also fetch published variables."),
    },
    wrapTool(async (args) => {
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
    "Implementation context (layout, fixed sizing, effects, text, hidden layers, masks, component variants, style names, screenshot URL) composed via REST. Variables are off unless includeVariables is true; a variables failure is a warning and does not drop nodes or truncate the tree. A node id returns its subtree until depth or the node/byte cap cuts it; a cut sets truncated and truncation.hint. A call without a node id is cut at file depth 3. Missing ids are listed in missingNodeIds. A screenshot failure is a warning and does not drop nodes. Rotation is passed through as REST returns it (unit not documented). Not the official MCP proprietary codegen.",
    {
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
    },
    wrapTool(async (args) => {
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
        }),
      );
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

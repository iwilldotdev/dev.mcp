import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConfluenceClient } from "../clients/confluence.js";
import { requireAtlassian } from "../config.js";
import type { Runtime } from "../runtime.js";
import { wrapTool } from "./result.js";

function client(runtime: Runtime): ConfluenceClient {
  return new ConfluenceClient(requireAtlassian(runtime.config), runtime.http);
}

const spaceId = z.string().describe("Numeric space ID (not the key).");
const pageId = z.string().describe("Page ID.");

export function registerConfluenceTools(server: McpServer, runtime: Runtime): void {
  server.tool(
    "confluence_get_spaces",
    "Lists spaces (GET /wiki/api/v2/spaces).",
    {
      keys: z.string().optional().describe("CSV keys, e.g. ENG,DOC."),
      type: z.string().optional(),
      limit: z.number().int().min(1).max(250).optional(),
      cursor: z.string().optional(),
    },
    wrapTool(async (args) => client(runtime).getSpaces(args)),
  );

  server.tool(
    "confluence_get_pages_in_space",
    "Pages in a space (GET /wiki/api/v2/spaces/{id}/pages).",
    {
      spaceId,
      title: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().int().min(1).max(250).optional(),
      cursor: z.string().optional(),
    },
    wrapTool(async (args) =>
      client(runtime).getPagesInSpace(args.spaceId, {
        title: args.title,
        status: args.status,
        limit: args.limit,
        cursor: args.cursor,
      }),
    ),
  );

  server.tool(
    "confluence_get_page",
    "Gets a page (GET /wiki/api/v2/pages/{id}).",
    {
      pageId,
      bodyFormat: z
        .string()
        .optional()
        .describe("storage (default), atlas_doc_format, view."),
    },
    wrapTool(async (args) => client(runtime).getPage(args.pageId, { bodyFormat: args.bodyFormat })),
  );

  server.tool(
    "confluence_get_page_descendants",
    "Page descendants (GET /wiki/api/v2/pages/{id}/descendants).",
    {
      pageId,
      depth: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(250).optional(),
      cursor: z.string().optional(),
    },
    wrapTool(async (args) =>
      client(runtime).getPageDescendants(args.pageId, {
        depth: args.depth,
        limit: args.limit,
        cursor: args.cursor,
      }),
    ),
  );

  server.tool(
    "confluence_get_page_footer_comments",
    "Footer comments (GET /wiki/api/v2/pages/{id}/footer-comments).",
    {
      pageId,
      limit: z.number().int().min(1).max(250).optional(),
      cursor: z.string().optional(),
    },
    wrapTool(async (args) =>
      client(runtime).getFooterComments(args.pageId, { limit: args.limit, cursor: args.cursor }),
    ),
  );

  server.tool(
    "confluence_get_page_inline_comments",
    "Inline comments (GET /wiki/api/v2/pages/{id}/inline-comments).",
    {
      pageId,
      limit: z.number().int().min(1).max(250).optional(),
      cursor: z.string().optional(),
    },
    wrapTool(async (args) =>
      client(runtime).getInlineComments(args.pageId, { limit: args.limit, cursor: args.cursor }),
    ),
  );

  server.tool(
    "confluence_search_cql",
    "CQL search (GET /wiki/rest/api/search).",
    {
      cql: z.string().describe("E.g. type=page AND space=ENG AND title~'API'"),
      limit: z.number().int().min(1).max(50).optional(),
      start: z.number().int().min(0).optional(),
      excerpt: z.string().optional(),
    },
    wrapTool(async (args) => client(runtime).searchCql(args)),
  );

  server.tool(
    "confluence_create_page",
    "Creates a page (POST /wiki/api/v2/pages). body in storage HTML or atlas_doc_format.",
    {
      spaceId,
      title: z.string(),
      parentId: z.string().optional(),
      status: z.enum(["current", "draft"]).optional(),
      bodyRepresentation: z.enum(["storage", "atlas_doc_format"]).optional(),
      bodyValue: z.string(),
    },
    wrapTool(async (args) =>
      client(runtime).createPage({
        spaceId: args.spaceId,
        title: args.title,
        parentId: args.parentId,
        status: args.status ?? "current",
        body: {
          representation: args.bodyRepresentation ?? "storage",
          value: args.bodyValue,
        },
      }),
    ),
  );

  server.tool(
    "confluence_update_page",
    "Updates a page (PUT /wiki/api/v2/pages/{id}). versionNumber is required.",
    {
      pageId,
      title: z.string(),
      versionNumber: z.number().int().min(1),
      spaceId: z.string().optional(),
      status: z.enum(["current", "draft"]).optional(),
      bodyRepresentation: z.enum(["storage", "atlas_doc_format"]).optional(),
      bodyValue: z.string(),
      versionMessage: z.string().optional(),
    },
    wrapTool(async (args) =>
      client(runtime).updatePage(args.pageId, {
        id: args.pageId,
        status: args.status ?? "current",
        title: args.title,
        spaceId: args.spaceId,
        body: {
          representation: args.bodyRepresentation ?? "storage",
          value: args.bodyValue,
        },
        version: {
          number: args.versionNumber,
          message: args.versionMessage,
        },
      }),
    ),
  );

  server.tool(
    "confluence_create_footer_comment",
    "Creates a footer comment (POST /wiki/api/v2/footer-comments).",
    {
      pageId,
      bodyRepresentation: z.enum(["storage", "atlas_doc_format"]).optional(),
      bodyValue: z.string(),
    },
    wrapTool(async (args) =>
      client(runtime).createFooterComment({
        pageId: args.pageId,
        body: {
          representation: args.bodyRepresentation ?? "storage",
          value: args.bodyValue,
        },
      }),
    ),
  );

  server.tool(
    "confluence_create_inline_comment",
    "Creates an inline comment (POST /wiki/api/v2/inline-comments).",
    {
      pageId,
      bodyRepresentation: z.enum(["storage", "atlas_doc_format"]).optional(),
      bodyValue: z.string(),
      inlineCommentProperties: z
        .record(z.unknown())
        .optional()
        .describe("Highlighted selection/text properties required by the v2 API."),
    },
    wrapTool(async (args) =>
      client(runtime).createInlineComment({
        pageId: args.pageId,
        body: {
          representation: args.bodyRepresentation ?? "storage",
          value: args.bodyValue,
        },
        inlineCommentProperties: args.inlineCommentProperties,
      }),
    ),
  );
}

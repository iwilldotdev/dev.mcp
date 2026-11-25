import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConfluenceClient } from "../clients/confluence.js";
import { requireAtlassian } from "../config.js";
import type { Runtime } from "../runtime.js";
import {
  bodyShape,
  type BodyArg,
  cloudIdShape,
  COLLECTION,
  type ContentType,
  contentTypeShape,
  decodeSnapshotToken,
  encodeSnapshotToken,
  toRepresentation,
} from "./confluence-support.js";
import { withCloudIdCheck } from "./cloud-id.js";
import { registerLegacyAlias, registerWriteTool } from "./register.js";
import { maxSaveBytes, precheckBytes, saveBytes } from "../save.js";
import { saveToFileShape, saveToShape, wrapSaveTool, wrapTool } from "./result.js";
import { sumPage } from "./summaries.js";

function client(runtime: Runtime): ConfluenceClient {
  return new ConfluenceClient(requireAtlassian(runtime.config), runtime.http);
}

const enc = encodeURIComponent;
const spaceId = z.string().describe("Numeric space ID (not the key).");
const pageId = z.string().describe("Page ID.");
const limit250 = z.number().int().min(1).max(250).optional();
const cursor = z.string().optional();
const commentTypeShape = z.enum(["footer", "inline"]);

type Obj = Record<string, any>;

// ---------- canonical implementations (shared with the legacy aliases) ----------

function listSpaces(c: ConfluenceClient, a: Obj) {
  return c.v2Get("/spaces", {
    ids: a.ids,
    keys: a.keys,
    type: a.type,
    status: a.status,
    limit: a.limit,
    cursor: a.cursor,
  });
}

async function resolveSpaceId(c: ConfluenceClient, idOrKey: string): Promise<string> {
  if (/^\d+$/.test(idOrKey)) return idOrKey;
  const res = await c.v2Get("/spaces", { keys: idOrKey, limit: 1 });
  const id = res?.results?.[0]?.id;
  if (!id) throw new Error(`Space not found for key '${idOrKey}'.`);
  return String(id);
}

function listContent(c: ConfluenceClient, a: Obj) {
  const type: "page" | "blogpost" = a.contentType ?? "page";
  const params = { title: a.title, status: a.status, sort: a.sort, limit: a.limit, cursor: a.cursor };
  if (a.spaceId) return c.v2Get(`/spaces/${enc(a.spaceId)}/${COLLECTION[type]}`, params);
  return c.v2Get(`/${COLLECTION[type]}`, params);
}

async function getContent(c: ConfluenceClient, a: Obj) {
  const type: ContentType = a.contentType ?? "page";
  const full = a.detail === "full";
  const data = await c.v2Get(
    `/${COLLECTION[type]}/${enc(a.contentId)}`,
    full ? { "body-format": a.bodyFormat ?? "storage" } : {},
  );
  if (!full && data && typeof data === "object") delete data.body;
  const version = data?.version?.number;
  return Number.isInteger(version)
    ? { ...data, snapshotToken: encodeSnapshotToken(String(data.id ?? a.contentId), version, type) }
    : data;
}

function createContent(c: ConfluenceClient, a: Obj) {
  const type: ContentType = a.contentType;
  const parentId = a.parent?.id ?? a.parentId;
  if (type === "page" || type === "blogpost") {
    if (!a.body) throw new Error(`body is required to create a ${type}.`);
    return c.v2Send("POST", `/${COLLECTION[type]}`, {
      spaceId: a.spaceId,
      title: a.title,
      parentId: type === "page" ? parentId : undefined,
      status: a.status ?? "current",
      body: toRepresentation(a.body as BodyArg),
    });
  }
  if (a.body) throw new Error(`A ${type} takes no body; omit it.`);
  return c.v2Send("POST", `/${COLLECTION[type]}`, { spaceId: a.spaceId, title: a.title, parentId });
}

async function updateContent(c: ConfluenceClient, a: Obj) {
  const type: "page" | "blogpost" = a.contentType;
  const tok = decodeSnapshotToken(a.snapshotToken);
  if (tok.id !== String(a.contentId) || tok.t !== type) {
    throw new Error(
      `snapshotToken belongs to ${tok.t} ${tok.id}, not ${type} ${a.contentId}. Read the content again with confluence_get_content.`,
    );
  }
  const cur = await c.v2Get(`/${COLLECTION[type]}/${enc(a.contentId)}`);
  const curVersion = cur?.version?.number;
  if (curVersion !== tok.v) {
    throw new Error(
      `Conflict: the ${type} changed since it was read (snapshotToken is version ${tok.v}, current is ${curVersion}). Read it again with confluence_get_content, merge, and retry.`,
    );
  }
  return c.v2Send("PUT", `/${COLLECTION[type]}/${enc(a.contentId)}`, {
    id: a.contentId,
    // Keep the current status (e.g. a draft stays a draft) unless the caller asks for another one.
    status: a.status ?? cur?.status ?? "current",
    title: a.title ?? cur.title,
    parentId: type === "page" ? a.parent?.id : undefined,
    body: toRepresentation(a.body as BodyArg),
    version: { number: tok.v + 1, message: a.versionMessage },
  });
}

async function listComments(c: ConfluenceClient, a: Obj) {
  const type: "page" | "blogpost" = a.contentType ?? "page";
  const base = `/${COLLECTION[type]}/${enc(a.contentId)}`;
  const params = { "body-format": a.bodyFormat, limit: a.limit, cursor: a.cursor };
  const which: string = a.commentType ?? "all";
  if (which === "footer") return c.v2Get(`${base}/footer-comments`, params);
  if (which === "inline") return c.v2Get(`${base}/inline-comments`, params);
  const [footer, inline] = await Promise.all([
    c.v2Get(`${base}/footer-comments`, params),
    c.v2Get(`${base}/inline-comments`, params),
  ]);
  return { footer, inline };
}

function createComment(c: ConfluenceClient, a: Obj) {
  const type: "page" | "blogpost" = a.contentType ?? "page";
  const target = type === "page" ? { pageId: a.contentId } : { blogPostId: a.contentId };
  const body = toRepresentation(a.body as BodyArg);
  if ((a.commentType ?? "footer") === "inline") {
    return c.v2Send("POST", "/inline-comments", {
      ...target,
      parentCommentId: a.parentCommentId,
      body,
      inlineCommentProperties: a.inlineCommentProperties,
    });
  }
  return c.v2Send("POST", "/footer-comments", { ...target, parentCommentId: a.parentCommentId, body });
}

const commentPath = (t: "footer" | "inline", id: string) => `/${t}-comments/${enc(id)}`;

async function updateComment(c: ConfluenceClient, a: Obj) {
  const t: "footer" | "inline" = a.commentType ?? "footer";
  let next = a.versionNumber as number | undefined;
  if (next === undefined) {
    const cur = await c.v2Get(commentPath(t, a.commentId));
    next = (cur?.version?.number ?? 0) + 1;
  }
  return c.v2Send("PUT", commentPath(t, a.commentId), {
    version: { number: next, message: a.versionMessage },
    body: toRepresentation(a.body as BodyArg),
  });
}

async function updateCommentResolution(c: ConfluenceClient, a: Obj) {
  const cur = await c.v2Get(commentPath("inline", a.commentId), { "body-format": "storage" });
  const value = cur?.body?.storage?.value;
  if (typeof value !== "string") {
    throw new Error(
      `Cannot change the resolution of inline comment ${a.commentId}: its storage body was not returned, and sending an empty body would erase the comment text. Nothing was changed.`,
    );
  }
  return c.v2Send("PUT", commentPath("inline", a.commentId), {
    version: { number: (cur?.version?.number ?? 0) + 1 },
    body: { representation: "storage", value },
    resolved: a.resolved,
  });
}

async function setTaskStatus(c: ConfluenceClient, taskId: string, status: "complete" | "incomplete") {
  return c.v2Send("PUT", `/tasks/${enc(taskId)}`, { id: taskId, status });
}

// ---------- registration ----------

export function registerConfluenceTools(rawServer: McpServer, runtime: Runtime): void {
  const server = withCloudIdCheck(rawServer, runtime);
  const W = "WRITE: ";

  // Spaces
  server.tool(
    "confluence_list_spaces",
    "Lists spaces (GET /wiki/api/v2/spaces).",
    {
      ...cloudIdShape,
      ids: z.string().optional().describe("CSV numeric space IDs."),
      keys: z.string().optional().describe("CSV keys, e.g. ENG,DOC."),
      type: z.string().optional().describe("global, personal, ..."),
      status: z.string().optional().describe("current or archived."),
      limit: limit250,
      cursor,
    },
    wrapTool(async (a) => listSpaces(client(runtime), a)),
  );

  registerLegacyAlias(server, runtime, "confluence_list_spaces", {
    name: "confluence_get_spaces",
    shape: {
      keys: z.string().optional().describe("CSV keys, e.g. ENG,DOC."),
      type: z.string().optional(),
      limit: limit250,
      cursor,
    },
    handler: wrapTool(async (a: Obj) => listSpaces(client(runtime), a)),
  });

  server.tool(
    "confluence_get_space",
    "Gets one space (GET /wiki/api/v2/spaces/{id}). spaceId may be the numeric ID or the space key.",
    {
      ...cloudIdShape,
      spaceId: z.string().describe("Numeric space ID or space key."),
      descriptionFormat: z.string().optional().describe("plain or view."),
      includeIcon: z.boolean().optional(),
    },
    wrapTool(async (a) => {
      const c = client(runtime);
      const id = await resolveSpaceId(c, a.spaceId);
      return c.v2Get(`/spaces/${enc(id)}`, {
        "description-format": a.descriptionFormat,
        "include-icon": a.includeIcon,
      });
    }),
  );

  // Content (pages, blog posts, and the other types REST v2 can read)
  server.tool(
    "confluence_list_content",
    "Lists pages or blog posts, optionally in one space (GET /wiki/api/v2/spaces/{id}/pages|blogposts, or /pages|/blogposts).",
    {
      ...cloudIdShape,
      spaceId: spaceId.optional(),
      contentType: contentTypeShape.optional(),
      title: z.string().optional(),
      status: z.string().optional(),
      sort: z.string().optional(),
      limit: limit250,
      cursor,
    },
    wrapTool(async (a) => listContent(client(runtime), a)),
  );

  registerLegacyAlias(server, runtime, "confluence_list_content", {
    name: "confluence_get_pages_in_space",
    shape: {
      spaceId,
      title: z.string().optional(),
      status: z.string().optional(),
      limit: limit250,
      cursor,
    },
    handler: wrapTool(async (a: Obj) => listContent(client(runtime), { ...a, contentType: "page" })),
  });

  server.tool(
    "confluence_get_content",
    "Gets a page, blog post, folder, whiteboard or database (GET /wiki/api/v2/{pages|blogposts|folders|whiteboards|databases}/{id}). detail=summary (default) omits the body; detail=full returns it. Pages and blog posts also return snapshotToken: pass it to confluence_update_content. To keep or hand off the payload, pass save_to (absolute path); the response becomes a compact summary.",
    {
      ...cloudIdShape,
      ...saveToShape,
      contentId: z.string().describe("Content ID."),
      contentType: z.enum(["page", "blogpost", "folder", "whiteboard", "database"]).optional().describe("Default page."),
      detail: z.enum(["summary", "full"]).optional().describe("summary (default) or full (includes the body)."),
      bodyFormat: z.string().optional().describe("With detail=full: storage (default), atlas_doc_format, view."),
    },
    wrapSaveTool("confluence_get_content", sumPage, async (a) => getContent(client(runtime), a)),
  );

  registerLegacyAlias(server, runtime, "confluence_get_content", {
    name: "confluence_get_page",
    shape: {
      ...saveToShape,
      pageId,
      bodyFormat: z.string().optional().describe("storage (default), atlas_doc_format, view."),
    },
    handler: wrapSaveTool("confluence_get_page", sumPage, async (a: Obj) =>
      client(runtime).getPage(a.pageId, { bodyFormat: a.bodyFormat }),
    ),
  });

  registerWriteTool(server, runtime,
    "confluence_create_content",
    W +
      "Creates content (POST /wiki/api/v2/{pages|blogposts|folders|whiteboards|databases}). page and blog post need body {format: storage|atlas_doc_format, value}; markdown is rejected. Folders, whiteboards and databases take only spaceId, title and parent.",
    {
      ...cloudIdShape,
      contentType: z.enum(["page", "blogpost", "folder", "whiteboard", "database"]),
      spaceId,
      title: z.string(),
      parent: z.object({ id: z.string() }).optional().describe("Parent content {id}. Ignored for blog posts."),
      status: z.enum(["current", "draft"]).optional(),
      body: bodyShape.optional(),
    },
    wrapTool(async (a) => createContent(client(runtime), a)),
  );

  registerLegacyAlias(server, runtime, "confluence_create_content", {
    name: "confluence_create_page",
    shape: {
      spaceId,
      title: z.string(),
      parentId: z.string().optional(),
      status: z.enum(["current", "draft"]).optional(),
      bodyRepresentation: z.enum(["storage", "atlas_doc_format"]).optional(),
      bodyValue: z.string(),
    },
    handler: wrapTool(async (a: Obj) =>
      createContent(client(runtime), {
        contentType: "page",
        spaceId: a.spaceId,
        title: a.title,
        parentId: a.parentId,
        status: a.status,
        body: { format: a.bodyRepresentation ?? "storage", value: a.bodyValue },
      }),
    ),
  });

  registerWriteTool(server, runtime,
    "confluence_update_content",
    W +
      "Updates a page or blog post (PUT /wiki/api/v2/{pages|blogposts}/{id}). snapshotToken (from confluence_get_content) is required; the update fails with a conflict if the content changed since that read. body replaces the whole body. title defaults to the current title.",
    {
      ...cloudIdShape,
      contentId: z.string(),
      contentType: contentTypeShape,
      snapshotToken: z.string().describe("Token returned by confluence_get_content."),
      title: z.string().optional(),
      body: bodyShape,
      parent: z.object({ id: z.string() }).optional().describe("Moves a page under this parent."),
      status: z.enum(["current", "draft"]).optional(),
      versionMessage: z.string().optional(),
    },
    wrapTool(async (a) => updateContent(client(runtime), a)),
  );

  registerLegacyAlias(server, runtime, "confluence_update_content", {
    name: "confluence_update_page",
    shape: {
      pageId,
      title: z.string(),
      versionNumber: z.number().int().min(1),
      spaceId: z.string().optional(),
      status: z.enum(["current", "draft"]).optional(),
      bodyRepresentation: z.enum(["storage", "atlas_doc_format"]).optional(),
      bodyValue: z.string(),
      versionMessage: z.string().optional(),
    },
    handler: wrapTool(async (a: Obj) => {
      const c = client(runtime);
      // Without an explicit status keep the page's current one instead of forcing "current".
      const status = a.status ?? (await c.v2Get(`/pages/${enc(a.pageId)}`))?.status ?? "current";
      return c.updatePage(a.pageId, {
        id: a.pageId,
        status,
        title: a.title,
        spaceId: a.spaceId,
        body: { representation: a.bodyRepresentation ?? "storage", value: a.bodyValue },
        version: { number: a.versionNumber, message: a.versionMessage },
      });
    }),
  }, "explicit versionNumber instead of snapshotToken");

  server.tool(
    "confluence_get_page_descendants",
    "Page descendants (GET /wiki/api/v2/pages/{id}/descendants).",
    {
      ...cloudIdShape,
      pageId,
      depth: z.number().int().min(1).optional(),
      limit: limit250,
      cursor,
    },
    wrapTool(async (a) =>
      client(runtime).getPageDescendants(a.pageId, { depth: a.depth, limit: a.limit, cursor: a.cursor }),
    ),
  );

  // Versions
  server.tool(
    "confluence_list_content_versions",
    "Lists versions of a page or blog post (GET /wiki/api/v2/{pages|blogposts}/{id}/versions).",
    {
      ...cloudIdShape,
      contentId: z.string(),
      contentType: contentTypeShape.optional(),
      bodyFormat: z.string().optional(),
      sort: z.string().optional(),
      limit: limit250,
      cursor,
    },
    wrapTool(async (a) =>
      client(runtime).v2Get(`/${COLLECTION[a.contentType ?? "page"]}/${enc(a.contentId)}/versions`, {
        "body-format": a.bodyFormat,
        sort: a.sort,
        limit: a.limit,
        cursor: a.cursor,
      }),
    ),
  );

  server.tool(
    "confluence_get_content_version",
    "Gets one version of a page or blog post (GET /wiki/api/v2/{pages|blogposts}/{id}/versions/{n}).",
    {
      ...cloudIdShape,
      contentId: z.string(),
      contentType: contentTypeShape.optional(),
      versionNumber: z.number().int().min(1),
    },
    wrapTool(async (a) =>
      client(runtime).v2Get(
        `/${COLLECTION[a.contentType ?? "page"]}/${enc(a.contentId)}/versions/${a.versionNumber}`,
      ),
    ),
  );

  // Comments
  server.tool(
    "confluence_list_comments",
    "Lists comments of a page or blog post (GET /wiki/api/v2/{pages|blogposts}/{id}/footer-comments and/or inline-comments). commentType all (default) returns {footer, inline}.",
    {
      ...cloudIdShape,
      contentId: z.string(),
      contentType: contentTypeShape.optional(),
      commentType: z.enum(["footer", "inline", "all"]).optional(),
      bodyFormat: z.string().optional(),
      limit: limit250,
      cursor,
    },
    wrapTool(async (a) => listComments(client(runtime), a)),
  );

  for (const [name, commentType, label] of [
    ["confluence_get_page_footer_comments", "footer", "Footer comments (GET /wiki/api/v2/pages/{id}/footer-comments)."],
    ["confluence_get_page_inline_comments", "inline", "Inline comments (GET /wiki/api/v2/pages/{id}/inline-comments)."],
  ] as const) {
    registerLegacyAlias(
      server,
      runtime,
      "confluence_list_comments",
      {
        name,
        shape: { pageId, limit: limit250, cursor },
        handler: wrapTool(async (a: Obj) =>
          listComments(client(runtime), { contentId: a.pageId, commentType, limit: a.limit, cursor: a.cursor }),
        ),
      },
      label,
    );
  }

  server.tool(
    "confluence_get_comment",
    "Gets one comment (GET /wiki/api/v2/footer-comments/{id} or /inline-comments/{id}).",
    {
      ...cloudIdShape,
      commentId: z.string(),
      commentType: commentTypeShape.optional().describe("footer (default) or inline."),
      bodyFormat: z.string().optional(),
    },
    wrapTool(async (a) =>
      client(runtime).v2Get(commentPath(a.commentType ?? "footer", a.commentId), { "body-format": a.bodyFormat }),
    ),
  );

  registerWriteTool(server, runtime,
    "confluence_create_comment",
    W +
      "Creates a footer or inline comment, or a reply with parentCommentId (POST /wiki/api/v2/footer-comments or /inline-comments). Inline comments need inlineCommentProperties.",
    {
      ...cloudIdShape,
      contentId: z.string().describe("Page or blog post ID."),
      contentType: contentTypeShape.optional(),
      commentType: commentTypeShape.optional().describe("footer (default) or inline."),
      body: bodyShape,
      parentCommentId: z.string().optional(),
      inlineCommentProperties: z
        .record(z.unknown())
        .optional()
        .describe("Highlighted selection/text properties required by the v2 API for inline comments."),
    },
    wrapTool(async (a) => createComment(client(runtime), a)),
  );

  registerLegacyAlias(server, runtime, "confluence_create_comment", {
    name: "confluence_create_footer_comment",
    shape: {
      pageId,
      bodyRepresentation: z.enum(["storage", "atlas_doc_format"]).optional(),
      bodyValue: z.string(),
    },
    handler: wrapTool(async (a: Obj) =>
      createComment(client(runtime), {
        contentId: a.pageId,
        commentType: "footer",
        body: { format: a.bodyRepresentation ?? "storage", value: a.bodyValue },
      }),
    ),
  });

  registerLegacyAlias(server, runtime, "confluence_create_comment", {
    name: "confluence_create_inline_comment",
    shape: {
      pageId,
      bodyRepresentation: z.enum(["storage", "atlas_doc_format"]).optional(),
      bodyValue: z.string(),
      inlineCommentProperties: z
        .record(z.unknown())
        .optional()
        .describe("Highlighted selection/text properties required by the v2 API."),
    },
    handler: wrapTool(async (a: Obj) =>
      createComment(client(runtime), {
        contentId: a.pageId,
        commentType: "inline",
        body: { format: a.bodyRepresentation ?? "storage", value: a.bodyValue },
        inlineCommentProperties: a.inlineCommentProperties,
      }),
    ),
  });

  registerWriteTool(server, runtime,
    "confluence_update_comment",
    W +
      "Edits a comment body (PUT /wiki/api/v2/footer-comments/{id} or /inline-comments/{id}). The next version number is read from the comment unless versionNumber is given.",
    {
      ...cloudIdShape,
      commentId: z.string(),
      commentType: commentTypeShape.optional().describe("footer (default) or inline."),
      body: bodyShape,
      versionNumber: z.number().int().min(1).optional().describe("New version number (current + 1 by default)."),
      versionMessage: z.string().optional(),
    },
    wrapTool(async (a) => updateComment(client(runtime), a)),
  );

  registerWriteTool(server, runtime,
    "confluence_update_comment_resolution",
    W +
      "Resolves or reopens an inline comment (PUT /wiki/api/v2/inline-comments/{id} with resolved). Re-sends the current body unchanged.",
    {
      ...cloudIdShape,
      commentId: z.string(),
      resolved: z.boolean(),
    },
    wrapTool(async (a) => updateCommentResolution(client(runtime), a)),
  );

  // Search
  server.tool(
    "confluence_search",
    "CQL search (GET /wiki/rest/api/search).",
    {
      ...cloudIdShape,
      cql: z.string().describe("E.g. type=page AND space=ENG AND title~'API'"),
      limit: z.number().int().min(1).max(50).optional(),
      start: z.number().int().min(0).optional(),
      cursor,
      excerpt: z.string().optional(),
    },
    wrapTool(async ({ cloudId: _ignored, ...a }) => client(runtime).searchCql(a)),
  );

  registerLegacyAlias(server, runtime, "confluence_search", {
    name: "confluence_search_cql",
    shape: {
      cql: z.string().describe("E.g. type=page AND space=ENG AND title~'API'"),
      limit: z.number().int().min(1).max(50).optional(),
      start: z.number().int().min(0).optional(),
      excerpt: z.string().optional(),
    },
    handler: wrapTool(async (a: Obj) => client(runtime).searchCql(a as any)),
  });

  // Attachments
  server.tool(
    "confluence_list_attachments",
    "Lists attachments of a page or blog post (GET /wiki/api/v2/{pages|blogposts}/{id}/attachments).",
    {
      ...cloudIdShape,
      contentId: z.string(),
      contentType: contentTypeShape.optional(),
      mediaType: z.string().optional(),
      filename: z.string().optional(),
      status: z.string().optional(),
      sort: z.string().optional(),
      limit: limit250,
      cursor,
    },
    wrapTool(async (a) =>
      client(runtime).v2Get(`/${COLLECTION[a.contentType ?? "page"]}/${enc(a.contentId)}/attachments`, {
        mediaType: a.mediaType,
        filename: a.filename,
        status: a.status,
        sort: a.sort,
        limit: a.limit,
        cursor: a.cursor,
      }),
    ),
  );

  server.tool(
    "confluence_get_attachment",
    "Gets attachment metadata (GET /wiki/api/v2/attachments/{id}).",
    { ...cloudIdShape, attachmentId: z.string(), version: z.number().int().min(1).optional() },
    wrapTool(async (a) => client(runtime).v2Get(`/attachments/${enc(a.attachmentId)}`, { version: a.version })),
  );

  server.tool(
    "confluence_download_attachment",
    "Gets attachment metadata (GET /wiki/api/v2/attachments/{id}). Without save_to returns the metadata and absolute download URL. With save_to (file or directory) downloads the bytes from the attachment download link (the Atlassian credentials are not forwarded to any other host on redirect) and returns a compact summary {saved_to, bytes, sha256, kind, summary}.",
    { ...cloudIdShape, attachmentId: z.string(), ...saveToFileShape },
    wrapTool(async (a: { attachmentId: string; save_to?: string; overwrite?: boolean }) => {
      const c = client(runtime);
      if (a.save_to) await precheckBytes(a.save_to, { overwrite: a.overwrite }); // before any network call
      const meta = await c.v2Get(`/attachments/${enc(a.attachmentId)}`);
      const link = meta?.downloadLink ?? meta?._links?.download;
      if (!a.save_to) {
        return {
          attachment: meta,
          downloadUrl: c.downloadUrl(link),
          note: "Not saved: pass save_to (file or directory) to download the bytes.",
        };
      }
      const fileName = typeof meta?.title === "string" ? meta.title : undefined;
      await precheckBytes(a.save_to, { overwrite: a.overwrite, fileName });
      const dl = await c.downloadAttachment(link, maxSaveBytes());
      const saved = await saveBytes(a.save_to, dl.data, { overwrite: a.overwrite, fileName });
      return {
        ...saved,
        summary: { id: meta?.id, title: meta?.title, mediaType: meta?.mediaType ?? dl.mime, declaredSize: meta?.fileSize },
      };
    }),
  );

  // Tasks
  server.tool(
    "confluence_list_tasks",
    "Lists tasks (GET /wiki/api/v2/tasks).",
    {
      ...cloudIdShape,
      status: z.enum(["complete", "incomplete"]).optional(),
      spaceId: z.string().optional(),
      pageId: z.string().optional(),
      blogPostId: z.string().optional(),
      createdBy: z.string().optional().describe("Account ID."),
      assignedTo: z.string().optional().describe("Account ID."),
      completedBy: z.string().optional().describe("Account ID."),
      bodyFormat: z.string().optional(),
      limit: limit250,
      cursor,
    },
    wrapTool(async (a) =>
      client(runtime).v2Get("/tasks", {
        status: a.status,
        "space-id": a.spaceId,
        "page-id": a.pageId,
        "blogpost-id": a.blogPostId,
        "created-by": a.createdBy,
        "assigned-to": a.assignedTo,
        "completed-by": a.completedBy,
        "body-format": a.bodyFormat,
        limit: a.limit,
        cursor: a.cursor,
      }),
    ),
  );

  server.tool(
    "confluence_get_task",
    "Gets one task (GET /wiki/api/v2/tasks/{id}).",
    { ...cloudIdShape, taskId: z.string(), bodyFormat: z.string().optional() },
    wrapTool(async (a) => client(runtime).v2Get(`/tasks/${enc(a.taskId)}`, { "body-format": a.bodyFormat })),
  );

  registerWriteTool(server, runtime,
    "confluence_complete_task",
    W + "Marks a task complete (PUT /wiki/api/v2/tasks/{id} with status complete).",
    { ...cloudIdShape, taskId: z.string() },
    wrapTool(async (a) => setTaskStatus(client(runtime), a.taskId, "complete")),
  );

  registerWriteTool(server, runtime,
    "confluence_reopen_task",
    W + "Reopens a task (PUT /wiki/api/v2/tasks/{id} with status incomplete).",
    { ...cloudIdShape, taskId: z.string() },
    wrapTool(async (a) => setTaskStatus(client(runtime), a.taskId, "incomplete")),
  );

  // Labels
  registerWriteTool(server, runtime,
    "confluence_add_labels_to_content",
    W + "Adds global labels to content (POST /wiki/rest/api/content/{id}/label).",
    {
      ...cloudIdShape,
      contentId: z.string(),
      labels: z.array(z.string().min(1)).min(1).describe("Label names."),
    },
    wrapTool(async (a) =>
      client(runtime).restSend(
        "POST",
        `/content/${enc(a.contentId)}/label`,
        (a.labels as string[]).map((name) => ({ prefix: "global", name })),
      ),
    ),
  );
}

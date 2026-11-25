import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JiraClient } from "../clients/jira.js";
import { requireAtlassian } from "../config.js";
import type { Runtime } from "../runtime.js";
import { registerWriteTool } from "./register.js";
import { maxSaveBytes, precheckBytes, saveBytes } from "../save.js";
import { saveToFileShape, saveToShape, wrapSaveTool, wrapTool } from "./result.js";

export const cloudIdShape = {
  cloudId: z.string().optional().describe("Ignored: dev.mcp serves the configured Atlassian site."),
};

type Rec = Record<string, unknown>;

/** Generic summary for list payloads: pagination fields plus the size of every array. */
export function sumGeneric(p: unknown): Rec {
  if (Array.isArray(p)) return { count: p.length };
  if (!p || typeof p !== "object") return {};
  const out: Rec = {};
  for (const [k, v] of Object.entries(p as Rec)) {
    if (Array.isArray(v)) out[`${k}_count`] = v.length;
    else if (["total", "startAt", "maxResults", "isLast", "nextPageToken"].includes(k)) out[k] = v;
  }
  return out;
}

const page = {
  startAt: z.number().int().min(0).optional(),
  maxResults: z.number().int().min(1).max(100).optional(),
};

/** New (non-renamed) tranche 1 Jira tools. */
export function registerJiraExtraTools(server: McpServer, runtime: Runtime): void {
  const c = () => new JiraClient(requireAtlassian(runtime.config), runtime.http);
  const key = (id: string) => encodeURIComponent(id);

  const read = (
    name: string,
    description: string,
    shape: z.ZodRawShape,
    run: (cl: JiraClient, args: any) => Promise<unknown>,
    save = false,
  ) => {
    if (save) {
      server.tool(
        name,
        `${description} To keep or hand off the payload, pass save_to (absolute .json path); the response becomes a compact summary.`,
        { ...cloudIdShape, ...shape, ...saveToShape },
        wrapSaveTool(name, sumGeneric, async (args: any) => run(c(), args)),
      );
    } else {
      server.tool(name, description, { ...cloudIdShape, ...shape }, wrapTool(async (args: any) => run(c(), args)));
    }
  };

  const issue = z.string().describe("Key or ID, e.g. ABC-123.");

  read(
    "jira_list_issue_comments",
    "Lists comments of an issue (GET /rest/api/3/issue/{issueIdOrKey}/comment). Read-only. For the rich thread with images use jira_get_comments.",
    {
      issueIdOrKey: issue,
      ...page,
      orderBy: z.string().optional().describe("created or -created."),
      expand: z.string().optional().describe("E.g. renderedBody."),
    },
    (cl, a) =>
      cl.rest("GET", `/issue/${key(a.issueIdOrKey)}/comment`, {
        query: { startAt: a.startAt, maxResults: a.maxResults, orderBy: a.orderBy, expand: a.expand },
      }),
    true,
  );

  read(
    "jira_list_issue_changelogs",
    "Lists the change history of an issue (GET /rest/api/3/issue/{issueIdOrKey}/changelog). Read-only.",
    { issueIdOrKey: issue, ...page },
    (cl, a) =>
      cl.rest("GET", `/issue/${key(a.issueIdOrKey)}/changelog`, {
        query: { startAt: a.startAt, maxResults: a.maxResults },
      }),
    true,
  );

  read(
    "jira_list_issue_worklogs",
    "Lists worklogs of an issue (GET /rest/api/3/issue/{issueIdOrKey}/worklog). Read-only.",
    { issueIdOrKey: issue, ...page },
    (cl, a) =>
      cl.rest("GET", `/issue/${key(a.issueIdOrKey)}/worklog`, {
        query: { startAt: a.startAt, maxResults: a.maxResults },
      }),
  );

  read(
    "jira_list_issue_assignable_users",
    "Lists users that can be assigned to an issue or project (GET /rest/api/3/user/assignable/search). Read-only. Give issueIdOrKey or project.",
    {
      issueIdOrKey: z.string().optional().describe("Issue key or ID (sent as issueKey)."),
      project: z.string().optional().describe("Project key (used when no issue is given)."),
      query: z.string().optional().describe("Name or email fragment."),
      ...page,
    },
    (cl, a) =>
      cl.rest("GET", "/user/assignable/search", {
        query: {
          issueKey: a.issueIdOrKey,
          project: a.project,
          query: a.query,
          startAt: a.startAt,
          maxResults: a.maxResults,
        },
      }),
  );

  read("jira_get_current_user", "Returns the authenticated Jira user (GET /rest/api/3/myself). Read-only.", {}, (cl) =>
    cl.rest("GET", "/myself"),
  );

  read(
    "jira_get_user",
    "Gets a Jira user by accountId (GET /rest/api/3/user?accountId=). Read-only.",
    { accountId: z.string() },
    (cl, a) => cl.rest("GET", "/user", { query: { accountId: a.accountId } }),
  );

  read("jira_list_statuses", "Lists all issue statuses (GET /rest/api/3/status). Read-only.", {}, (cl) =>
    cl.rest("GET", "/status"),
  );

  read(
    "jira_list_project_components",
    "Lists components of a project (GET /rest/api/3/project/{projectIdOrKey}/components). Read-only.",
    { projectIdOrKey: z.string() },
    (cl, a) => cl.rest("GET", `/project/${key(a.projectIdOrKey)}/components`),
  );

  read(
    "jira_get_project_versions",
    "Lists versions of a project (GET /rest/api/3/project/{projectIdOrKey}/versions). Read-only.",
    { projectIdOrKey: z.string() },
    (cl, a) => cl.rest("GET", `/project/${key(a.projectIdOrKey)}/versions`),
  );

  read(
    "jira_list_boards",
    "Lists agile boards (GET /rest/agile/1.0/board). Read-only.",
    {
      projectKeyOrId: z.string().optional(),
      type: z.string().optional().describe("scrum, kanban or simple."),
      name: z.string().optional(),
      ...page,
    },
    (cl, a) =>
      cl.rest("GET", "/board", {
        agile: true,
        query: { projectKeyOrId: a.projectKeyOrId, type: a.type, name: a.name, startAt: a.startAt, maxResults: a.maxResults },
      }),
  );

  read(
    "jira_get_board_config",
    "Gets the configuration of a board (GET /rest/agile/1.0/board/{boardId}/configuration). Read-only.",
    { boardId: z.number().int() },
    (cl, a) => cl.rest("GET", `/board/${a.boardId}/configuration`, { agile: true }),
  );

  read(
    "jira_get_board_issue_data",
    "Lists issues on a board (GET /rest/agile/1.0/board/{boardId}/issue). Read-only.",
    {
      boardId: z.number().int(),
      jql: z.string().optional(),
      fields: z.string().optional().describe("CSV fields."),
      ...page,
    },
    (cl, a) =>
      cl.rest("GET", `/board/${a.boardId}/issue`, {
        agile: true,
        query: { jql: a.jql, fields: a.fields, startAt: a.startAt, maxResults: a.maxResults },
      }),
    true,
  );

  read(
    "jira_list_board_sprints",
    "Lists sprints of a board (GET /rest/agile/1.0/board/{boardId}/sprint). Read-only.",
    { boardId: z.number().int(), state: z.string().optional().describe("CSV of future, active, closed."), ...page },
    (cl, a) =>
      cl.rest("GET", `/board/${a.boardId}/sprint`, {
        agile: true,
        query: { state: a.state, startAt: a.startAt, maxResults: a.maxResults },
      }),
  );

  read(
    "jira_get_board_sprint_data",
    "Lists issues of a sprint (GET /rest/agile/1.0/board/{boardId}/sprint/{sprintId}/issue, or /sprint/{sprintId}/issue without boardId). Read-only.",
    {
      sprintId: z.number().int(),
      boardId: z.number().int().optional(),
      jql: z.string().optional(),
      fields: z.string().optional().describe("CSV fields."),
      ...page,
    },
    (cl, a) =>
      cl.rest(
        "GET",
        a.boardId !== undefined ? `/board/${a.boardId}/sprint/${a.sprintId}/issue` : `/sprint/${a.sprintId}/issue`,
        { agile: true, query: { jql: a.jql, fields: a.fields, startAt: a.startAt, maxResults: a.maxResults } },
      ),
    true,
  );

  read(
    "jira_list_filters",
    "Searches saved filters (GET /rest/api/3/filter/search). Read-only.",
    {
      filterName: z.string().optional(),
      accountId: z.string().optional().describe("Owner accountId."),
      expand: z.string().optional().describe("E.g. jql."),
      ...page,
    },
    (cl, a) =>
      cl.rest("GET", "/filter/search", {
        query: { filterName: a.filterName, accountId: a.accountId, expand: a.expand, startAt: a.startAt, maxResults: a.maxResults },
      }),
  );

  read(
    "jira_list_dashboards",
    "Lists dashboards (GET /rest/api/3/dashboard). Read-only.",
    { filter: z.string().optional().describe("my or favourite."), ...page },
    (cl, a) =>
      cl.rest("GET", "/dashboard", { query: { filter: a.filter, startAt: a.startAt, maxResults: a.maxResults } }),
  );

  server.tool(
    "jira_download_issue_attachment",
    "Reads attachment metadata (GET /rest/api/3/attachment/{attachmentId}). Without save_to returns the metadata and content URL. With save_to (file or directory) downloads the bytes (GET /rest/api/3/attachment/content/{id}; the Jira credentials are not forwarded to any other host on redirect) and returns a compact summary {saved_to, bytes, sha256, kind, summary}.",
    { ...cloudIdShape, attachmentId: z.string(), ...saveToFileShape },
    wrapTool(async (a: { attachmentId: string; save_to?: string; overwrite?: boolean }) => {
      const cl = c();
      if (a.save_to) await precheckBytes(a.save_to, { overwrite: a.overwrite }); // before any network call
      const meta = (await cl.rest("GET", `/attachment/${key(a.attachmentId)}`)) as Rec;
      if (!a.save_to) {
        return {
          id: meta.id,
          filename: meta.filename,
          mimeType: meta.mimeType,
          size: meta.size,
          content: meta.content,
          note: "Not saved: pass save_to (file or directory) to download the bytes.",
          metadata: meta,
        };
      }
      const fileName = typeof meta.filename === "string" ? meta.filename : undefined;
      await precheckBytes(a.save_to, { overwrite: a.overwrite, fileName });
      const dl = await cl.downloadAttachment(a.attachmentId, maxSaveBytes());
      const saved = await saveBytes(a.save_to, dl.data, { overwrite: a.overwrite, fileName });
      return {
        ...saved,
        summary: { id: meta.id, filename: meta.filename, mimeType: dl.mime, declaredSize: meta.size },
      };
    }),
  );

  registerWriteTool(server, runtime,
    "jira_watch_issue",
    "WRITES: adds (watch: true, default) or removes (watch: false) a watcher on an issue (POST or DELETE /rest/api/3/issue/{issueIdOrKey}/watchers). Without accountId, the authenticated user is used.",
    {
      ...cloudIdShape,
      issueIdOrKey: issue,
      accountId: z.string().optional(),
      watch: z.boolean().optional().describe("Default true. false stops watching."),
    },
    wrapTool(async (a: { issueIdOrKey: string; accountId?: string; watch?: boolean }) => {
      const cl = c();
      const path = `/issue/${key(a.issueIdOrKey)}/watchers`;
      if (a.watch === false) {
        const accountId = a.accountId ?? ((await cl.rest("GET", "/myself")) as { accountId: string }).accountId;
        return cl.rest("DELETE", path, { query: { accountId } });
      }
      return cl.rest("POST", path, { body: a.accountId ?? undefined });
    }),
  );
}

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { maybeAdf, normalizeIssue } from "../adf.js";
import { JiraClient } from "../clients/jira.js";
import { requireAtlassian } from "../config.js";
import type { Runtime } from "../runtime.js";
import { wrapTool } from "./result.js";

function client(runtime: Runtime): JiraClient {
  return new JiraClient(requireAtlassian(runtime.config), runtime.http);
}

export function registerJiraTools(server: McpServer, runtime: Runtime): void {
  server.tool(
    "jira_get_issue",
    "Gets a Jira issue (GET /rest/api/3/issue/{key}).",
    {
      issueIdOrKey: z.string().describe("Key or ID, e.g. ABC-123."),
      fields: z.string().optional().describe("CSV fields, e.g. summary,status,assignee."),
      expand: z.string().optional(),
    },
    wrapTool(async (args) =>
      client(runtime).getIssue(args.issueIdOrKey, { fields: args.fields, expand: args.expand }),
    ),
  );

  server.tool(
    "jira_normalize_issue",
    "Reads an issue plus remote links and returns schemaVersion 1 text, acceptance criteria, links, referenced attachments, and explicit unknowns. ADF stays data; it is not executed.",
    {
      issueIdOrKey: z.string().describe("Key or ID, e.g. ABC-123."),
      fields: z.string().optional().describe("CSV fields. Omit for the Jira default set."),
    },
    wrapTool(async (args) => {
      const jira = client(runtime);
      const [issue, remoteLinks] = await Promise.all([
        jira.getIssue(args.issueIdOrKey, { fields: args.fields }),
        jira.getRemoteIssueLinks(args.issueIdOrKey),
      ]);
      return normalizeIssue(issue, remoteLinks);
    }),
  );

  server.tool(
    "jira_search_jql",
    "Search issues with JQL (POST /rest/api/3/search/jql).",
    {
      jql: z.string(),
      maxResults: z.number().int().min(1).max(100).optional(),
      nextPageToken: z.string().optional(),
      fields: z.array(z.string()).optional(),
      expand: z.string().optional(),
    },
    wrapTool(async (args) => client(runtime).searchJql(args)),
  );

  server.tool(
    "jira_get_projects",
    "Lists Jira projects (GET /rest/api/3/project/search).",
    {
      query: z.string().optional(),
      startAt: z.number().int().min(0).optional(),
      maxResults: z.number().int().min(1).max(100).optional(),
    },
    wrapTool(async (args) => client(runtime).getProjects(args)),
  );

  server.tool(
    "jira_get_issue_types_metadata",
    "Issue type metadata / create fields (GET /issue/createmeta/{project}/issuetypes).",
    {
      projectIdOrKey: z.string(),
      issueTypeId: z.string().optional().describe("If set, returns fields for that type."),
    },
    wrapTool(async (args) =>
      client(runtime).getIssueTypesMetadata(args.projectIdOrKey, args.issueTypeId),
    ),
  );

  server.tool(
    "jira_get_transitions",
    "Available transitions for an issue (GET /rest/api/3/issue/{key}/transitions).",
    { issueIdOrKey: z.string() },
    wrapTool(async (args) => client(runtime).getTransitions(args.issueIdOrKey)),
  );

  server.tool(
    "jira_create_issue",
    "Creates an issue (POST /rest/api/3/issue). Plain-text description is converted to ADF.",
    {
      projectKey: z.string(),
      summary: z.string(),
      issueType: z.string().describe("Type name or ID (e.g. Task, Bug)."),
      description: z.union([z.string(), z.record(z.unknown())]).optional(),
      assigneeAccountId: z.string().optional(),
      extraFields: z.record(z.unknown()).optional().describe("Extra fields under fields."),
    },
    wrapTool(async (args) => {
      const fields: Record<string, unknown> = {
        project: { key: args.projectKey },
        summary: args.summary,
        issuetype: /^\d+$/.test(args.issueType)
          ? { id: args.issueType }
          : { name: args.issueType },
        ...(args.extraFields ?? {}),
      };
      if (args.description !== undefined) fields.description = maybeAdf(args.description);
      if (args.assigneeAccountId) fields.assignee = { accountId: args.assigneeAccountId };
      return client(runtime).createIssue({ fields });
    }),
  );

  server.tool(
    "jira_edit_issue",
    "Updates an issue (PUT /rest/api/3/issue/{key}).",
    {
      issueIdOrKey: z.string(),
      fields: z.record(z.unknown()).optional(),
      update: z.record(z.unknown()).optional(),
    },
    wrapTool(async (args) => {
      const payload: Record<string, unknown> = {};
      if (args.fields) {
        const fields = { ...args.fields };
        if (fields.description !== undefined) fields.description = maybeAdf(fields.description);
        payload.fields = fields;
      }
      if (args.update) payload.update = args.update;
      return client(runtime).editIssue(args.issueIdOrKey, payload);
    }),
  );

  server.tool(
    "jira_transition_issue",
    "Applies a transition (POST /rest/api/3/issue/{key}/transitions).",
    {
      issueIdOrKey: z.string(),
      transitionId: z.string(),
      fields: z.record(z.unknown()).optional(),
      comment: z.string().optional(),
    },
    wrapTool(async (args) => {
      const payload: Record<string, unknown> = { transition: { id: args.transitionId } };
      if (args.fields) payload.fields = args.fields;
      if (args.comment) {
        payload.update = {
          comment: [{ add: { body: maybeAdf(args.comment) } }],
        };
      }
      return client(runtime).transitionIssue(args.issueIdOrKey, payload);
    }),
  );

  server.tool(
    "jira_add_comment",
    "Adds a comment (POST /rest/api/3/issue/{key}/comment).",
    {
      issueIdOrKey: z.string(),
      body: z.union([z.string(), z.record(z.unknown())]),
    },
    wrapTool(async (args) =>
      client(runtime).addComment(args.issueIdOrKey, { body: maybeAdf(args.body) }),
    ),
  );

  server.tool(
    "jira_add_worklog",
    "Adds a worklog (POST /rest/api/3/issue/{key}/worklog).",
    {
      issueIdOrKey: z.string(),
      timeSpent: z.string().describe("E.g. 1h, 30m."),
      comment: z.union([z.string(), z.record(z.unknown())]).optional(),
      started: z.string().optional().describe("ISO-8601."),
    },
    wrapTool(async (args) =>
      client(runtime).addWorklog(args.issueIdOrKey, {
        timeSpent: args.timeSpent,
        comment: args.comment !== undefined ? maybeAdf(args.comment) : undefined,
        started: args.started,
      }),
    ),
  );

  server.tool(
    "jira_lookup_account_id",
    "Looks up users and accountId (GET /rest/api/3/user/search).",
    {
      query: z.string().describe("Name or email."),
      maxResults: z.number().int().min(1).max(50).optional(),
    },
    wrapTool(async (args) => client(runtime).lookupAccountId(args.query, args.maxResults)),
  );

  server.tool(
    "jira_get_remote_issue_links",
    "Remote links on an issue (GET /rest/api/3/issue/{key}/remotelink).",
    { issueIdOrKey: z.string() },
    wrapTool(async (args) => client(runtime).getRemoteIssueLinks(args.issueIdOrKey)),
  );

  server.tool(
    "jira_create_remote_issue_link",
    "Creates a remote link (POST /rest/api/3/issue/{key}/remotelink).",
    {
      issueIdOrKey: z.string(),
      url: z.string(),
      title: z.string(),
      relationship: z.string().optional(),
    },
    wrapTool(async (args) =>
      client(runtime).createRemoteIssueLink(args.issueIdOrKey, {
        object: { url: args.url, title: args.title },
        relationship: args.relationship,
      }),
    ),
  );

  server.tool(
    "jira_get_issue_link_types",
    "Issue link types (GET /rest/api/3/issueLinkType).",
    {},
    wrapTool(async () => client(runtime).getIssueLinkTypes()),
  );

  server.tool(
    "jira_create_issue_link",
    "Creates a link between issues (POST /rest/api/3/issueLink).",
    {
      type: z.string().describe("Type name, e.g. Blocks."),
      inwardIssue: z.string().describe("Destination issue (inward)."),
      outwardIssue: z.string().describe("Source issue (outward)."),
    },
    wrapTool(async (args) =>
      client(runtime).createIssueLink({
        type: { name: args.type },
        inwardIssue: { key: args.inwardIssue },
        outwardIssue: { key: args.outwardIssue },
      }),
    ),
  );
}

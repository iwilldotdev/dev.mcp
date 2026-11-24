import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { maybeAdf } from "../adf.js";
import { readRichIssue } from "../jira/rich-issue.js";
import { JiraClient } from "../clients/jira.js";
import { requireAtlassian } from "../config.js";
import type { Runtime } from "../runtime.js";
import { withCloudIdCheck } from "./cloud-id.js";
import { cloudIdShape, registerJiraExtraTools } from "./jira-extra.js";
import { arg, registerLegacyAlias, registerWriteTool } from "./register.js";
import { saveToShape, wrapSaveTool, wrapTool } from "./result.js";
import { sumJiraIssue, sumJiraRich, sumJql, sumLinks } from "./summaries.js";

function client(runtime: Runtime): JiraClient {
  return new JiraClient(requireAtlassian(runtime.config), runtime.http);
}

const K = (s: string) => encodeURIComponent(s);
const cloud = cloudIdShape;

export function registerJiraTools(rawServer: McpServer, runtime: Runtime): void {
  const server = withCloudIdCheck(rawServer, runtime);
  const cl = () => client(runtime);

  server.tool(
    "jira_get_issue",
    "Gets a Jira issue (GET /rest/api/3/issue/{key}). To keep or hand off the payload, pass save_to (absolute path); the response becomes a compact summary.",
    {
      ...cloud,
      ...saveToShape,
      issueIdOrKey: z.string().describe("Key or ID, e.g. ABC-123."),
      fields: z.string().optional().describe("CSV fields, e.g. summary,status,assignee."),
      expand: z.string().optional(),
    },
    wrapSaveTool("jira_get_issue", sumJiraIssue, async (args) =>
      cl().getIssue(args.issueIdOrKey, { fields: args.fields, expand: args.expand }),
    ),
  );

  server.tool(
    "jira_normalize_issue",
    "Reads an issue, its comment thread, remote links, and image bytes from the description, comments, and image attachments. Returns schemaVersion 1 text, acceptance criteria, links, and explicit unknowns. ADF stays data; it is not executed. To keep or hand off the payload, pass save_to (absolute path); the response becomes a compact summary.",
    {
      ...saveToShape,
      issueIdOrKey: z.string().describe("Key or ID, e.g. ABC-123."),
    },
    wrapSaveTool("jira_normalize_issue", sumJiraRich, async (args) => readRichIssue(cl(), args.issueIdOrKey)),
  );

  server.tool(
    "jira_get_comments",
    "Reads the comment thread of an issue, including author, text, links, and the images embedded in those comments and in the description. To keep or hand off the payload, pass save_to (absolute path); the response becomes a compact summary.",
    {
      ...saveToShape,
      issueIdOrKey: z.string().describe("Key or ID, e.g. ABC-123."),
    },
    wrapSaveTool("jira_get_comments", sumJiraRich, async (args) => readRichIssue(cl(), args.issueIdOrKey)),
  );

  // --- search ---
  const searchShape = {
    jql: z.string(),
    maxResults: z.number().int().min(1).max(100).optional(),
    nextPageToken: z.string().optional(),
    fields: z.array(z.string()).optional(),
    expand: z.string().optional(),
  };
  const searchRun = (args: any) =>
    cl().searchJql({
      jql: args.jql,
      maxResults: args.maxResults,
      nextPageToken: args.nextPageToken,
      fields: args.fields,
      expand: args.expand,
    });
  server.tool(
    "jira_search_issues_using_jql",
    "Search issues with JQL (POST /rest/api/3/search/jql). To keep or hand off the payload, pass save_to (absolute path); the response becomes a compact summary.",
    { ...cloud, ...saveToShape, ...searchShape },
    wrapSaveTool("jira_search_issues_using_jql", sumJql, searchRun),
  );
  registerLegacyAlias(server, runtime, "jira_search_issues_using_jql", {
    name: "jira_search_jql",
    shape: { ...saveToShape, ...searchShape },
    handler: wrapSaveTool("jira_search_jql", sumJql, searchRun),
  });

  // --- projects ---
  const projectsShape = {
    query: z.string().optional(),
    startAt: z.number().int().min(0).optional(),
    maxResults: z.number().int().min(1).max(100).optional(),
  };
  const projectsRun = async (args: any) =>
    cl().getProjects({ query: args.query, startAt: args.startAt, maxResults: args.maxResults });
  server.tool(
    "jira_list_projects",
    "Lists Jira projects (GET /rest/api/3/project/search).",
    { ...cloud, ...projectsShape },
    wrapTool(projectsRun),
  );
  registerLegacyAlias(server, runtime, "jira_list_projects", {
    name: "jira_get_projects",
    shape: projectsShape,
    handler: wrapTool(projectsRun),
  });

  // --- issue type metadata ---
  server.tool(
    "jira_list_project_issue_types_metadata",
    "Lists issue types available for creating issues in a project (GET /rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes).",
    { ...cloud, projectIdOrKey: z.string() },
    wrapTool(async (args) => cl().getIssueTypesMetadata(args.projectIdOrKey)),
  );
  server.tool(
    "jira_get_issue_type_meta_with_fields",
    "Gets the create fields of one issue type in a project (GET /rest/api/3/issue/createmeta/{projectIdOrKey}/issuetypes/{issueTypeId}).",
    { ...cloud, projectIdOrKey: z.string(), issueTypeId: z.string() },
    wrapTool(async (args) => cl().getIssueTypesMetadata(args.projectIdOrKey, args.issueTypeId)),
  );
  registerLegacyAlias(server, runtime, "jira_list_project_issue_types_metadata / jira_get_issue_type_meta_with_fields", {
    name: "jira_get_issue_types_metadata",
    shape: {
      projectIdOrKey: z.string(),
      issueTypeId: z.string().optional().describe("If set, returns fields for that type."),
    },
    handler: wrapTool(async (args: any) => cl().getIssueTypesMetadata(args.projectIdOrKey, args.issueTypeId)),
  });

  // --- transitions ---
  const transitionsRun = async (args: any) => cl().getTransitions(args.issueIdOrKey);
  server.tool(
    "jira_list_issue_transitions",
    "Available transitions for an issue (GET /rest/api/3/issue/{key}/transitions).",
    { ...cloud, issueIdOrKey: z.string() },
    wrapTool(transitionsRun),
  );
  registerLegacyAlias(server, runtime, "jira_list_issue_transitions", {
    name: "jira_get_transitions",
    shape: { issueIdOrKey: z.string() },
    handler: wrapTool(transitionsRun),
  });

  // --- create / edit / transition ---
  server.tool(
    "jira_create_issue",
    "WRITES: creates an issue (POST /rest/api/3/issue). Plain-text description is converted to ADF. issueType is a name or ID; assignee (or the deprecated assigneeAccountId) is an accountId.",
    {
      ...cloud,
      projectKey: z.string(),
      summary: z.string(),
      issueType: z.string().describe("Type name or ID (e.g. Task, Bug)."),
      description: z.union([z.string(), z.record(z.unknown())]).optional(),
      assignee: z.string().optional().describe("Assignee accountId."),
      assigneeAccountId: z.string().optional().describe("Deprecated: use assignee."),
      extraFields: z.record(z.unknown()).optional().describe("Extra fields under fields."),
    },
    wrapTool(async (args) => {
      const fields: Record<string, unknown> = {
        project: { key: args.projectKey },
        summary: args.summary,
        issuetype: /^\d+$/.test(args.issueType) ? { id: args.issueType } : { name: args.issueType },
        ...(args.extraFields ?? {}),
      };
      if (args.description !== undefined) fields.description = maybeAdf(args.description);
      const assignee = arg(args.assignee, args.assigneeAccountId);
      if (assignee) fields.assignee = { accountId: assignee };
      return cl().createIssue({ fields });
    }),
  );

  server.tool(
    "jira_edit_issue",
    "WRITES: updates an issue (PUT /rest/api/3/issue/{key}) with fields and/or update operations.",
    {
      ...cloud,
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
      return cl().editIssue(args.issueIdOrKey, payload);
    }),
  );

  server.tool(
    "jira_transition_issue",
    "WRITES: applies a workflow transition (POST /rest/api/3/issue/{key}/transitions). Optionally, after the transition succeeds, also moves the issue into a sprint (sprintId: POST /rest/agile/1.0/sprint/{sprintId}/issue) or back to the backlog (moveToBacklog: POST /rest/agile/1.0/backlog/issue).",
    {
      ...cloud,
      issueIdOrKey: z.string(),
      transitionId: z.string(),
      fields: z.record(z.unknown()).optional(),
      comment: z.string().optional(),
      sprintId: z.number().int().optional().describe("Also move the issue into this sprint."),
      moveToBacklog: z.boolean().optional().describe("Also move the issue to the backlog."),
    },
    wrapTool(async (args) => {
      if (args.sprintId !== undefined && args.moveToBacklog) {
        throw new Error("Pass either sprintId or moveToBacklog, not both.");
      }
      const payload: Record<string, unknown> = { transition: { id: args.transitionId } };
      if (args.fields) payload.fields = args.fields;
      if (args.comment) {
        payload.update = { comment: [{ add: { body: maybeAdf(args.comment) } }] };
      }
      const res = await cl().transitionIssue(args.issueIdOrKey, payload);
      if (args.sprintId !== undefined) {
        const sprint = await cl().rest("POST", `/sprint/${args.sprintId}/issue`, {
          agile: true,
          body: { issues: [args.issueIdOrKey] },
        });
        return { transition: res ?? { ok: true }, sprint };
      }
      if (args.moveToBacklog) {
        const backlog = await cl().rest("POST", "/backlog/issue", {
          agile: true,
          body: { issues: [args.issueIdOrKey] },
        });
        return { transition: res ?? { ok: true }, backlog };
      }
      return res;
    }),
  );

  // --- comments ---
  const commentBody = z.union([z.string(), z.record(z.unknown())]);
  registerWriteTool(server, runtime,
    "jira_add_or_edit_issue_comment",
    "WRITES: adds a comment (POST /rest/api/3/issue/{key}/comment) or, when commentId is given, replaces the body of that comment (PUT /rest/api/3/issue/{key}/comment/{commentId}). Plain text is converted to ADF.",
    {
      ...cloud,
      issueIdOrKey: z.string(),
      body: commentBody,
      commentId: z.string().optional().describe("Edit this comment instead of adding one."),
    },
    wrapTool(async (args) => {
      const payload = { body: maybeAdf(args.body) };
      return args.commentId
        ? cl().rest("PUT", `/issue/${K(args.issueIdOrKey)}/comment/${K(args.commentId)}`, { body: payload })
        : cl().addComment(args.issueIdOrKey, payload);
    }),
  );
  registerLegacyAlias(server, runtime, "jira_add_or_edit_issue_comment", {
    name: "jira_add_comment",
    shape: { issueIdOrKey: z.string(), body: commentBody },
    handler: wrapTool(async (args: any) => cl().addComment(args.issueIdOrKey, { body: maybeAdf(args.body) })),
  });

  // --- worklogs ---
  const worklogShape = {
    issueIdOrKey: z.string(),
    timeSpent: z.string().describe("E.g. 1h, 30m."),
    comment: z.union([z.string(), z.record(z.unknown())]).optional(),
    started: z.string().optional().describe("ISO-8601."),
  };
  const worklogPayload = (args: any) => ({
    timeSpent: args.timeSpent,
    comment: args.comment !== undefined ? maybeAdf(args.comment) : undefined,
    started: args.started,
  });
  registerWriteTool(server, runtime,
    "jira_add_or_edit_issue_worklog",
    "WRITES: adds a worklog (POST /rest/api/3/issue/{key}/worklog) or, when worklogId is given, updates that worklog (PUT /rest/api/3/issue/{key}/worklog/{worklogId}).",
    { ...cloud, ...worklogShape, worklogId: z.string().optional().describe("Edit this worklog instead of adding one.") },
    wrapTool(async (args) =>
      args.worklogId
        ? cl().rest("PUT", `/issue/${K(args.issueIdOrKey)}/worklog/${K(args.worklogId)}`, { body: worklogPayload(args) })
        : cl().addWorklog(args.issueIdOrKey, worklogPayload(args)),
    ),
  );
  registerLegacyAlias(server, runtime, "jira_add_or_edit_issue_worklog", {
    name: "jira_add_worklog",
    shape: worklogShape,
    handler: wrapTool(async (args: any) => cl().addWorklog(args.issueIdOrKey, worklogPayload(args))),
  });

  server.tool(
    "jira_lookup_account_id",
    "Looks up users and accountId (GET /rest/api/3/user/search).",
    {
      ...cloud,
      query: z.string().describe("Name or email."),
      maxResults: z.number().int().min(1).max(50).optional(),
    },
    wrapTool(async (args) => cl().lookupAccountId(args.query, args.maxResults)),
  );

  // --- remote links ---
  server.tool(
    "jira_list_issue_remote_issue_links",
    "Remote links on an issue (GET /rest/api/3/issue/{key}/remotelink). To keep or hand off the payload, pass save_to (absolute path); the response becomes a compact summary.",
    { ...cloud, issueIdOrKey: z.string(), ...saveToShape },
    wrapSaveTool("jira_list_issue_remote_issue_links", sumLinks, async (args) =>
      cl().getRemoteIssueLinks(args.issueIdOrKey),
    ),
  );
  registerLegacyAlias(server, runtime, "jira_list_issue_remote_issue_links", {
    name: "jira_get_remote_issue_links",
    shape: { issueIdOrKey: z.string(), ...saveToShape },
    handler: wrapSaveTool("jira_get_remote_issue_links", sumLinks, async (args: any) =>
      cl().getRemoteIssueLinks(args.issueIdOrKey),
    ),
  });

  const remoteShape = {
    issueIdOrKey: z.string(),
    url: z.string(),
    title: z.string(),
    relationship: z.string().optional(),
  };
  const remoteRun = async (args: any) =>
    cl().createRemoteIssueLink(args.issueIdOrKey, {
      object: { url: args.url, title: args.title },
      relationship: args.relationship,
    });
  registerWriteTool(server, runtime,
    "jira_create_issue_remote_issue_link",
    "WRITES: creates a remote link on an issue (POST /rest/api/3/issue/{key}/remotelink).",
    { ...cloud, ...remoteShape },
    wrapTool(remoteRun),
  );
  registerLegacyAlias(server, runtime, "jira_create_issue_remote_issue_link", {
    name: "jira_create_remote_issue_link",
    shape: remoteShape,
    handler: wrapTool(remoteRun),
  });

  // --- link types / links ---
  server.tool(
    "jira_list_issue_link_types",
    "Issue link types (GET /rest/api/3/issueLinkType).",
    { ...cloud },
    wrapTool(async () => cl().getIssueLinkTypes()),
  );
  registerLegacyAlias(server, runtime, "jira_list_issue_link_types", {
    name: "jira_get_issue_link_types",
    shape: {},
    handler: wrapTool(async () => cl().getIssueLinkTypes()),
  });

  server.tool(
    "jira_create_issue_link",
    "WRITES: creates a link between issues (POST /rest/api/3/issueLink).",
    {
      ...cloud,
      type: z.string().describe("Type name, e.g. Blocks."),
      inwardIssue: z.string().describe("Destination issue (inward)."),
      outwardIssue: z.string().describe("Source issue (outward)."),
    },
    wrapTool(async (args) =>
      cl().createIssueLink({
        type: { name: args.type },
        inwardIssue: { key: args.inwardIssue },
        outwardIssue: { key: args.outwardIssue },
      }),
    ),
  );

  registerJiraExtraTools(server, runtime);
}

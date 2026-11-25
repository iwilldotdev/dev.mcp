import { z } from "zod";
import { encodeProjectId } from "../clients/gitlab.js";
import { errorMessage } from "../errors.js";
import { saveToShape } from "./result.js";
import { sumIssue, sumMr } from "./summaries.js";
import {
  type A,
  type Ctx,
  GROUP,
  PAGE,
  PROJ,
  aliasRead,
  aliasWrite,
  dual,
  idType,
  need,
  pageDesc,
  pageQuery,
  pageResult,
  parseGitLabUrl,
  pick,
  posInt,
  proj,
  readTool,
  scope,
  sumList,
  sumObj,
  writeTool,
  parityWriteTool,
} from "./gitlab-common.js";

const LEGACY_PAGE = {
  per_page: z.number().int().min(1).max(100).optional().describe("Deprecated: use first."),
  page: z.number().int().min(1).optional().describe("Deprecated: use after."),
};
const legacyProjectId = z.string().describe("Numeric ID or path with namespace, e.g. group/project.");

const MR_INCLUDES = ["commits", "diffs", "notes", "pipelines", "discussions", "approvals"] as const;

export function registerGitLabCore(c: Ctx): void {
  const { gl } = c;

  // ---------- users ----------
  const getUser = async (a: A): Promise<unknown> => {
    if (a.id !== undefined && a.id !== null) return gl.request(`users/${encodeURIComponent(String(a.id))}`);
    if (a.username && !a.me) {
      const found = await gl.request<unknown>("users", { query: { username: a.username } });
      const user = Array.isArray(found) ? found[0] : found;
      if (!user) throw new Error(`User not found: ${a.username}`);
      return user;
    }
    return gl.request("user");
  };
  readTool(
    c,
    "gitlab_get_user",
    "Gets a user: the authenticated user (me: true, or no argument; GET /user), by username (GET /users?username=) or by id (GET /users/:id).",
    {
      me: z.boolean().optional().describe("The authenticated user. Default when no other argument is given."),
      username: z.string().optional(),
      id: idType.optional().describe("Numeric user id."),
    },
    sumObj(["id", "username", "name", "state", "web_url"]),
    getUser,
  );
  aliasRead(c, "gitlab_get_user", "gitlab_whoami", { ...saveToShape }, sumObj(["id", "username", "name"]), () => getUser({ me: true }));

  // ---------- projects and groups ----------
  readTool(
    c,
    "gitlab_list_projects",
    pageDesc(
      "Lists projects (GET /projects; GET /groups/:group_id/projects with group_id). Defaults to the user's membership, simple payload. Without first/after it returns a plain array (legacy), 100 per page.",
    ),
    dual({
      ...GROUP,
      include_subgroups: z.boolean().optional().describe("With group_id: include projects of subgroups."),
      membership: z.boolean().optional().describe("Default: true. false also lists visible projects without membership (can be huge). Ignored with group_id."),
      owned: z.boolean().optional(),
      starred: z.boolean().optional(),
      archived: z.boolean().optional(),
      search: z.string().optional(),
      visibility: z.enum(["private", "internal", "public"]).optional(),
      min_access_level: z.number().int().optional().describe("10 Guest, 20 Reporter, 30 Developer, 40 Maintainer, 50 Owner."),
      simple: z.boolean().optional().describe("Default: true."),
      order_by: z.string().optional().describe("Default: last_activity_at."),
      sort: z.enum(["asc", "desc"]).optional(),
      ...PAGE,
      ...LEGACY_PAGE,
    }),
    sumList(["id", "path_with_namespace", "web_url"]),
    async (a) => {
      const q: Record<string, any> = {
        owned: a.owned,
        starred: a.starred,
        archived: a.archived,
        search: a.search,
        visibility: a.visibility,
        simple: a.simple !== false,
        order_by: a.order_by ?? "last_activity_at",
        sort: a.sort,
        ...pageQuery(a, 100),
      };
      let path = "projects";
      if (a.group_id !== undefined) {
        path = `groups/${encodeProjectId(a.group_id)}/projects`;
        q.include_subgroups = a.include_subgroups;
      } else {
        q.membership = a.membership !== false;
        q.min_access_level = a.min_access_level;
      }
      return pageResult(a, await gl.request(path, { query: q }), true, 100);
    },
  );

  readTool(
    c,
    "gitlab_get_project",
    "Gets a project (GET /projects/:id).",
    {
      ...PROJ,
      statistics: z.boolean().optional().describe("Include repository statistics."),
      license: z.boolean().optional().describe("Include license information."),
    },
    sumObj(["id", "path_with_namespace", "default_branch", "web_url"]),
    async (a) => gl.request(`projects/${proj(a)}`, { query: { statistics: a.statistics, license: a.license } }),
  );

  readTool(
    c,
    "gitlab_get_group",
    "Gets a group (GET /groups/:id).",
    { group_id: idType.describe("Numeric ID or path of the group."), with_projects: z.boolean().optional() },
    sumObj(["id", "full_path", "name", "web_url"]),
    async (a) =>
      gl.request(`groups/${encodeProjectId(need(a.group_id, "group_id"))}`, { query: { with_projects: a.with_projects } }),
  );

  readTool(
    c,
    "gitlab_list_groups",
    pageDesc(
      "Lists groups (GET /groups), or the subgroups of group_id (GET /groups/:id/subgroups).",
    ),
    {
      group_id: idType.optional().describe("Parent group: list its direct subgroups."),
      search: z.string().optional(),
      owned: z.boolean().optional(),
      top_level_only: z.boolean().optional(),
      all_available: z.boolean().optional(),
      min_access_level: z.number().int().optional(),
      order_by: z.string().optional(),
      sort: z.enum(["asc", "desc"]).optional(),
      ...PAGE,
    },
    sumList(["id", "full_path", "web_url"]),
    async (a) => {
      const path = a.group_id !== undefined ? `groups/${encodeProjectId(a.group_id)}/subgroups` : "groups";
      const data = await gl.request(path, {
        query: {
          search: a.search,
          owned: a.owned,
          top_level_only: a.top_level_only,
          all_available: a.all_available,
          min_access_level: a.min_access_level,
          order_by: a.order_by,
          sort: a.sort,
          ...pageQuery(a),
        },
      });
      return pageResult(a, data);
    },
  );

  readTool(
    c,
    "gitlab_get_mcp_server_version",
    "Version of the GitLab instance this server talks to (GET /version). dev.mcp is not the GitLab-hosted MCP server, so the GitLab MCP version does not apply.",
    {},
    sumObj(["version", "revision", "server"]),
    async () => ({ server: "dev.mcp", ...((await gl.request<object>("version")) as object) }),
  );

  readTool(
    c,
    "gitlab_list_todos",
    pageDesc("Lists the authenticated user's to-do items (GET /todos)."),
    {
      action: z
        .enum(["assigned", "mentioned", "build_failed", "marked", "approval_required", "unmergeable", "directly_addressed", "merge_train_removed", "member_access_requested"])
        .optional(),
      author_id: z.number().int().optional(),
      project_id: idType.optional().describe("Only to-dos of this project (numeric id)."),
      group_id: idType.optional().describe("Only to-dos of this group (numeric id)."),
      state: z.enum(["pending", "done"]).optional(),
      type: z.string().optional().describe("Issue, MergeRequest, DesignManagement::Design, AlertManagement::Alert, Project, Namespace or Vulnerability."),
      ...PAGE,
    },
    sumList(["id", "action_name", "target_type", "state", "target_url"]),
    async (a) =>
      pageResult(
        a,
        await gl.request("todos", {
          query: {
            action: a.action,
            author_id: a.author_id,
            project_id: a.project_id,
            group_id: a.group_id,
            state: a.state,
            type: a.type,
            ...pageQuery(a),
          },
        }),
      ),
  );

  readTool(
    c,
    "gitlab_list_user_events",
    pageDesc(
      "Lists contribution events of a user (GET /users/:id/events). user_id or username; without both, the authenticated user.",
    ),
    {
      user_id: idType.optional(),
      username: z.string().optional(),
      action: z.string().optional().describe("approved, closed, commented, created, destroyed, expired, joined, left, merged, pushed, reopened, updated."),
      target_type: z.string().optional().describe("issue, milestone, merge_request, note, project, snippet, user."),
      date_after: z.string().optional().describe("REST `after`: events after this date (YYYY-MM-DD). Named date_after because `after` is the pagination cursor."),
      date_before: z.string().optional().describe("REST `before`: events before this date (YYYY-MM-DD)."),
      sort: z.enum(["asc", "desc"]).optional(),
      ...PAGE,
    },
    sumList(["id", "action_name", "target_type", "created_at"]),
    async (a) => {
      let uid = a.user_id;
      if (uid === undefined) uid = ((await getUser({ username: a.username })) as A).id;
      return pageResult(
        a,
        await gl.request(`users/${encodeURIComponent(String(uid))}/events`, {
          query: {
            action: a.action,
            target_type: a.target_type,
            after: a.date_after,
            before: a.date_before,
            sort: a.sort,
            ...pageQuery(a),
          },
        }),
      );
    },
  );

  readTool(
    c,
    "gitlab_list_milestones",
    pageDesc("Lists milestones of a project (GET /projects/:id/milestones) or a group (GET /groups/:id/milestones)."),
    {
      ...PROJ,
      ...GROUP,
      state: z.enum(["active", "closed"]).optional(),
      title: z.string().optional(),
      search: z.string().optional(),
      ...PAGE,
    },
    sumList(["id", "iid", "title", "state", "due_date"]),
    async (a) =>
      pageResult(
        a,
        await gl.request(`${scope(a)}/milestones`, {
          query: { state: a.state, title: a.title, search: a.search, ...pageQuery(a) },
        }),
      ),
  );

  readTool(
    c,
    "gitlab_list_project_members",
    "Project members (GET /projects/:id/members, or /members/all with include_inherited).",
    dual({ ...PROJ, query: z.string().optional(), include_inherited: z.boolean().optional() }),
    sumList(["id", "username", "access_level"]),
    async (a) =>
      gl.request(`projects/${proj(a)}/members${a.include_inherited ? "/all" : ""}`, { query: { query: a.query } }),
  );

  // ---------- work items (project issues) ----------
  const workItemIid = (a: A): string => {
    const iid = need(a.work_item_iid ?? a.issue_iid, "work_item_iid (legacy: issueIid)");
    return String(iid);
  };
  const resolveRef = (a: A): { pid: string; iid: string } => {
    if (a.url) {
      const u = parseGitLabUrl(a.url);
      return { pid: encodeProjectId(u.project), iid: String(u.iid) };
    }
    return { pid: proj(a), iid: workItemIid(a) };
  };

  readTool(
    c,
    "gitlab_get_work_item",
    "Gets a work item, i.e. a project issue (GET /projects/:id/issues/:iid). Identify it by project_id + work_item_iid, or by url (…/-/issues/N or …/-/work_items/N).",
    {
      ...PROJ,
      work_item_iid: posInt.optional(),
      url: z.string().optional().describe("Web URL of the work item; replaces project_id + work_item_iid."),
    },
    sumIssue,
    async (a) => {
      const r = resolveRef(a);
      return gl.request(`projects/${r.pid}/issues/${r.iid}`);
    },
  );
  aliasRead(
    c,
    "gitlab_get_work_item",
    "gitlab_get_issue",
    { ...saveToShape, projectId: legacyProjectId, issueIid: posInt },
    sumIssue,
    async (a) => gl.request(`projects/${proj(a)}/issues/${a.issue_iid}`),
  );

  const WORK_ITEM_FIELDS = {
    title: z.string().optional().describe("Required to create."),
    description: z.string().optional(),
    labels: z.string().optional().describe("Comma-separated labels; replaces the labels on update."),
    add_labels: z.string().optional().describe("Comma-separated labels to add (update)."),
    remove_labels: z.string().optional().describe("Comma-separated labels to remove (update)."),
    assignee_ids: z.array(z.number().int()).optional(),
    milestone_id: z.number().int().optional(),
    confidential: z.boolean().optional(),
    due_date: z.string().optional().describe("YYYY-MM-DD."),
    issue_type: z.enum(["issue", "incident", "test_case", "task"]).optional().describe("Create only."),
    state_event: z.enum(["close", "reopen"]).optional().describe("Update only: closes or reopens the work item."),
  };
  const saveWorkItem = async (a: A): Promise<unknown> => {
    const body: Record<string, unknown> = {
      title: a.title,
      description: a.description,
      labels: a.labels,
      add_labels: a.add_labels,
      remove_labels: a.remove_labels,
      assignee_ids: a.assignee_ids,
      milestone_id: a.milestone_id,
      confidential: a.confidential,
      due_date: a.due_date,
    };
    const iid = a.work_item_iid ?? a.issue_iid;
    if (iid !== undefined) {
      body.state_event = a.state_event;
      return gl.request(`projects/${proj(a)}/issues/${iid}`, { method: "PUT", body });
    }
    need(a.title, "title (to create a work item)");
    body.issue_type = a.issue_type;
    return gl.request(`projects/${proj(a)}/issues`, { method: "POST", body });
  };
  parityWriteTool(
    c,
    "gitlab_save_work_item",
    "Writes a work item (project issue): creates it with POST /projects/:id/issues when work_item_iid is absent (title required), otherwise updates it with PUT /projects/:id/issues/:iid (including labels and open/closed state).",
    { ...PROJ, work_item_iid: posInt.optional().describe("Omit to create; set to update."), ...WORK_ITEM_FIELDS },
    saveWorkItem,
  );
  aliasWrite(
    c,
    "gitlab_save_work_item",
    "gitlab_create_issue",
    {
      projectId: legacyProjectId,
      title: z.string(),
      description: z.string().optional(),
      labels: z.string().optional(),
      assigneeIds: z.array(z.number().int()).optional(),
    },
    async (a) => saveWorkItem({ project_id: a.project_id, title: a.title, description: a.description, labels: a.labels, assignee_ids: a.assignee_ids }),
  );

  readTool(
    c,
    "gitlab_list_work_items",
    pageDesc("Lists the work items (issues) of a project (GET /projects/:id/issues)."),
    {
      ...PROJ,
      state: z.enum(["opened", "closed", "all"]).optional(),
      labels: z.string().optional().describe("Comma-separated labels."),
      search: z.string().optional(),
      author_username: z.string().optional(),
      assignee_username: z.string().optional(),
      milestone: z.string().optional(),
      issue_type: z.enum(["issue", "incident", "test_case", "task"]).optional(),
      confidential: z.boolean().optional(),
      order_by: z.string().optional(),
      sort: z.enum(["asc", "desc"]).optional(),
      ...PAGE,
    },
    sumList(["iid", "title", "state", "web_url"]),
    async (a) =>
      pageResult(
        a,
        await gl.request(`projects/${proj(a)}/issues`, {
          query: {
            state: a.state,
            labels: a.labels,
            search: a.search,
            author_username: a.author_username,
            assignee_username: a.assignee_username,
            milestone: a.milestone,
            issue_type: a.issue_type,
            confidential: a.confidential,
            order_by: a.order_by,
            sort: a.sort,
            ...pageQuery(a),
          },
        }),
      ),
  );

  parityWriteTool(
    c,
    "gitlab_link_work_items",
    "Creates a link between two work items (POST /projects/:id/issues/:iid/links). Changes both issues' related items.",
    {
      ...PROJ,
      work_item_iid: posInt,
      target_project_id: idType.describe("Project of the target work item."),
      target_work_item_iid: posInt,
      link_type: z.enum(["relates_to", "blocks", "is_blocked_by"]).optional().describe("Default: relates_to."),
    },
    async (a) =>
      gl.request(`projects/${proj(a)}/issues/${a.work_item_iid}/links`, {
        method: "POST",
        body: {
          target_project_id: String(a.target_project_id),
          target_issue_iid: a.target_work_item_iid,
          link_type: a.link_type,
        },
      }),
  );

  // ---------- notes ----------
  const saveNote = async (a: A): Promise<unknown> => {
    const target =
      a.merge_request_iid !== undefined
        ? `merge_requests/${a.merge_request_iid}`
        : a.work_item_iid !== undefined
          ? `issues/${a.work_item_iid}`
          : undefined;
    if (!target) throw new Error("Missing required parameter: merge_request_iid or work_item_iid.");
    const base = `projects/${proj(a)}/${target}`;
    const hasBody = a.body !== undefined;
    if (a.note_id !== undefined) {
      if (!hasBody && a.resolved === undefined) throw new Error("To update a note provide body and/or resolved.");
      return gl.request(`${base}/notes/${a.note_id}`, { method: "PUT", body: { body: a.body, resolved: a.resolved } });
    }
    if (!hasBody) {
      if (a.resolved !== undefined && a.discussion_id) {
        return gl.request(`${base}/discussions/${encodeURIComponent(a.discussion_id)}`, {
          method: "PUT",
          body: { resolved: a.resolved },
        });
      }
      throw new Error("Provide body to comment, or discussion_id + resolved to (un)resolve a discussion.");
    }
    if (a.discussion_id) {
      return gl.request(`${base}/discussions/${encodeURIComponent(a.discussion_id)}/notes`, {
        method: "POST",
        body: { body: a.body, internal: a.internal },
      });
    }
    return gl.request(`${base}/notes`, { method: "POST", body: { body: a.body, internal: a.internal } });
  };
  parityWriteTool(
    c,
    "gitlab_save_note",
    "Writes a note on a merge request (merge_request_iid) or a work item (work_item_iid). Only body: creates a comment (POST …/notes). With discussion_id: replies in that thread (POST …/discussions/:id/notes). With note_id: edits that note (PUT …/notes/:id). With discussion_id + resolved and no body: (un)resolves the thread (PUT …/discussions/:id).",
    {
      ...PROJ,
      merge_request_iid: posInt.optional(),
      work_item_iid: posInt.optional(),
      body: z.string().optional(),
      note_id: z.number().int().optional().describe("Edit this note."),
      discussion_id: z.string().optional().describe("Reply to, or resolve, this discussion."),
      resolved: z.boolean().optional(),
      internal: z.boolean().optional().describe("Create as an internal (confidential) note."),
    },
    saveNote,
  );
  aliasWrite(
    c,
    "gitlab_save_note",
    "gitlab_create_merge_request_note",
    { projectId: legacyProjectId, mergeRequestIid: posInt, body: z.string() },
    async (a) => saveNote({ project_id: a.project_id, merge_request_iid: a.merge_request_iid, body: a.body }),
  );

  // ---------- merge requests ----------
  readTool(
    c,
    "gitlab_list_merge_requests",
    pageDesc(
      "Lists merge requests of a project (GET /projects/:id/merge_requests), of a group (GET /groups/:id/merge_requests, with group_id) or, with neither, of the authenticated user (GET /merge_requests). Without first/after it returns a plain array (legacy).",
    ),
    dual({
      ...PROJ,
      ...GROUP,
      state: z.enum(["opened", "closed", "locked", "merged", "all"]).optional(),
      source_branch: z.string().optional(),
      target_branch: z.string().optional(),
      search: z.string().optional(),
      author_id: z.number().int().optional(),
      author_username: z.string().optional(),
      assignee_id: z.union([z.number().int(), z.enum(["None", "Any"])]).optional(),
      reviewer_id: z.union([z.number().int(), z.enum(["None", "Any"])]).optional(),
      reviewer_username: z.string().optional(),
      labels: z.string().optional().describe("Comma-separated labels."),
      milestone: z.string().optional(),
      scope: z.enum(["created_by_me", "assigned_to_me", "all"]).optional(),
      draft: z.boolean().optional(),
      order_by: z.string().optional(),
      sort: z.enum(["asc", "desc"]).optional(),
      created_after: z.string().optional(),
      created_before: z.string().optional(),
      updated_after: z.string().optional(),
      updated_before: z.string().optional(),
      ...PAGE,
      ...LEGACY_PAGE,
    }),
    (p) => {
      const list: any[] = Array.isArray(p) ? p : (p?.items ?? []);
      return {
        count: list.length,
        merge_requests: list.slice(0, 20).map((m) => pick(m, ["iid", "state", "web_url"])),
        ...(p?.next_cursor !== undefined ? { next_cursor: p.next_cursor } : {}),
      };
    },
    async (a) => {
      const hasProject = a.project_id !== undefined || a.id !== undefined;
      const path = a.group_id !== undefined ? `${scope(a)}/merge_requests` : hasProject ? `${scope(a)}/merge_requests` : "merge_requests";
      return pageResult(
        a,
        await gl.request(path, {
          query: {
            state: a.state,
            source_branch: a.source_branch,
            target_branch: a.target_branch,
            search: a.search,
            author_id: a.author_id,
            author_username: a.author_username,
            assignee_id: a.assignee_id,
            reviewer_id: a.reviewer_id,
            reviewer_username: a.reviewer_username,
            labels: a.labels,
            milestone: a.milestone,
            scope: a.scope,
            wip: a.draft === undefined ? undefined : a.draft ? "yes" : "no",
            order_by: a.order_by,
            sort: a.sort,
            created_after: a.created_after,
            created_before: a.created_before,
            updated_after: a.updated_after,
            updated_before: a.updated_before,
            ...pageQuery(a),
          },
        }),
        true,
      );
    },
  );

  readTool(
    c,
    "gitlab_get_merge_request",
    "Gets a merge request (GET /projects/:id/merge_requests/:iid). Identify it by project_id + merge_request_iid or by url (…/-/merge_requests/N). include adds, as extra keys next to merge_request: commits, diffs, notes, pipelines, discussions, approvals (one GET each). Legacy includeCommits/includeDiffs/includeNotes/includePipelines are deprecated.",
    {
      ...dual({
        ...PROJ,
        merge_request_iid: posInt.optional(),
        url: z.string().optional().describe("Web URL of the MR; replaces project_id + merge_request_iid."),
        include: z.array(z.enum(MR_INCLUDES)).optional(),
      }),
      includeCommits: z.boolean().optional().describe("Deprecated: use include: [commits]."),
      includeDiffs: z.boolean().optional().describe("Deprecated: use include: [diffs]."),
      includeNotes: z.boolean().optional().describe("Deprecated: use include: [notes]."),
      includePipelines: z.boolean().optional().describe("Deprecated: use include: [pipelines]."),
    },
    (p) => {
      const out = sumMr(p);
      if (Array.isArray(p?.discussions)) out.discussions_count = p.discussions.length;
      if (p?.approvals) out.approved = p.approvals.approved ?? undefined;
      return out;
    },
    async (a) => {
      let pid: string;
      let iid: string;
      if (a.url) {
        const u = parseGitLabUrl(a.url);
        pid = encodeProjectId(u.project);
        iid = String(u.iid);
      } else {
        pid = proj(a);
        iid = String(need(a.merge_request_iid, "merge_request_iid (legacy: mergeRequestIid)"));
      }
      const base = `projects/${pid}/merge_requests/${iid}`;
      const inc = new Set<string>(a.include ?? []);
      for (const k of ["commits", "diffs", "notes", "pipelines"]) if (a[`include_${k}`]) inc.add(k);
      const mr = await gl.request(base);
      const extra: Record<string, unknown> = { merge_request: mr };
      await Promise.all(
        [...inc].map(async (k) => {
          extra[k] = await gl.request(`${base}/${k}`);
        }),
      );
      return extra;
    },
  );

  // The REST API has no draft attribute on create or update: GitLab reads the draft state from a title marker.
  const DRAFT_MARK = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s+-|\[wip\]|wip:)\s*/i;
  const withDraft = (title: string, draft: boolean) => {
    const bare = title.replace(DRAFT_MARK, "");
    return draft ? `Draft: ${bare}` : bare;
  };
  const mrBody = (a: A, title = a.title) => ({
    source_branch: a.source_branch,
    target_branch: a.target_branch,
    title,
    description: a.description,
    assignee_ids: a.assignee_ids,
    reviewer_ids: a.reviewer_ids,
    remove_source_branch: a.remove_source_branch,
  });
  writeTool(
    c,
    "gitlab_save_merge_request",
    "Creates a merge request (POST /projects/:id/merge_requests; source_branch, target_branch, title required) or, with merge_request_iid, updates it (PUT /projects/:id/merge_requests/:iid).",
    dual({
      ...PROJ,
      merge_request_iid: posInt.optional(),
      source_branch: z.string().optional(),
      target_branch: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      assignee_ids: z.array(z.number().int()).optional(),
      reviewer_ids: z.array(z.number().int()).optional(),
      remove_source_branch: z.boolean().optional(),
      draft: z.boolean().optional(),
    }),
    async (a) => {
      if (a.merge_request_iid) {
        const path = `projects/${proj(a)}/merge_requests/${a.merge_request_iid}`;
        let title = a.title;
        if (a.draft !== undefined) {
          // draft alone keeps the current title and only moves its marker
          const current = title ?? (await gl.request<{ title: string }>(path)).title;
          title = withDraft(current, a.draft);
        }
        return gl.request(path, { method: "PUT", body: mrBody(a, title) });
      }
      if (!a.source_branch || !a.target_branch || !a.title) {
        throw new Error("To create an MR, provide sourceBranch, targetBranch, and title.");
      }
      const title = a.draft === undefined ? a.title : withDraft(a.title, a.draft);
      return gl.request(`projects/${proj(a)}/merge_requests`, { method: "POST", body: mrBody(a, title) });
    },
  );

  writeTool(
    c,
    "gitlab_accept_merge_request",
    "Merges a merge request (PUT /projects/:id/merge_requests/:iid/merge). This is irreversible. sha makes GitLab refuse the merge if the source branch head moved.",
    dual({
      ...PROJ,
      merge_request_iid: posInt.optional(),
      squash: z.boolean().optional(),
      should_remove_source_branch: z.boolean().optional(),
      merge_commit_message: z.string().optional(),
      sha: z.string().optional().describe("Expected HEAD SHA of the source branch."),
    }),
    async (a) =>
      gl.request(`projects/${proj(a)}/merge_requests/${need(a.merge_request_iid, "merge_request_iid")}/merge`, {
        method: "PUT",
        body: {
          squash: a.squash,
          should_remove_source_branch: a.should_remove_source_branch,
          merge_commit_message: a.merge_commit_message,
          sha: a.sha,
        },
      }),
  );

  const REVIEW_PARAMS: Record<string, string[]> = {
    create_note: ["body", "internal"],
    reply_discussion: ["body", "discussion_id"],
    create_diff_note: ["body", "old_path", "new_path", "old_line", "new_line"],
    resolve_discussion: ["discussion_id", "resolved"],
    update_note: ["body", "note_id"],
    submit_review: ["comments", "verdict", "summary", "summary_internal"],
    approve: ["sha"],
    unapprove: [],
  };
  const bareDiscussion = (id: string): string => String(id).split("/").pop() ?? String(id);
  const reviewTool = async (a: A): Promise<unknown> => {
    let pid: string;
    let iid: string;
    let anchorNote: string | undefined;
    if (a.url) {
      const u = parseGitLabUrl(a.url);
      pid = encodeProjectId(u.project);
      iid = String(u.iid);
      anchorNote = /#note_(\d+)/.exec(String(a.url))?.[1];
    } else {
      pid = proj(a);
      iid = String(need(a.merge_request_iid, "merge_request_iid"));
    }
    const allowed = REVIEW_PARAMS[a.method];
    if (!allowed) throw new Error(`Unsupported method: ${a.method}`);
    const all = new Set(Object.values(REVIEW_PARAMS).flat());
    for (const k of all) {
      if (a[k] !== undefined && !allowed.includes(k)) throw new Error(`Parameter ${k} does not apply to method ${a.method}.`);
    }
    const mr = `projects/${pid}/merge_requests/${iid}`;
    const noSlash = (b: string, label = "body"): string => {
      if (b.startsWith("/")) throw new Error(`${label} cannot start with / (it would trigger a quick action).`);
      return b;
    };
    const position = (diffRefs: A, f: { old_path?: string; new_path?: string; old_line?: number; new_line?: number }) => {
      if (!f.old_path && !f.new_path) throw new Error("Provide old_path or new_path.");
      if (f.old_line === undefined && f.new_line === undefined) throw new Error("Provide old_line or new_line.");
      return {
        position_type: "text",
        base_sha: diffRefs.base_sha,
        start_sha: diffRefs.start_sha,
        head_sha: diffRefs.head_sha,
        old_path: f.old_path ?? f.new_path,
        new_path: f.new_path ?? f.old_path,
        old_line: f.old_line,
        new_line: f.new_line,
      };
    };
    switch (a.method) {
      case "create_note":
        return gl.request(`${mr}/notes`, { method: "POST", body: { body: noSlash(need(a.body, "body")), internal: a.internal } });
      case "reply_discussion":
        return gl.request(`${mr}/discussions/${encodeURIComponent(bareDiscussion(need(a.discussion_id, "discussion_id")))}/notes`, {
          method: "POST",
          body: { body: noSlash(need(a.body, "body")) },
        });
      case "create_diff_note": {
        const body = noSlash(need(a.body, "body"));
        const mrObj = await gl.request<A>(mr);
        return gl.request(`${mr}/discussions`, { method: "POST", body: { body, position: position(mrObj.diff_refs ?? {}, a) } });
      }
      case "resolve_discussion":
        return gl.request(`${mr}/discussions/${encodeURIComponent(bareDiscussion(need(a.discussion_id, "discussion_id")))}`, {
          method: "PUT",
          query: { resolved: need(a.resolved, "resolved") },
        });
      case "update_note":
        return gl.request(`${mr}/notes/${need(a.note_id ?? anchorNote, "note_id (or a url ending in #note_<id>)")}`, {
          method: "PUT",
          body: { body: noSlash(need(a.body, "body")) },
        });
      case "submit_review": {
        const comments: A[] = need(a.comments, "comments");
        if (comments.length < 1 || comments.length > 20) throw new Error("comments takes 1-20 entries.");
        const mrObj = await gl.request<A>(mr);
        const dn = `${mr}/draft_notes`;
        // Validate everything before the first POST so a bad comment 7 cannot leave 6 stray drafts.
        const bodies: A[] = comments.map((cm, i) => {
          const text = noSlash(need(cm.body, `comments[${i}].body`), "comment body");
          const note = cm.suggestion !== undefined ? `${text}\n\n\`\`\`suggestion:-0+0\n${cm.suggestion}\n\`\`\`` : text;
          return { note, position: position(mrObj.diff_refs ?? {}, { old_path: cm.file, new_path: cm.file, old_line: cm.old_line, new_line: cm.new_line }) };
        });
        const summaryText = [a.verdict ? `**${a.verdict}**` : undefined, a.summary].filter(Boolean).join("\n\n");
        if (summaryText) noSlash(summaryText, "summary");
        const created: Array<number | string> = [];
        const cleanup = async (): Promise<string> => {
          const removed: Array<number | string> = [];
          const failed: Array<number | string> = [];
          for (const id of created) {
            try {
              await gl.request(`${dn}/${id}`, { method: "DELETE" });
              removed.push(id);
            } catch {
              failed.push(id);
            }
          }
          return `Draft notes created by this call and deleted: [${removed.join(", ")}]${failed.length ? `; could NOT be deleted (remove them in the MR UI): [${failed.join(", ")}]` : ""}. Nothing was published.`;
        };
        let published: unknown;
        try {
          for (const body of bodies) {
            const d = await gl.request<A>(dn, { method: "POST", body });
            if (d?.id !== undefined) created.push(d.id);
          }
          if (summaryText && !a.summary_internal) {
            const d = await gl.request<A>(dn, { method: "POST", body: { note: summaryText } });
            if (d?.id !== undefined) created.push(d.id);
          }
          published = await gl.request(`${dn}/bulk_publish`, { method: "POST" });
        } catch (err) {
          throw new Error(`submit_review failed: ${errorMessage(err)} ${await cleanup()}`);
        }
        if (summaryText && a.summary_internal) {
          try {
            await gl.request(`${mr}/notes`, { method: "POST", body: { body: summaryText, internal: true } });
          } catch (err) {
            throw new Error(`submit_review: the ${comments.length} comments were published, but the internal summary note failed: ${errorMessage(err)}`);
          }
        }
        return published ?? { status: "published", comments: comments.length };
      }
      case "approve":
        return gl.request(`${mr}/approve`, { method: "POST", body: { sha: a.sha } });
      case "unapprove":
        return gl.request(`${mr}/unapprove`, { method: "POST" });
      default:
        throw new Error(`Unsupported method: ${a.method}`);
    }
  };
  parityWriteTool(
    c,
    "gitlab_save_merge_request_review",
    "Writes merge request review artifacts as the authenticated user; one operation per call, chosen by method. create_note: top-level comment (POST …/notes; body, internal). reply_discussion: reply in a thread (POST …/discussions/:discussion_id/notes). create_diff_note: comment on a diff line (POST …/discussions with a position built from the MR diff_refs; old_path/new_path, old_line/new_line). resolve_discussion: (un)resolve a thread (PUT …/discussions/:id?resolved=). update_note: replace a note's text (PUT …/notes/:note_id). submit_review: posts 1-20 diff comments (file, body, old_line/new_line, suggestion) plus an optional verdict/summary as draft notes, then publishes them all (POST …/draft_notes/bulk_publish). approve (POST …/approve, optional sha guard) and unapprove (POST …/unapprove). post_duo_review is not available. Parameters that belong to another method are rejected.",
    {
      url: z.string().optional().describe("MR URL, or a comment link ending in #note_<id>; replaces project_id + merge_request_iid."),
      ...PROJ,
      merge_request_iid: posInt.optional(),
      method: z.enum(["create_note", "reply_discussion", "create_diff_note", "resolve_discussion", "update_note", "submit_review", "approve", "unapprove"]),
      body: z.string().optional().describe("Note text (create_note, reply_discussion, create_diff_note, update_note). Cannot start with /."),
      discussion_id: z.string().optional().describe("reply_discussion, resolve_discussion: global or bare discussion id."),
      note_id: z.number().int().optional().describe("update_note (or use a url ending in #note_<id>)."),
      internal: z.boolean().optional().describe("create_note: internal note."),
      resolved: z.boolean().optional().describe("resolve_discussion: true resolves, false unresolves."),
      old_path: z.string().optional().describe("create_diff_note: path before the change."),
      new_path: z.string().optional().describe("create_diff_note: path after the change."),
      old_line: z.number().int().optional(),
      new_line: z.number().int().optional(),
      comments: z
        .array(
          z.object({
            file: z.string().describe("Post-change path."),
            body: z.string(),
            old_line: z.number().int().optional(),
            new_line: z.number().int().optional(),
            suggestion: z.string().optional().describe("Replacement text, posted as a suggestion block."),
          }),
        )
        .optional()
        .describe("submit_review: 1-20 diff comments."),
      verdict: z.string().optional().describe("submit_review: prefix of the summary note."),
      summary: z.string().optional().describe("submit_review: summary note."),
      summary_internal: z.boolean().optional().describe("submit_review: post the summary as an internal note."),
      sha: z.string().optional().describe("approve: head SHA guard (the MR's diff_head_sha)."),
    },
    reviewTool,
  );

  parityWriteTool(
    c,
    "gitlab_apply_suggestion",
    "Applies diff suggestion(s) from MR comments: commits them to the MR source branch (PUT /suggestions/:id/apply, or PUT /suggestions/batch_apply with several suggestion_ids).",
    {
      suggestion_id: z.number().int().optional(),
      suggestion_ids: z.array(z.number().int()).min(1).optional().describe("Apply several suggestions in one commit."),
      commit_message: z.string().optional(),
    },
    async (a) => {
      if (a.suggestion_ids?.length) {
        return gl.request("suggestions/batch_apply", {
          method: "PUT",
          body: { ids: a.suggestion_ids, commit_message: a.commit_message },
        });
      }
      return gl.request(`suggestions/${need(a.suggestion_id, "suggestion_id or suggestion_ids")}/apply`, {
        method: "PUT",
        body: { commit_message: a.commit_message },
      });
    },
  );
}

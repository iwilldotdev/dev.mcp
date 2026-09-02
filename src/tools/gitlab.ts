import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GitLabClient, encodeProjectId } from "../clients/gitlab.js";
import type { Runtime } from "../runtime.js";
import { wrapTool } from "./result.js";

const projectId = z
  .string()
  .describe("Numeric ID or path with namespace, e.g. group/project.");

function p(id: string): string {
  return encodeProjectId(id);
}

export function registerGitLabTools(
  server: McpServer,
  runtime: Runtime,
  gitlab: GitLabClient,
): void {
  server.tool(
    "gitlab_whoami",
    "Authenticated user for the token (GET /user).",
    {},
    wrapTool(async () => gitlab.request("user")),
  );

  server.tool(
    "gitlab_list_projects",
    "Lists projects (GET /projects). Defaults to the user's membership, simple payload.",
    {
      membership: z
        .boolean()
        .optional()
        .describe("Default: true. false also lists visible projects without membership (can be huge)."),
      owned: z.boolean().optional(),
      starred: z.boolean().optional(),
      archived: z.boolean().optional(),
      search: z.string().optional(),
      visibility: z.enum(["private", "internal", "public"]).optional(),
      minAccessLevel: z
        .number()
        .int()
        .optional()
        .describe("10 Guest, 20 Reporter, 30 Developer, 40 Maintainer, 50 Owner."),
      simple: z.boolean().optional().describe("Default: true."),
      perPage: z.number().int().min(1).max(100).optional(),
      page: z.number().int().min(1).optional(),
      orderBy: z.string().optional().describe("Default: last_activity_at."),
      sort: z.enum(["asc", "desc"]).optional(),
    },
    wrapTool(async (args) =>
      gitlab.request("projects", {
        query: {
          membership: args.membership !== false,
          owned: args.owned,
          starred: args.starred,
          archived: args.archived,
          search: args.search,
          visibility: args.visibility,
          min_access_level: args.minAccessLevel,
          simple: args.simple !== false,
          per_page: args.perPage ?? 100,
          page: args.page,
          order_by: args.orderBy ?? "last_activity_at",
          sort: args.sort,
        },
      }),
    ),
  );

  server.tool(
    "gitlab_get_issue",
    "Gets an issue (GET /projects/:id/issues/:iid).",
    {
      projectId,
      issueIid: z.number().int().positive(),
    },
    wrapTool(async (args) =>
      gitlab.request(`projects/${p(args.projectId)}/issues/${args.issueIid}`),
    ),
  );

  server.tool(
    "gitlab_create_issue",
    "Creates an issue (POST /projects/:id/issues).",
    {
      projectId,
      title: z.string(),
      description: z.string().optional(),
      labels: z.string().optional(),
      assigneeIds: z.array(z.number().int()).optional(),
    },
    wrapTool(async (args) =>
      gitlab.request(`projects/${p(args.projectId)}/issues`, {
        method: "POST",
        body: {
          title: args.title,
          description: args.description,
          labels: args.labels,
          assignee_ids: args.assigneeIds,
        },
      }),
    ),
  );

  server.tool(
    "gitlab_list_merge_requests",
    "Lists merge requests (GET /projects/:id/merge_requests).",
    {
      projectId,
      state: z.enum(["opened", "closed", "locked", "merged", "all"]).optional(),
      sourceBranch: z.string().optional(),
      targetBranch: z.string().optional(),
      search: z.string().optional(),
      perPage: z.number().int().min(1).max(100).optional(),
      page: z.number().int().min(1).optional(),
    },
    wrapTool(async (args) =>
      gitlab.request(`projects/${p(args.projectId)}/merge_requests`, {
        query: {
          state: args.state,
          source_branch: args.sourceBranch,
          target_branch: args.targetBranch,
          search: args.search,
          per_page: args.perPage,
          page: args.page,
        },
      }),
    ),
  );

  server.tool(
    "gitlab_get_merge_request",
    "Gets an MR and optionally commits, diffs, notes, and pipelines.",
    {
      projectId,
      mergeRequestIid: z.number().int().positive(),
      includeCommits: z.boolean().optional(),
      includeDiffs: z.boolean().optional(),
      includeNotes: z.boolean().optional(),
      includePipelines: z.boolean().optional(),
    },
    wrapTool(async (args) => {
      const base = `projects/${p(args.projectId)}/merge_requests/${args.mergeRequestIid}`;
      const mr = await gitlab.request(base);
      const extra: Record<string, unknown> = { merge_request: mr };
      const jobs: Array<Promise<void>> = [];
      if (args.includeCommits) {
        jobs.push(
          gitlab.request(`${base}/commits`).then((data) => {
            extra.commits = data;
          }),
        );
      }
      if (args.includeDiffs) {
        jobs.push(
          gitlab.request(`${base}/diffs`).then((data) => {
            extra.diffs = data;
          }),
        );
      }
      if (args.includeNotes) {
        jobs.push(
          gitlab.request(`${base}/notes`).then((data) => {
            extra.notes = data;
          }),
        );
      }
      if (args.includePipelines) {
        jobs.push(
          gitlab.request(`${base}/pipelines`).then((data) => {
            extra.pipelines = data;
          }),
        );
      }
      await Promise.all(jobs);
      return extra;
    }),
  );

  server.tool(
    "gitlab_save_merge_request",
    "Creates (POST) or updates (PUT) a merge request.",
    {
      projectId,
      mergeRequestIid: z.number().int().positive().optional(),
      sourceBranch: z.string().optional(),
      targetBranch: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      assigneeIds: z.array(z.number().int()).optional(),
      reviewerIds: z.array(z.number().int()).optional(),
      removeSourceBranch: z.boolean().optional(),
      draft: z.boolean().optional(),
    },
    wrapTool(async (args) => {
      const body = {
        source_branch: args.sourceBranch,
        target_branch: args.targetBranch,
        title: args.title,
        description: args.description,
        assignee_ids: args.assigneeIds,
        reviewer_ids: args.reviewerIds,
        remove_source_branch: args.removeSourceBranch,
        draft: args.draft,
      };
      if (args.mergeRequestIid) {
        return gitlab.request(
          `projects/${p(args.projectId)}/merge_requests/${args.mergeRequestIid}`,
          { method: "PUT", body },
        );
      }
      if (!args.sourceBranch || !args.targetBranch || !args.title) {
        throw new Error("To create an MR, provide sourceBranch, targetBranch, and title.");
      }
      return gitlab.request(`projects/${p(args.projectId)}/merge_requests`, {
        method: "POST",
        body,
      });
    }),
  );

  server.tool(
    "gitlab_create_merge_request_note",
    "Comment on an MR (POST /merge_requests/:iid/notes).",
    {
      projectId,
      mergeRequestIid: z.number().int().positive(),
      body: z.string(),
    },
    wrapTool(async (args) =>
      gitlab.request(
        `projects/${p(args.projectId)}/merge_requests/${args.mergeRequestIid}/notes`,
        { method: "POST", body: { body: args.body } },
      ),
    ),
  );

  server.tool(
    "gitlab_accept_merge_request",
    "Accepts/merges an MR (PUT /merge_requests/:iid/merge).",
    {
      projectId,
      mergeRequestIid: z.number().int().positive(),
      squash: z.boolean().optional(),
      shouldRemoveSourceBranch: z.boolean().optional(),
      mergeCommitMessage: z.string().optional(),
    },
    wrapTool(async (args) =>
      gitlab.request(
        `projects/${p(args.projectId)}/merge_requests/${args.mergeRequestIid}/merge`,
        {
          method: "PUT",
          body: {
            squash: args.squash,
            should_remove_source_branch: args.shouldRemoveSourceBranch,
            merge_commit_message: args.mergeCommitMessage,
          },
        },
      ),
    ),
  );

  server.tool(
    "gitlab_add_branch",
    "Creates a branch (POST /repository/branches).",
    {
      projectId,
      branch: z.string(),
      ref: z.string().describe("Source branch, tag, or SHA."),
    },
    wrapTool(async (args) =>
      gitlab.request(`projects/${p(args.projectId)}/repository/branches`, {
        method: "POST",
        body: { branch: args.branch, ref: args.ref },
      }),
    ),
  );

  server.tool(
    "gitlab_add_commit",
    "Creates a commit with actions (POST /repository/commits).",
    {
      projectId,
      branch: z.string(),
      commitMessage: z.string(),
      actions: z
        .array(
          z.object({
            action: z.enum(["create", "delete", "move", "update", "chmod"]),
            file_path: z.string(),
            content: z.string().optional(),
            previous_path: z.string().optional(),
            encoding: z.enum(["text", "base64"]).optional(),
            execute_filemode: z.boolean().optional(),
          }),
        )
        .min(1),
      startBranch: z.string().optional(),
    },
    wrapTool(async (args) =>
      gitlab.request(`projects/${p(args.projectId)}/repository/commits`, {
        method: "POST",
        body: {
          branch: args.branch,
          commit_message: args.commitMessage,
          actions: args.actions,
          start_branch: args.startBranch,
        },
      }),
    ),
  );

  server.tool(
    "gitlab_get_repository_file",
    "File contents (GET /repository/files/:path). content is base64.",
    {
      projectId,
      filePath: z.string(),
      ref: z.string().optional().describe("Branch, tag, or SHA. Default: the project's default HEAD."),
    },
    wrapTool(async (args) =>
      gitlab.request(
        `projects/${p(args.projectId)}/repository/files/${encodeURIComponent(args.filePath)}`,
        { query: { ref: args.ref ?? "HEAD" } },
      ),
    ),
  );

  server.tool(
    "gitlab_get_commit",
    "Gets a commit (GET /repository/commits/:sha).",
    {
      projectId,
      sha: z.string(),
      stats: z.boolean().optional(),
    },
    wrapTool(async (args) =>
      gitlab.request(`projects/${p(args.projectId)}/repository/commits/${args.sha}`, {
        query: { stats: args.stats },
      }),
    ),
  );

  server.tool(
    "gitlab_list_pipelines",
    "Lists pipelines (GET /projects/:id/pipelines).",
    {
      projectId,
      ref: z.string().optional(),
      status: z.string().optional(),
      perPage: z.number().int().min(1).max(100).optional(),
      page: z.number().int().min(1).optional(),
    },
    wrapTool(async (args) =>
      gitlab.request(`projects/${p(args.projectId)}/pipelines`, {
        query: {
          ref: args.ref,
          status: args.status,
          per_page: args.perPage,
          page: args.page,
        },
      }),
    ),
  );

  server.tool(
    "gitlab_get_pipeline",
    "Gets a pipeline (GET /pipelines/:pipeline_id).",
    {
      projectId,
      pipelineId: z.number().int().positive(),
    },
    wrapTool(async (args) =>
      gitlab.request(`projects/${p(args.projectId)}/pipelines/${args.pipelineId}`),
    ),
  );

  server.tool(
    "gitlab_get_pipeline_jobs",
    "Jobs of a pipeline (GET /pipelines/:pipeline_id/jobs).",
    {
      projectId,
      pipelineId: z.number().int().positive(),
    },
    wrapTool(async (args) =>
      gitlab.request(`projects/${p(args.projectId)}/pipelines/${args.pipelineId}/jobs`),
    ),
  );

  server.tool(
    "gitlab_get_job",
    "Gets a job (GET /projects/:id/jobs/:job_id).",
    {
      projectId,
      jobId: z.number().int().positive(),
    },
    wrapTool(async (args) => gitlab.request(`projects/${p(args.projectId)}/jobs/${args.jobId}`)),
  );

  server.tool(
    "gitlab_list_project_members",
    "Project members (GET /projects/:id/members). members/all includes inherited members.",
    {
      projectId,
      query: z.string().optional(),
      includeInherited: z.boolean().optional(),
    },
    wrapTool(async (args) => {
      const path = args.includeInherited
        ? `projects/${p(args.projectId)}/members/all`
        : `projects/${p(args.projectId)}/members`;
      return gitlab.request(path, { query: { query: args.query } });
    }),
  );

  server.tool(
    "gitlab_search",
    "Search in the project (GET /projects/:id/search) or globally (GET /search).",
    {
      scope: z
        .string()
        .describe("projects, issues, merge_requests, milestones, snippet_titles, wiki_blobs, commits, blobs, users, notes."),
      search: z.string(),
      projectId: projectId.optional(),
    },
    wrapTool(async (args) => {
      if (args.projectId) {
        return gitlab.request(`projects/${p(args.projectId)}/search`, {
          query: { scope: args.scope, search: args.search },
        });
      }
      return gitlab.request("search", { query: { scope: args.scope, search: args.search } });
    }),
  );

  server.tool(
    "gitlab_search_labels",
    "Project labels (GET /projects/:id/labels).",
    {
      projectId,
      search: z.string().optional(),
    },
    wrapTool(async (args) =>
      gitlab.request(`projects/${p(args.projectId)}/labels`, {
        query: { search: args.search },
      }),
    ),
  );

  server.tool(
    "gitlab_list_wiki_pages",
    "Wiki pages (GET /projects/:id/wikis).",
    {
      projectId,
      withContent: z.boolean().optional(),
    },
    wrapTool(async (args) =>
      gitlab.request(`projects/${p(args.projectId)}/wikis`, {
        query: { with_content: args.withContent },
      }),
    ),
  );
}

import { z } from "zod";
import {
  type A,
  type Ctx,
  GROUP,
  PAGE,
  PROJ,
  PROJ_ID,
  dual,
  need,
  pageDesc,
  pageQuery,
  pageResult,
  pick,
  proj,
  readTool,
  scope,
  sumList,
  sumObj,
  writeTool,
} from "./gitlab-common.js";

const REF_DESC = "Branch, tag, or SHA. Default: the project's default HEAD.";

export function registerGitLabRepo(c: Ctx): void {
  const { gl } = c;

  writeTool(
    c,
    "gitlab_add_branch",
    "Creates a branch (POST /projects/:id/repository/branches) from ref. Changes the repository.",
    dual({ ...PROJ_ID, branch: z.string(), ref: z.string().describe("Source branch, tag, or SHA.") }),
    async (a) =>
      gl.request(`projects/${proj(a)}/repository/branches`, { method: "POST", body: { branch: a.branch, ref: a.ref } }),
  );

  writeTool(
    c,
    "gitlab_add_commit",
    "Creates a commit with file actions (POST /projects/:id/repository/commits) on branch. start_branch, or start_sha (+ start_project for another project), is the base when branch does not exist yet. Changes the repository.",
    dual({
      ...PROJ_ID,
      branch: z.string(),
      commit_message: z.string().optional().describe("Required (legacy: commitMessage)."),
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
      start_branch: z.string().optional(),
      start_sha: z.string().optional().describe("SHA to start the new branch from."),
      start_project: z.union([z.string(), z.number()]).optional().describe("Project ID or path to take start_branch/start_sha from."),
    }),
    async (a) =>
      gl.request(`projects/${proj(a)}/repository/commits`, {
        method: "POST",
        body: {
          branch: a.branch,
          commit_message: need(a.commit_message, "commit_message (legacy: commitMessage)"),
          actions: a.actions,
          start_branch: a.start_branch,
          start_sha: a.start_sha,
          start_project: a.start_project,
        },
      }),
  );

  readTool(
    c,
    "gitlab_get_repository_file",
    "File contents (GET /projects/:id/repository/files/:path). Without offset/limit the raw API object is returned (content is base64). With offset and/or limit the content is decoded and sliced by lines: offset = lines to skip (0-based), limit = max lines; returns {file_path, ref, size, total_lines, offset, returned_lines, truncated, content}.",
    dual({
      ...PROJ_ID,
      file_path: z.string().optional().describe("Required (legacy: filePath)."),
      ref: z.string().optional().describe(REF_DESC),
      offset: z.number().int().min(0).optional().describe("Lines to skip."),
      limit: z.number().int().min(1).optional().describe("Max lines to return."),
    }),
    sumObj(["file_path", "ref", "size", "total_lines", "returned_lines", "blob_id"]),
    async (a) => {
      const ref = a.ref ?? "HEAD";
      const file = await gl.request<A>(
        `projects/${proj(a)}/repository/files/${encodeURIComponent(need(a.file_path, "file_path (legacy: filePath)"))}`,
        { query: { ref } },
      );
      if (a.offset === undefined && a.limit === undefined) return file;
      const text = Buffer.from(String(file.content ?? ""), (file.encoding as BufferEncoding) ?? "base64").toString("utf8");
      const lines = text.split("\n");
      const start = a.offset ?? 0;
      const end = a.limit === undefined ? lines.length : start + a.limit;
      const slice = lines.slice(start, end);
      return {
        file_path: file.file_path ?? a.file_path,
        ref: file.ref ?? ref,
        blob_id: file.blob_id,
        size: file.size,
        total_lines: lines.length,
        offset: start,
        returned_lines: slice.length,
        truncated: end < lines.length,
        content: slice.join("\n"),
      };
    },
  );

  readTool(
    c,
    "gitlab_get_commit",
    "Gets a commit (GET /projects/:id/repository/commits/:sha). include: diff (GET …/diff) and/or notes (GET …/comments) return {commit, diff, notes}; without include the commit object itself is returned.",
    dual({
      ...PROJ_ID,
      sha: z.string(),
      stats: z.boolean().optional(),
      include: z.array(z.enum(["diff", "notes"])).optional(),
    }),
    (p) => ({
      ...pick(p?.commit ?? p, ["id", "short_id", "title", "web_url"]),
      ...(Array.isArray(p?.diff) ? { diff_files: p.diff.length } : {}),
    }),
    async (a) => {
      const base = `projects/${proj(a)}/repository/commits/${need(a.sha, "sha")}`;
      const commit = await gl.request(base, { query: { stats: a.stats } });
      const inc: string[] = a.include ?? [];
      if (!inc.length) return commit;
      const out: Record<string, unknown> = { commit };
      await Promise.all([
        inc.includes("diff") ? gl.request(`${base}/diff`).then((d) => (out.diff = d)) : undefined,
        inc.includes("notes") ? gl.request(`${base}/comments`).then((d) => (out.notes = d)) : undefined,
      ]);
      return out;
    },
  );

  readTool(
    c,
    "gitlab_list_branches",
    pageDesc("Lists repository branches (GET /projects/:id/repository/branches)."),
    { ...PROJ_ID, search: z.string().optional().describe("Name filter; ^term, term$ and * are supported by GitLab."), regex: z.string().optional(), ...PAGE },
    sumList(["name", "default", "merged", "protected"]),
    async (a) =>
      pageResult(a, await gl.request(`projects/${proj(a)}/repository/branches`, { query: { search: a.search, regex: a.regex, ...pageQuery(a) } })),
  );

  readTool(
    c,
    "gitlab_list_repository_tree",
    pageDesc("Lists files and directories (GET /projects/:id/repository/tree)."),
    {
      ...PROJ_ID,
      path: z.string().optional().describe("Directory inside the repository. Default: root."),
      ref: z.string().optional().describe(REF_DESC),
      recursive: z.boolean().optional(),
      ...PAGE,
    },
    sumList(["path", "type"]),
    async (a) =>
      pageResult(
        a,
        await gl.request(`projects/${proj(a)}/repository/tree`, {
          query: { path: a.path, ref: a.ref, recursive: a.recursive, ...pageQuery(a) },
        }),
      ),
  );

  readTool(
    c,
    "gitlab_list_commits",
    pageDesc("Lists commits (GET /projects/:id/repository/commits)."),
    {
      ...PROJ_ID,
      ref_name: z.string().optional().describe("Branch, tag or revision range. Default: the default branch."),
      path: z.string().optional().describe("Only commits touching this file path."),
      author: z.string().optional(),
      since: z.string().optional().describe("ISO 8601."),
      until: z.string().optional().describe("ISO 8601."),
      all: z.boolean().optional().describe("Commits of all branches."),
      with_stats: z.boolean().optional(),
      first_parent: z.boolean().optional(),
      order: z.enum(["default", "topo"]).optional(),
      ...PAGE,
    },
    sumList(["id", "short_id", "title", "author_name", "created_at"]),
    async (a) =>
      pageResult(
        a,
        await gl.request(`projects/${proj(a)}/repository/commits`, {
          query: {
            ref_name: a.ref_name,
            path: a.path,
            author: a.author,
            since: a.since,
            until: a.until,
            all: a.all,
            with_stats: a.with_stats,
            first_parent: a.first_parent,
            order: a.order,
            ...pageQuery(a),
          },
        }),
      ),
  );

  readTool(
    c,
    "gitlab_list_tags",
    pageDesc("Lists repository tags (GET /projects/:id/repository/tags)."),
    {
      ...PROJ_ID,
      search: z.string().optional(),
      order_by: z.enum(["name", "updated", "version"]).optional(),
      sort: z.enum(["asc", "desc"]).optional(),
      ...PAGE,
    },
    sumList(["name", "message"]),
    async (a) =>
      pageResult(
        a,
        await gl.request(`projects/${proj(a)}/repository/tags`, {
          query: { search: a.search, order_by: a.order_by, sort: a.sort, ...pageQuery(a) },
        }),
      ),
  );

  readTool(
    c,
    "gitlab_list_releases",
    pageDesc("Lists releases (GET /projects/:id/releases)."),
    {
      ...PROJ_ID,
      order_by: z.enum(["released_at", "created_at"]).optional(),
      sort: z.enum(["asc", "desc"]).optional(),
      include_html_description: z.boolean().optional(),
      ...PAGE,
    },
    sumList(["tag_name", "name", "released_at"]),
    async (a) =>
      pageResult(
        a,
        await gl.request(`projects/${proj(a)}/releases`, {
          query: {
            order_by: a.order_by,
            sort: a.sort,
            include_html_description: a.include_html_description,
            ...pageQuery(a),
          },
        }),
      ),
  );

  // ---------- search, labels, wiki ----------
  readTool(
    c,
    "gitlab_search",
    pageDesc(
      "Search (GET /projects/:id/search with project_id, GET /groups/:id/search with group_id, otherwise GET /search). Without first/after it returns a plain array (legacy).",
    ),
    dual({
      scope: z
        .string()
        .describe("projects, issues, merge_requests, milestones, snippet_titles, wiki_blobs, commits, blobs, users, notes."),
      search: z.string(),
      ...PROJ,
      ...GROUP,
      state: z.string().optional().describe("issues / merge_requests scopes: opened or closed."),
      confidential: z.boolean().optional().describe("issues scope."),
      ref: z.string().optional().describe("Project search: branch or tag for blobs, commits and wiki_blobs."),
      order_by: z.string().optional(),
      sort: z.enum(["asc", "desc"]).optional(),
      ...PAGE,
    }),
    sumList(["id", "iid", "title", "path", "filename", "web_url", "name"]),
    async (a) => {
      const hasScope = a.group_id !== undefined || a.project_id !== undefined;
      const path = hasScope ? `${scope(a)}/search` : "search";
      return pageResult(
        a,
        await gl.request(path, {
          query: {
            scope: a.scope,
            search: a.search,
            state: a.state,
            confidential: a.confidential,
            ref: a.project_id !== undefined ? a.ref : undefined,
            order_by: a.order_by,
            sort: a.sort,
            ...pageQuery(a),
          },
        }),
        true,
      );
    },
  );

  readTool(
    c,
    "gitlab_search_labels",
    "Labels of a project (GET /projects/:id/labels) or a group (GET /groups/:id/labels). search accepts one term or an array of terms (one request per term, results merged by label id).",
    dual({
      ...PROJ,
      ...GROUP,
      search: z.union([z.string(), z.array(z.string())]).optional(),
      include_ancestor_groups: z.boolean().optional().describe("Include labels of ancestor groups."),
      with_counts: z.boolean().optional(),
    }),
    sumList(["id", "name", "color"]),
    async (a) => {
      const path = `${scope(a)}/labels`;
      const base = { include_ancestor_groups: a.include_ancestor_groups, with_counts: a.with_counts, ...pageQuery(a) };
      const terms: Array<string | undefined> = Array.isArray(a.search) ? a.search : [a.search];
      if (!terms.length) terms.push(undefined);
      const lists = await Promise.all(terms.map((t) => gl.request<any[]>(path, { query: { ...base, search: t } })));
      if (lists.length === 1) return lists[0];
      const seen = new Set<unknown>();
      return lists.flat().filter((l) => (seen.has(l?.id) ? false : (seen.add(l?.id), true)));
    },
  );

  readTool(
    c,
    "gitlab_list_wiki_pages",
    "Wiki pages of a project (GET /projects/:id/wikis) or a group (GET /groups/:id/wikis).",
    dual({ ...PROJ, ...GROUP, with_content: z.boolean().optional() }),
    sumList(["slug", "title", "format"]),
    async (a) => gl.request(`${scope(a)}/wikis`, { query: { with_content: a.with_content } }),
  );

  readTool(
    c,
    "gitlab_get_wiki_page",
    "Gets one wiki page (GET /projects/:id/wikis/:slug or /groups/:id/wikis/:slug).",
    {
      ...PROJ,
      ...GROUP,
      slug: z.string().describe("Page slug, e.g. dir/page."),
      render_html: z.boolean().optional(),
      version: z.string().optional().describe("Wiki page version SHA."),
    },
    sumObj(["slug", "title", "format"]),
    async (a) =>
      gl.request(`${scope(a)}/wikis/${encodeURIComponent(need(a.slug, "slug"))}`, {
        query: { render_html: a.render_html, version: a.version },
      }),
  );
}

import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

type Call = { method: string; path: string; query: Record<string, string>; body?: any };
type Responder = (method: string, path: string, query: Record<string, string>) => unknown;
type Res = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function setup(env: Record<string, string> = {}, responder: Responder = () => undefined) {
  const calls: Call[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const p = url.pathname.replace("/api/v4/", "");
    const call: Call = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: p,
      query: Object.fromEntries(url.searchParams),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const out = responder(call.method, p, call.query);
    if (typeof out === "string") return new Response(out, { status: 200, headers: { "content-type": "text/plain" } });
    return new Response(JSON.stringify(out ?? { ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const config = loadConfig({ GITLAB_TOKEN: "t", DEV_MCP_PARITY_WRITES: "1", ...env } as NodeJS.ProcessEnv);
  const server = createServer(config, { fetch: fetchMock });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as Res;
    const text = res.content[0]?.text ?? "";
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { res, json };
  };
  return { client, calls, call };
}

const P = "g%2Fp";
const last = (calls: Call[]) => calls[calls.length - 1]!;

describe("gitlab parity: request shapes", () => {
  type Case = [name: string, args: Record<string, unknown>, method: string, path: string, query?: Record<string, string>, body?: unknown];
  const cases: Case[] = [
    ["gitlab_get_user", {}, "GET", "user"],
    ["gitlab_get_user", { me: true }, "GET", "user"],
    ["gitlab_get_user", { id: 5 }, "GET", "users/5"],
    ["gitlab_whoami", {}, "GET", "user"],
    ["gitlab_get_project", { project_id: "g/p", statistics: true }, "GET", `projects/${P}`, { statistics: "true" }],
    ["gitlab_get_group", { group_id: "g/sub" }, "GET", "groups/g%2Fsub"],
    ["gitlab_list_groups", { group_id: "g", first: 5 }, "GET", "groups/g/subgroups", { per_page: "5" }],
    ["gitlab_list_groups", { search: "x", top_level_only: true }, "GET", "groups", { search: "x", top_level_only: "true" }],
    ["gitlab_get_mcp_server_version", {}, "GET", "version"],
    ["gitlab_list_todos", { action: "assigned", state: "pending" }, "GET", "todos", { action: "assigned", state: "pending" }],
    ["gitlab_list_user_events", { user_id: 3, date_after: "2026-01-01", action: "pushed" }, "GET", "users/3/events", { after: "2026-01-01", action: "pushed" }],
    ["gitlab_list_milestones", { group_id: "g", state: "active" }, "GET", "groups/g/milestones", { state: "active" }],
    ["gitlab_list_milestones", { project_id: "g/p" }, "GET", `projects/${P}/milestones`],
    ["gitlab_list_projects", { group_id: "g", include_subgroups: true, archived: false }, "GET", "groups/g/projects", { include_subgroups: "true", archived: "false", per_page: "100" }],
    ["gitlab_list_projects", { minAccessLevel: 30 }, "GET", "projects", { membership: "true", min_access_level: "30", per_page: "100" }],
    ["gitlab_list_work_items", { project_id: "g/p", state: "opened", labels: "a,b" }, "GET", `projects/${P}/issues`, { state: "opened", labels: "a,b" }],
    ["gitlab_get_work_item", { project_id: "g/p", work_item_iid: 4 }, "GET", `projects/${P}/issues/4`],
    ["gitlab_get_work_item", { url: "https://gitlab.com/g/p/-/issues/9" }, "GET", `projects/${P}/issues/9`],
    ["gitlab_get_work_item", { url: "https://gitlab.com/g/p/-/work_items/10" }, "GET", `projects/${P}/issues/10`],
    ["gitlab_get_issue", { projectId: "g/p", issueIid: 4 }, "GET", `projects/${P}/issues/4`],
    ["gitlab_save_work_item", { project_id: "g/p", title: "T", labels: "x" }, "POST", `projects/${P}/issues`, undefined, { title: "T", labels: "x" }],
    ["gitlab_save_work_item", { project_id: "g/p", work_item_iid: 4, state_event: "close" }, "PUT", `projects/${P}/issues/4`, undefined, { state_event: "close" }],
    ["gitlab_create_issue", { projectId: "g/p", title: "T", assigneeIds: [1] }, "POST", `projects/${P}/issues`, undefined, { title: "T", assignee_ids: [1] }],
    [
      "gitlab_link_work_items",
      { project_id: "g/p", work_item_iid: 1, target_project_id: "g/q", target_work_item_iid: 2, link_type: "blocks" },
      "POST",
      `projects/${P}/issues/1/links`,
      undefined,
      { target_project_id: "g/q", target_issue_iid: 2, link_type: "blocks" },
    ],
    ["gitlab_save_note", { project_id: "g/p", merge_request_iid: 7, body: "hi" }, "POST", `projects/${P}/merge_requests/7/notes`, undefined, { body: "hi" }],
    ["gitlab_save_note", { project_id: "g/p", work_item_iid: 3, body: "hi", internal: true }, "POST", `projects/${P}/issues/3/notes`, undefined, { body: "hi", internal: true }],
    ["gitlab_save_note", { project_id: "g/p", merge_request_iid: 7, body: "re", discussion_id: "abc" }, "POST", `projects/${P}/merge_requests/7/discussions/abc/notes`, undefined, { body: "re" }],
    ["gitlab_save_note", { project_id: "g/p", merge_request_iid: 7, body: "ed", note_id: 9 }, "PUT", `projects/${P}/merge_requests/7/notes/9`, undefined, { body: "ed" }],
    ["gitlab_save_note", { project_id: "g/p", merge_request_iid: 7, discussion_id: "abc", resolved: true }, "PUT", `projects/${P}/merge_requests/7/discussions/abc`, undefined, { resolved: true }],
    ["gitlab_create_merge_request_note", { projectId: "g/p", mergeRequestIid: 7, body: "hi" }, "POST", `projects/${P}/merge_requests/7/notes`, undefined, { body: "hi" }],
    ["gitlab_list_merge_requests", { project_id: "g/p", state: "opened", reviewer_username: "bob", author_username: "al" }, "GET", `projects/${P}/merge_requests`, { state: "opened", reviewer_username: "bob", author_username: "al" }],
    ["gitlab_list_merge_requests", { group_id: "g", assignee_id: 4, labels: "x" }, "GET", "groups/g/merge_requests", { assignee_id: "4", labels: "x" }],
    ["gitlab_list_merge_requests", { projectId: "g/p", sourceBranch: "f", perPage: 5, page: 2 }, "GET", `projects/${P}/merge_requests`, { source_branch: "f", per_page: "5", page: "2" }],
    ["gitlab_accept_merge_request", { project_id: "g/p", merge_request_iid: 7, sha: "abc", squash: true }, "PUT", `projects/${P}/merge_requests/7/merge`, undefined, { sha: "abc", squash: true }],
    ["gitlab_accept_merge_request", { projectId: "g/p", mergeRequestIid: 7, shouldRemoveSourceBranch: true }, "PUT", `projects/${P}/merge_requests/7/merge`, undefined, { should_remove_source_branch: true }],
    ["gitlab_save_merge_request", { projectId: "g/p", sourceBranch: "f", targetBranch: "main", title: "T" }, "POST", `projects/${P}/merge_requests`, undefined, { source_branch: "f", target_branch: "main", title: "T" }],
    ["gitlab_save_merge_request", { project_id: "g/p", merge_request_iid: 7, title: "N" }, "PUT", `projects/${P}/merge_requests/7`, undefined, { title: "N" }],
    ["gitlab_save_merge_request_review", { project_id: "g/p", merge_request_iid: 7, method: "create_note", body: "hi", internal: true }, "POST", `projects/${P}/merge_requests/7/notes`, undefined, { body: "hi", internal: true }],
    ["gitlab_save_merge_request_review", { url: "https://gitlab.com/g/p/-/merge_requests/7", method: "reply_discussion", discussion_id: "gid://gitlab/Discussion/abc", body: "re" }, "POST", `projects/${P}/merge_requests/7/discussions/abc/notes`, undefined, { body: "re" }],
    ["gitlab_save_merge_request_review", { project_id: "g/p", merge_request_iid: 7, method: "resolve_discussion", discussion_id: "abc", resolved: false }, "PUT", `projects/${P}/merge_requests/7/discussions/abc`, { resolved: "false" }],
    ["gitlab_save_merge_request_review", { project_id: "g/p", merge_request_iid: 7, method: "update_note", note_id: 9, body: "ed" }, "PUT", `projects/${P}/merge_requests/7/notes/9`, undefined, { body: "ed" }],
    ["gitlab_save_merge_request_review", { url: "https://gitlab.com/g/p/-/merge_requests/7#note_12", method: "update_note", body: "ed" }, "PUT", `projects/${P}/merge_requests/7/notes/12`, undefined, { body: "ed" }],
    ["gitlab_save_merge_request_review", { project_id: "g/p", merge_request_iid: 7, method: "approve", sha: "abc" }, "POST", `projects/${P}/merge_requests/7/approve`, undefined, { sha: "abc" }],
    ["gitlab_save_merge_request_review", { project_id: "g/p", merge_request_iid: 7, method: "unapprove" }, "POST", `projects/${P}/merge_requests/7/unapprove`],
    ["gitlab_apply_suggestion", { suggestion_id: 11, commit_message: "m" }, "PUT", "suggestions/11/apply", undefined, { commit_message: "m" }],
    ["gitlab_apply_suggestion", { suggestion_ids: [1, 2] }, "PUT", "suggestions/batch_apply", undefined, { ids: [1, 2] }],
    ["gitlab_add_branch", { projectId: "g/p", branch: "n", ref: "main" }, "POST", `projects/${P}/repository/branches`, undefined, { branch: "n", ref: "main" }],
    ["gitlab_add_branch", { id: "g/p", branch: "n", ref: "main" }, "POST", `projects/${P}/repository/branches`, undefined, { branch: "n", ref: "main" }],
    [
      "gitlab_add_commit",
      { id: "g/p", branch: "n", commit_message: "m", actions: [{ action: "create", file_path: "a", content: "x" }], start_sha: "s1", start_project: "g/q" },
      "POST",
      `projects/${P}/repository/commits`,
      undefined,
      { branch: "n", commit_message: "m", start_sha: "s1", start_project: "g/q" },
    ],
    [
      "gitlab_add_commit",
      { projectId: "g/p", branch: "n", commitMessage: "m", startBranch: "main", actions: [{ action: "delete", file_path: "a" }] },
      "POST",
      `projects/${P}/repository/commits`,
      undefined,
      { branch: "n", commit_message: "m", start_branch: "main" },
    ],
    ["gitlab_get_repository_file", { id: "g/p", file_path: "src/a.ts", ref: "dev" }, "GET", `projects/${P}/repository/files/src%2Fa.ts`, { ref: "dev" }],
    ["gitlab_get_repository_file", { projectId: "g/p", filePath: "a.md" }, "GET", `projects/${P}/repository/files/a.md`, { ref: "HEAD" }],
    ["gitlab_get_commit", { id: "g/p", sha: "abc", stats: true }, "GET", `projects/${P}/repository/commits/abc`, { stats: "true" }],
    ["gitlab_list_branches", { id: "g/p", search: "^f", first: 10 }, "GET", `projects/${P}/repository/branches`, { search: "^f", per_page: "10" }],
    ["gitlab_list_repository_tree", { id: "g/p", path: "src", ref: "main", recursive: true }, "GET", `projects/${P}/repository/tree`, { path: "src", ref: "main", recursive: "true" }],
    ["gitlab_list_commits", { id: "g/p", ref_name: "main", path: "a", since: "2026-01-01T00:00:00Z", with_stats: true }, "GET", `projects/${P}/repository/commits`, { ref_name: "main", path: "a", since: "2026-01-01T00:00:00Z", with_stats: "true" }],
    ["gitlab_list_tags", { id: "g/p", order_by: "updated", sort: "desc" }, "GET", `projects/${P}/repository/tags`, { order_by: "updated", sort: "desc" }],
    ["gitlab_list_releases", { id: "g/p", order_by: "released_at" }, "GET", `projects/${P}/releases`, { order_by: "released_at" }],
    ["gitlab_search", { scope: "issues", search: "bug" }, "GET", "search", { scope: "issues", search: "bug" }],
    ["gitlab_search", { scope: "blobs", search: "x", projectId: "g/p" }, "GET", `projects/${P}/search`, { scope: "blobs", search: "x" }],
    ["gitlab_search", { scope: "issues", search: "x", group_id: "g", state: "opened", confidential: false }, "GET", "groups/g/search", { scope: "issues", search: "x", state: "opened", confidential: "false" }],
    ["gitlab_search_labels", { project_id: "g/p", search: "bug" }, "GET", `projects/${P}/labels`, { search: "bug" }],
    ["gitlab_search_labels", { group_id: "g", include_ancestor_groups: true }, "GET", "groups/g/labels", { include_ancestor_groups: "true" }],
    ["gitlab_list_wiki_pages", { project_id: "g/p", with_content: true }, "GET", `projects/${P}/wikis`, { with_content: "true" }],
    ["gitlab_list_wiki_pages", { projectId: "g/p", withContent: true }, "GET", `projects/${P}/wikis`, { with_content: "true" }],
    ["gitlab_list_wiki_pages", { group_id: "g" }, "GET", "groups/g/wikis"],
    ["gitlab_get_wiki_page", { project_id: "g/p", slug: "dir/page", render_html: true }, "GET", `projects/${P}/wikis/dir%2Fpage`, { render_html: "true" }],
    ["gitlab_list_project_members", { projectId: "g/p", includeInherited: true }, "GET", `projects/${P}/members/all`],
    ["gitlab_list_pipelines", { id: "g/p", ref: "main", status: "failed" }, "GET", `projects/${P}/pipelines`, { ref: "main", status: "failed" }],
    ["gitlab_list_pipelines", { projectId: "g/p", perPage: 3 }, "GET", `projects/${P}/pipelines`, { per_page: "3" }],
    ["gitlab_get_pipeline", { id: "g/p", pipeline_id: 5 }, "GET", `projects/${P}/pipelines/5`],
    ["gitlab_get_pipeline", { projectId: "g/p", pipelineId: 5 }, "GET", `projects/${P}/pipelines/5`],
    ["gitlab_get_pipeline_jobs", { projectId: "g/p", pipelineId: 5 }, "GET", `projects/${P}/pipelines/5/jobs`],
    ["gitlab_get_job", { id: "g/p", job_id: 8 }, "GET", `projects/${P}/jobs/8`],
    ["gitlab_get_job", { projectId: "g/p", jobId: 8 }, "GET", `projects/${P}/jobs/8`],
    ["gitlab_get_artifact_file", { id: "g/p", job_id: 8, artifact_path: "out/r.txt" }, "GET", `projects/${P}/jobs/8/artifacts/out/r.txt`],
    ["gitlab_save_pipeline", { id: "g/p", action: "create", ref: "main", variables: [{ key: "A", value: "1" }] }, "POST", `projects/${P}/pipeline`, undefined, { ref: "main", variables: [{ key: "A", value: "1" }] }],
    ["gitlab_save_pipeline", { id: "g/p", action: "retry", pipeline_id: 5 }, "POST", `projects/${P}/pipelines/5/retry`],
    ["gitlab_save_pipeline", { id: "g/p", action: "cancel", pipeline_id: 5 }, "POST", `projects/${P}/pipelines/5/cancel`],
    ["gitlab_save_pipeline", { id: "g/p", action: "update", pipeline_id: 5, name: "nn" }, "PUT", `projects/${P}/pipelines/5/metadata`, undefined, { name: "nn" }],
    ["gitlab_save_pipeline", { id: "g/p", action: "mr_pipeline", merge_request_iid: 7 }, "POST", `projects/${P}/merge_requests/7/pipelines`],
    ["gitlab_save_pipeline_job", { id: "g/p", job_id: 8, job_variables_attributes: [{ key: "K", value: "v" }] }, "POST", `projects/${P}/jobs/8/play`, undefined, { job_variables_attributes: [{ key: "K", value: "v" }] }],
    ["gitlab_list_pipeline_schedules", { id: "g/p", scope: "active" }, "GET", `projects/${P}/pipeline_schedules`, { scope: "active" }],
  ];

  it.each(cases)("%s %j", async (name, args, method, p, query, body) => {
    const { calls, call } = await setup({}, (m, pt) => {
      if (pt === "users" || pt.endsWith("/draft_notes")) return [{ id: 1 }];
      if (m === "GET" && pt.includes("/repository/files/")) return { content: "", encoding: "base64" };
      return undefined;
    });
    const { res } = await call(name, args);
    expect(res.isError, JSON.stringify(res.content)).toBeUndefined();
    const c = last(calls);
    expect(c.method).toBe(method);
    expect(c.path).toBe(p);
    if (query) expect(c.query).toMatchObject(query);
    if (body) expect(c.body).toMatchObject(body as object);
  });

  it("save_merge_request sets draft through the title marker, which is all the REST API reads", async () => {
    const { calls, call } = await setup({}, (m, pt) => (m === "GET" && pt.endsWith("/merge_requests/7") ? { title: "Draft: T" } : {}));
    await call("gitlab_save_merge_request", { project_id: "g/p", source_branch: "f", target_branch: "main", title: "T", draft: true });
    expect(last(calls).body).toEqual(expect.objectContaining({ title: "Draft: T" }));
    expect(last(calls).body).not.toHaveProperty("draft");
    await call("gitlab_save_merge_request", { project_id: "g/p", merge_request_iid: 7, draft: false });
    expect(last(calls)).toMatchObject({ method: "PUT", body: { title: "T" } });
    await call("gitlab_save_merge_request", { project_id: "g/p", merge_request_iid: 7, title: "[Draft] N", draft: true });
    expect(last(calls).body).toMatchObject({ title: "Draft: N" });
  });

  it("looks up a user by username, and events fall back to that user", async () => {
    const { calls, call } = await setup({}, (_m, pt) => (pt === "users" ? [{ id: 42, username: "bob" }] : undefined));
    const { json } = await call("gitlab_get_user", { username: "bob" });
    expect(calls[0]).toMatchObject({ path: "users", query: { username: "bob" } });
    expect(json.id).toBe(42);
    await call("gitlab_list_user_events", { username: "bob" });
    expect(last(calls).path).toBe("users/42/events");
  });
});

describe("gitlab parity: includes and slicing", () => {
  it("get_merge_request include discussions/approvals and url", async () => {
    const { calls, call } = await setup({}, (_m, pt) => (pt.endsWith("/merge_requests/7") ? { iid: 7 } : []));
    const { json } = await call("gitlab_get_merge_request", {
      url: "https://gitlab.com/g/p/-/merge_requests/7",
      include: ["discussions", "approvals", "commits"],
    });
    expect(calls.map((c) => c.path).sort()).toEqual(
      [
        `projects/${P}/merge_requests/7`,
        `projects/${P}/merge_requests/7/approvals`,
        `projects/${P}/merge_requests/7/commits`,
        `projects/${P}/merge_requests/7/discussions`,
      ].sort(),
    );
    expect(Object.keys(json).sort()).toEqual(["approvals", "commits", "discussions", "merge_request"]);
  });

  it("get_merge_request keeps the legacy include booleans and camelCase ids", async () => {
    const { calls, call } = await setup({}, (_m, pt) => (pt.endsWith("/merge_requests/7") ? { iid: 7 } : []));
    const { json } = await call("gitlab_get_merge_request", {
      projectId: "g/p",
      mergeRequestIid: 7,
      includeNotes: true,
      includePipelines: true,
    });
    expect(calls.map((c) => c.path)).toContain(`projects/${P}/merge_requests/7/notes`);
    expect(calls.map((c) => c.path)).toContain(`projects/${P}/merge_requests/7/pipelines`);
    expect(Object.keys(json).sort()).toEqual(["merge_request", "notes", "pipelines"]);
  });

  it("get_commit include diff and notes", async () => {
    const { calls, call } = await setup({}, (_m, pt) => (pt.endsWith("/abc") ? { id: "abc" } : []));
    const { json } = await call("gitlab_get_commit", { id: "g/p", sha: "abc", include: ["diff", "notes"] });
    expect(calls.map((c) => c.path).sort()).toEqual(
      [`projects/${P}/repository/commits/abc`, `projects/${P}/repository/commits/abc/comments`, `projects/${P}/repository/commits/abc/diff`].sort(),
    );
    expect(Object.keys(json).sort()).toEqual(["commit", "diff", "notes"]);
  });

  it("get_repository_file slices lines with offset/limit", async () => {
    const content = Buffer.from("a\nb\nc\nd\ne").toString("base64");
    const { call } = await setup({}, () => ({ file_path: "f", size: 9, encoding: "base64", content, blob_id: "x" }));
    const { json } = await call("gitlab_get_repository_file", { id: "g/p", file_path: "f", offset: 1, limit: 2 });
    expect(json).toMatchObject({ content: "b\nc", offset: 1, returned_lines: 2, total_lines: 5, truncated: true });
  });

  it("get_job include log slices bytes, negative offset tails, artifacts come from the job", async () => {
    const { calls, call } = await setup({}, (_m, pt) =>
      pt.endsWith("/trace") ? "0123456789" : { id: 8, name: "build", artifacts_file: { filename: "a.zip" }, artifacts: [{ filename: "a.zip" }] },
    );
    const a = await call("gitlab_get_job", { id: "g/p", job_id: 8, include: ["log", "artifacts"], offset: 2, limit: 3 });
    expect(a.json.log).toMatchObject({ content: "234", offset: 2, bytes: 3, total_bytes: 10, truncated: true });
    expect(a.json.artifacts.files).toHaveLength(1);
    expect(calls.map((c) => c.path)).toContain(`projects/${P}/jobs/8/trace`);
    const tail = await call("gitlab_get_job", { id: "g/p", job_id: 8, include: ["log"], offset: -4 });
    expect(tail.json.log).toMatchObject({ content: "6789", truncated: false });
  });

  it("get_pipeline include jobs, bridge_jobs, downstream_pipelines and artifacts", async () => {
    const { calls, call } = await setup({}, (_m, pt) => {
      if (pt.endsWith("/jobs")) return [{ id: 1, name: "a", artifacts: [{ filename: "x" }] }, { id: 2, name: "b", artifacts: [] }];
      if (pt.endsWith("/bridges")) return [{ id: 3, downstream_pipeline: { id: 99 } }];
      return { id: 5, status: "success" };
    });
    const { json } = await call("gitlab_get_pipeline", {
      id: "g/p",
      pipeline_id: 5,
      include: ["jobs", "bridge_jobs", "downstream_pipelines", "artifacts"],
    });
    expect(calls.map((c) => c.path).sort()).toEqual(
      [`projects/${P}/pipelines/5`, `projects/${P}/pipelines/5/bridges`, `projects/${P}/pipelines/5/jobs`].sort(),
    );
    expect(json.jobs).toHaveLength(2);
    expect(json.bridge_jobs).toHaveLength(1);
    expect(json.downstream_pipelines).toEqual([{ id: 99 }]);
    expect(json.artifacts).toEqual([expect.objectContaining({ job_id: 1 })]);
  });

  it("get_artifact_file returns the text content", async () => {
    const { call } = await setup({}, () => "hello");
    const { json } = await call("gitlab_get_artifact_file", { id: "g/p", job_id: 8, artifact_path: "a/b.txt" });
    expect(json).toEqual({ job_id: 8, artifact_path: "a/b.txt", content: "hello" });
  });

  it("search_labels with several terms merges unique labels", async () => {
    const { calls, call } = await setup({}, (_m, _p, q) => (q.search === "a" ? [{ id: 1 }, { id: 2 }] : [{ id: 2 }, { id: 3 }]));
    const { json } = await call("gitlab_search_labels", { project_id: "g/p", search: ["a", "b"] });
    expect(calls.map((c) => c.query.search).sort()).toEqual(["a", "b"]);
    expect(json.map((l: any) => l.id)).toEqual([1, 2, 3]);
  });
});

describe("gitlab parity: pagination", () => {
  it("new list tools return {items, next_cursor} and the cursor selects the next page", async () => {
    const { calls, call } = await setup({}, () => [{ name: "a" }, { name: "b" }]);
    const first = await call("gitlab_list_branches", { id: "g/p", first: 2 });
    expect(first.json.items).toHaveLength(2);
    expect(first.json.has_next_page).toBe(true);
    expect(typeof first.json.next_cursor).toBe("string");
    expect(last(calls).query).toMatchObject({ per_page: "2" });
    await call("gitlab_list_branches", { id: "g/p", first: 2, after: first.json.next_cursor });
    expect(last(calls).query).toMatchObject({ per_page: "2", page: "2" });
  });

  it("the last page has a null cursor", async () => {
    const { call } = await setup({}, () => [{ name: "a" }]);
    const { json } = await call("gitlab_list_tags", { id: "g/p", first: 5 });
    expect(json).toMatchObject({ items: [{ name: "a" }], next_cursor: null, has_next_page: false });
  });

  it("rejects a malformed cursor", async () => {
    const { call, calls } = await setup();
    const { res } = await call("gitlab_list_tags", { id: "g/p", after: "###" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/Invalid cursor/);
    expect(calls).toHaveLength(0);
  });

  it("legacy list tools stay plain arrays without first/after, and wrap with them", async () => {
    const { call } = await setup({}, () => [{ iid: 1 }]);
    const plain = await call("gitlab_list_merge_requests", { projectId: "g/p" });
    expect(Array.isArray(plain.json)).toBe(true);
    const wrapped = await call("gitlab_list_merge_requests", { project_id: "g/p", first: 1 });
    expect(wrapped.json.items).toEqual([{ iid: 1 }]);
    expect(wrapped.json.next_cursor).toEqual(expect.any(String));
  });
});

describe("gitlab parity: argument validation and both spellings", () => {
  it("asks for a project when none is given", async () => {
    const { call, calls } = await setup();
    for (const name of ["gitlab_get_pipeline", "gitlab_get_job", "gitlab_list_branches", "gitlab_get_merge_request", "gitlab_get_work_item"]) {
      const { res } = await call(name, { pipeline_id: 1, job_id: 1, merge_request_iid: 1, work_item_iid: 1 });
      expect(res.isError, name).toBe(true);
      expect(res.content[0]!.text, name).toMatch(/project_id/);
    }
    expect(calls).toHaveLength(0);
  });

  it("asks for the iid / ids", async () => {
    const { call } = await setup();
    const mr = await call("gitlab_get_merge_request", { project_id: "g/p" });
    expect(mr.res.content[0]!.text).toMatch(/merge_request_iid/);
    const job = await call("gitlab_get_job", { id: "g/p" });
    expect(job.res.content[0]!.text).toMatch(/job_id/);
    const note = await call("gitlab_save_note", { project_id: "g/p", body: "x" });
    expect(note.res.content[0]!.text).toMatch(/merge_request_iid or work_item_iid/);
    const wi = await call("gitlab_save_work_item", { project_id: "g/p" });
    expect(wi.res.content[0]!.text).toMatch(/title/);
  });

  it("the official spelling wins over the legacy one", async () => {
    const { calls, call } = await setup();
    await call("gitlab_get_pipeline", { project_id: "a/b", projectId: "x/y", pipeline_id: 1, pipelineId: 2 });
    expect(last(calls).path).toBe("projects/a%2Fb/pipelines/1");
  });

  it("describes legacy parameters as deprecated and new tools as writes where they write", async () => {
    const { client } = await setup();
    const tools = (await client.listTools()).tools;
    const by = (n: string) => tools.find((t) => t.name === n)!;
    const props = by("gitlab_get_merge_request").inputSchema.properties as Record<string, { description?: string }>;
    expect(props.projectId!.description).toMatch(/Deprecated/);
    expect(props.save_to).toBeDefined();
    expect(by("gitlab_list_branches").description).toMatch(/next_cursor/);
    expect(by("gitlab_save_pipeline").description).toMatch(/starts a pipeline|cancels/);
    expect(by("gitlab_get_job").description).toMatch(/save_to/);
  });

  it("save_to writes the full payload and returns a summary", async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), "devmcp-gl-")));
    const prev = process.env.DEV_MCP_SAVE_ROOTS;
    process.env.DEV_MCP_SAVE_ROOTS = dir;
    try {
      const { call } = await setup({}, (_m, pt) => (pt.endsWith("/trace") ? "log text" : { id: 8, name: "b", status: "success" }));
      const file = path.join(dir, "job.json");
      const { json } = await call("gitlab_get_job", { id: "g/p", job_id: 8, include: ["log"], save_to: file });
      expect(json).toMatchObject({ saved_to: file, kind: "json", summary: { id: 8 } });
      expect(JSON.parse(await readFile(file, "utf8")).log.content).toBe("log text");
    } finally {
      if (prev === undefined) delete process.env.DEV_MCP_SAVE_ROOTS;
      else process.env.DEV_MCP_SAVE_ROOTS = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("gitlab parity: save_merge_request_review diff notes and submit_review", () => {
  const refs = { base_sha: "b", start_sha: "s", head_sha: "h" };
  const mrResponder: Responder = (_m, pt) => (pt.endsWith("/merge_requests/7") ? { iid: 7, diff_refs: refs } : { ok: true });

  it("create_diff_note posts a discussion with a position from diff_refs", async () => {
    const { calls, call } = await setup({}, mrResponder);
    await call("gitlab_save_merge_request_review", { project_id: "g/p", merge_request_iid: 7, method: "create_diff_note", body: "x", new_path: "a.ts", new_line: 3 });
    expect(calls[0]).toMatchObject({ method: "GET", path: `projects/${P}/merge_requests/7` });
    expect(last(calls)).toMatchObject({ method: "POST", path: `projects/${P}/merge_requests/7/discussions` });
    expect(last(calls).body).toEqual({
      body: "x",
      position: { position_type: "text", ...refs, old_path: "a.ts", new_path: "a.ts", new_line: 3 },
    });
  });

  it("submit_review creates draft notes with positions, a summary draft, then bulk-publishes", async () => {
    const { calls, call } = await setup({}, mrResponder);
    const { res } = await call("gitlab_save_merge_request_review", {
      project_id: "g/p",
      merge_request_iid: 7,
      method: "submit_review",
      comments: [{ file: "a.ts", body: "c1", new_line: 2, suggestion: "fix" }, { file: "b.ts", body: "c2", old_line: 5 }],
      verdict: "Changes requested",
      summary: "see inline",
    });
    expect(res.isError).toBeUndefined();
    const dn = `projects/${P}/merge_requests/7/draft_notes`;
    expect(calls.slice(1).map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${dn}`, `POST ${dn}`, `POST ${dn}`, `POST ${dn}/bulk_publish`]);
    expect(calls[1]!.body.note).toContain("```suggestion:-0+0\nfix\n```");
    expect(calls[1]!.body.position).toMatchObject({ ...refs, new_path: "a.ts", new_line: 2 });
    expect(calls[3]!.body).toEqual({ note: "**Changes requested**\n\nsee inline" });
  });

  it("submit_review posts an internal summary as a normal internal note after publishing", async () => {
    const { calls, call } = await setup({}, mrResponder);
    await call("gitlab_save_merge_request_review", { project_id: "g/p", merge_request_iid: 7, method: "submit_review", comments: [{ file: "a", body: "c", new_line: 1 }], summary: "s", summary_internal: true });
    expect(last(calls)).toMatchObject({ method: "POST", path: `projects/${P}/merge_requests/7/notes`, body: { body: "s", internal: true } });
  });

  it("rejects parameters of another method, quick-action bodies and missing required ones", async () => {
    const { call, calls } = await setup();
    const base = { project_id: "g/p", merge_request_iid: 7 };
    const wrong = await call("gitlab_save_merge_request_review", { ...base, method: "approve", body: "x" });
    expect(wrong.res.content[0]!.text).toMatch(/does not apply to method approve/);
    const slash = await call("gitlab_save_merge_request_review", { ...base, method: "create_note", body: "/merge" });
    expect(slash.res.content[0]!.text).toMatch(/cannot start with/);
    const noRes = await call("gitlab_save_merge_request_review", { ...base, method: "resolve_discussion", discussion_id: "a" });
    expect(noRes.res.content[0]!.text).toMatch(/resolved/);
    const old = await call("gitlab_save_merge_request_review", { ...base, method: "publish_review" });
    expect(old.res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("gitlab parity: legacy aliases", () => {
  const ALIASES = ["gitlab_whoami", "gitlab_create_merge_request_note", "gitlab_get_issue", "gitlab_create_issue", "gitlab_get_pipeline_jobs"];
  const CANONICAL = [
    "gitlab_get_user",
    "gitlab_save_note",
    "gitlab_get_work_item",
    "gitlab_save_work_item",
    "gitlab_get_pipeline",
    "gitlab_get_mcp_server_version",
    "gitlab_get_project",
    "gitlab_get_group",
    "gitlab_list_groups",
    "gitlab_list_todos",
    "gitlab_list_user_events",
    "gitlab_list_milestones",
    "gitlab_list_work_items",
    "gitlab_link_work_items",
    "gitlab_save_merge_request_review",
    "gitlab_apply_suggestion",
    "gitlab_list_branches",
    "gitlab_list_repository_tree",
    "gitlab_list_commits",
    "gitlab_list_tags",
    "gitlab_list_releases",
    "gitlab_get_artifact_file",
    "gitlab_save_pipeline",
    "gitlab_save_pipeline_job",
    "gitlab_list_pipeline_schedules",
    "gitlab_get_wiki_page",
  ];

  it("are registered by default and describe the canonical tool", async () => {
    const { client } = await setup();
    const tools = (await client.listTools()).tools;
    for (const n of [...ALIASES, ...CANONICAL]) expect(tools.some((t) => t.name === n), n).toBe(true);
    expect(tools.find((t) => t.name === "gitlab_whoami")!.description).toMatch(/Deprecated alias of gitlab_get_user/);
  });

  it("keep their old schema (required camelCase ids)", async () => {
    const { client } = await setup();
    const tools = (await client.listTools()).tools;
    const issue = tools.find((t) => t.name === "gitlab_get_issue")!.inputSchema;
    expect(issue.required).toEqual(expect.arrayContaining(["projectId", "issueIid"]));
    const jobs = tools.find((t) => t.name === "gitlab_get_pipeline_jobs")!.inputSchema;
    expect(Object.keys(jobs.properties!).sort()).toEqual(["overwrite", "pipelineId", "projectId", "save_to"]);
  });

  it("are hidden with DEV_MCP_LEGACY_TOOL_NAMES=0, canonical tools stay", async () => {
    const { client } = await setup({ DEV_MCP_LEGACY_TOOL_NAMES: "0" });
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ALIASES) expect(names, n).not.toContain(n);
    for (const n of CANONICAL) expect(names, n).toContain(n);
  });
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

type Call = { method: string; url: URL; body: unknown };

async function setup(legacy = true) {
  const calls: Call[] = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (init?.method === "DELETE" || url.pathname.endsWith("/watchers") && init?.method === "POST") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/myself")) {
      return new Response(JSON.stringify({ accountId: "me-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ values: [1, 2], total: 2, ok: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const config = loadConfig({
    ATLASSIAN_EMAIL: "a@b.c",
    ATLASSIAN_API_TOKEN: "t",
    ATLASSIAN_SITE: "x.atlassian.net",
    DEV_MCP_PARITY_WRITES: "1",
    ...(legacy ? {} : { DEV_MCP_LEGACY_TOOL_NAMES: "0" }),
  } as NodeJS.ProcessEnv);
  const server = createServer(config, { fetch: fetchMock });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    calls.length = 0;
    const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
    expect(res.isError, res.content[0]?.text).toBeUndefined();
    return calls.map((c) => ({ ...c, path: c.url.pathname, q: Object.fromEntries(c.url.searchParams) }));
  };
  return { client, call };
}

const API = "/rest/api/3";
const AGILE = "/rest/agile/1.0";

describe("Jira canonical tools (REST mapping, cloudId accepted)", () => {
  const cases: Array<[string, Record<string, unknown>, string, string, Record<string, string>?, unknown?]> = [
    ["jira_search_issues_using_jql", { jql: "a=b", maxResults: 5, cloudId: "x.atlassian.net" }, "POST", `${API}/search/jql`, undefined, { jql: "a=b", maxResults: 5 }],
    ["jira_list_projects", { query: "x", maxResults: 3, cloudId: "x.atlassian.net" }, "GET", `${API}/project/search`, { query: "x", maxResults: "3" }],
    ["jira_list_project_issue_types_metadata", { projectIdOrKey: "P", cloudId: "x.atlassian.net" }, "GET", `${API}/issue/createmeta/P/issuetypes`],
    ["jira_get_issue_type_meta_with_fields", { projectIdOrKey: "P", issueTypeId: "10", cloudId: "x.atlassian.net" }, "GET", `${API}/issue/createmeta/P/issuetypes/10`],
    ["jira_list_issue_transitions", { issueIdOrKey: "A-1", cloudId: "x.atlassian.net" }, "GET", `${API}/issue/A-1/transitions`],
    ["jira_list_issue_link_types", { cloudId: "x.atlassian.net" }, "GET", `${API}/issueLinkType`],
    ["jira_list_issue_remote_issue_links", { issueIdOrKey: "A-1", cloudId: "x.atlassian.net" }, "GET", `${API}/issue/A-1/remotelink`],
    ["jira_add_or_edit_issue_comment", { issueIdOrKey: "A-1", body: "hi", cloudId: "x.atlassian.net" }, "POST", `${API}/issue/A-1/comment`, undefined, { body: { type: "doc", version: 1, content: expect.anything() } }],
    ["jira_add_or_edit_issue_comment", { issueIdOrKey: "A-1", body: "hi", commentId: "9" }, "PUT", `${API}/issue/A-1/comment/9`, undefined, { body: { type: "doc", version: 1, content: expect.anything() } }],
    ["jira_add_or_edit_issue_worklog", { issueIdOrKey: "A-1", timeSpent: "1h", cloudId: "x.atlassian.net" }, "POST", `${API}/issue/A-1/worklog`, undefined, { timeSpent: "1h" }],
    ["jira_add_or_edit_issue_worklog", { issueIdOrKey: "A-1", timeSpent: "2h", worklogId: "5" }, "PUT", `${API}/issue/A-1/worklog/5`, undefined, { timeSpent: "2h" }],
    ["jira_create_issue_remote_issue_link", { issueIdOrKey: "A-1", url: "https://u", title: "T", cloudId: "x.atlassian.net" }, "POST", `${API}/issue/A-1/remotelink`, undefined, { object: { url: "https://u", title: "T" } }],
    ["jira_list_issue_comments", { issueIdOrKey: "A-1", startAt: 2, maxResults: 10, orderBy: "-created", cloudId: "x.atlassian.net" }, "GET", `${API}/issue/A-1/comment`, { startAt: "2", maxResults: "10", orderBy: "-created" }],
    ["jira_list_issue_changelogs", { issueIdOrKey: "A-1", maxResults: 10, cloudId: "x.atlassian.net" }, "GET", `${API}/issue/A-1/changelog`, { maxResults: "10" }],
    ["jira_list_issue_worklogs", { issueIdOrKey: "A-1", cloudId: "x.atlassian.net" }, "GET", `${API}/issue/A-1/worklog`],
    ["jira_list_issue_assignable_users", { issueIdOrKey: "A-1", query: "bo", cloudId: "x.atlassian.net" }, "GET", `${API}/user/assignable/search`, { issueKey: "A-1", query: "bo" }],
    ["jira_get_current_user", { cloudId: "x.atlassian.net" }, "GET", `${API}/myself`],
    ["jira_get_user", { accountId: "u1", cloudId: "x.atlassian.net" }, "GET", `${API}/user`, { accountId: "u1" }],
    ["jira_list_statuses", { cloudId: "x.atlassian.net" }, "GET", `${API}/status`],
    ["jira_list_project_components", { projectIdOrKey: "P", cloudId: "x.atlassian.net" }, "GET", `${API}/project/P/components`],
    ["jira_get_project_versions", { projectIdOrKey: "P", cloudId: "x.atlassian.net" }, "GET", `${API}/project/P/versions`],
    ["jira_list_boards", { projectKeyOrId: "P", type: "scrum", cloudId: "x.atlassian.net" }, "GET", `${AGILE}/board`, { projectKeyOrId: "P", type: "scrum" }],
    ["jira_get_board_config", { boardId: 3, cloudId: "x.atlassian.net" }, "GET", `${AGILE}/board/3/configuration`],
    ["jira_get_board_issue_data", { boardId: 3, jql: "x", cloudId: "x.atlassian.net" }, "GET", `${AGILE}/board/3/issue`, { jql: "x" }],
    ["jira_list_board_sprints", { boardId: 3, state: "active", cloudId: "x.atlassian.net" }, "GET", `${AGILE}/board/3/sprint`, { state: "active" }],
    ["jira_get_board_sprint_data", { boardId: 3, sprintId: 8, cloudId: "x.atlassian.net" }, "GET", `${AGILE}/board/3/sprint/8/issue`],
    ["jira_get_board_sprint_data", { sprintId: 8 }, "GET", `${AGILE}/sprint/8/issue`],
    ["jira_list_filters", { filterName: "mine", cloudId: "x.atlassian.net" }, "GET", `${API}/filter/search`, { filterName: "mine" }],
    ["jira_list_dashboards", { filter: "my", cloudId: "x.atlassian.net" }, "GET", `${API}/dashboard`, { filter: "my" }],
    ["jira_download_issue_attachment", { attachmentId: "77", cloudId: "x.atlassian.net" }, "GET", `${API}/attachment/77`],
    ["jira_watch_issue", { issueIdOrKey: "A-1", cloudId: "x.atlassian.net" }, "POST", `${API}/issue/A-1/watchers`],
    ["jira_create_issue_link", { type: "Blocks", inwardIssue: "A-2", outwardIssue: "A-1", cloudId: "x.atlassian.net" }, "POST", `${API}/issueLink`],
  ];

  it.each(cases)("%s %j", async (name, args, method, path, query, body) => {
    const { call } = await setup();
    const [req] = await call(name, args);
    expect(req!.method).toBe(method);
    expect(req!.path).toBe(path);
    if (query) expect(req!.q).toMatchObject(query);
    if (body) expect(req!.body).toMatchObject(body as object);
  });

  it("jira_watch_issue with watch=false deletes using the current user", async () => {
    const { call } = await setup();
    const reqs = await call("jira_watch_issue", { issueIdOrKey: "A-1", watch: false });
    expect(reqs.map((r) => `${r.method} ${r.path}`)).toEqual([`GET ${API}/myself`, `DELETE ${API}/issue/A-1/watchers`]);
    expect(reqs[1]!.q).toEqual({ accountId: "me-1" });
  });

  it("jira_create_issue accepts issueType + assignee (and the legacy assigneeAccountId)", async () => {
    const { call } = await setup();
    const [a] = await call("jira_create_issue", { projectKey: "P", summary: "s", issueType: "Bug", assignee: "u1" });
    expect(a!.body).toMatchObject({ fields: { issuetype: { name: "Bug" }, assignee: { accountId: "u1" } } });
    const [b] = await call("jira_create_issue", { projectKey: "P", summary: "s", issueType: "10001", assigneeAccountId: "u2" });
    expect(b!.body).toMatchObject({ fields: { issuetype: { id: "10001" }, assignee: { accountId: "u2" } } });
  });

  it("jira_transition_issue can move to a sprint or to the backlog", async () => {
    const { call } = await setup();
    const sprint = await call("jira_transition_issue", { issueIdOrKey: "A-1", transitionId: "31", sprintId: 12 });
    expect(sprint.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${API}/issue/A-1/transitions`, `POST ${AGILE}/sprint/12/issue`]);
    expect(sprint[1]!.body).toEqual({ issues: ["A-1"] });
    const back = await call("jira_transition_issue", { issueIdOrKey: "A-1", transitionId: "31", moveToBacklog: true });
    expect(back[1]).toMatchObject({ method: "POST", path: `${AGILE}/backlog/issue`, body: { issues: ["A-1"] } });
    const plain = await call("jira_transition_issue", { issueIdOrKey: "A-1", transitionId: "31" });
    expect(plain).toHaveLength(1);
  });

  it("write tool descriptions say WRITES", async () => {
    const { client } = await setup();
    const tools = (await client.listTools()).tools;
    for (const n of ["jira_create_issue", "jira_edit_issue", "jira_transition_issue", "jira_add_or_edit_issue_comment", "jira_add_or_edit_issue_worklog", "jira_create_issue_remote_issue_link", "jira_create_issue_link", "jira_watch_issue"]) {
      expect(tools.find((t) => t.name === n)!.description).toMatch(/^WRITES:/);
    }
  });
});

describe("Jira legacy aliases", () => {
  const cases: Array<[string, Record<string, unknown>, string, string, unknown?]> = [
    ["jira_search_jql", { jql: "a=b" }, "POST", `${API}/search/jql`, { jql: "a=b" }],
    ["jira_get_projects", { query: "x" }, "GET", `${API}/project/search`],
    ["jira_get_issue_types_metadata", { projectIdOrKey: "P" }, "GET", `${API}/issue/createmeta/P/issuetypes`],
    ["jira_get_issue_types_metadata", { projectIdOrKey: "P", issueTypeId: "10" }, "GET", `${API}/issue/createmeta/P/issuetypes/10`],
    ["jira_get_transitions", { issueIdOrKey: "A-1" }, "GET", `${API}/issue/A-1/transitions`],
    ["jira_get_issue_link_types", {}, "GET", `${API}/issueLinkType`],
    ["jira_get_remote_issue_links", { issueIdOrKey: "A-1" }, "GET", `${API}/issue/A-1/remotelink`],
    ["jira_add_comment", { issueIdOrKey: "A-1", body: "hi" }, "POST", `${API}/issue/A-1/comment`],
    ["jira_add_worklog", { issueIdOrKey: "A-1", timeSpent: "1h" }, "POST", `${API}/issue/A-1/worklog`, { timeSpent: "1h" }],
    ["jira_create_remote_issue_link", { issueIdOrKey: "A-1", url: "https://u", title: "T" }, "POST", `${API}/issue/A-1/remotelink`],
  ];

  it.each(cases)("%s %j", async (name, args, method, path, body) => {
    const { call } = await setup();
    const [req] = await call(name, args);
    expect(req!.method).toBe(method);
    expect(req!.path).toBe(path);
    if (body) expect(req!.body).toMatchObject(body as object);
  });

  const names = cases.map((c) => c[0]);
  it("are hidden with DEV_MCP_LEGACY_TOOL_NAMES=0, canonical tools stay", async () => {
    const on = (await (await setup(true)).client.listTools()).tools.map((t) => t.name);
    const off = (await (await setup(false)).client.listTools()).tools.map((t) => t.name);
    for (const n of names) {
      expect(on).toContain(n);
      expect(off).not.toContain(n);
    }
    expect(off).toContain("jira_search_issues_using_jql");
    expect(off).toContain("jira_normalize_issue");
    expect(off).toContain("jira_get_comments");
  });
});

describe("jira_download_issue_attachment with save_to", () => {
  type Hop = { url: string; auth: string | null; redirect: string | undefined };
  let hops: Hop[];
  let meta: Record<string, unknown>;
  let tmp: string;
  let prevRoots: string | undefined;

  const fetchMock: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    hops.push({ url: url.toString(), auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
    if (url.pathname === "/rest/api/3/attachment/77") {
      return new Response(JSON.stringify(meta), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/rest/api/3/attachment/content/77") {
      return new Response(null, { status: 302, headers: { location: "https://media.example.net/file/77?token=abc" } });
    }
    if (url.hostname === "media.example.net") {
      return new Response(Buffer.from("hello bytes"), { status: 200, headers: { "content-type": "text/plain" } });
    }
    return new Response("nope", { status: 404 });
  };

  async function run(args: Record<string, unknown>) {
    const config = loadConfig({ ATLASSIAN_EMAIL: "a@b.c", ATLASSIAN_API_TOKEN: "t", ATLASSIAN_SITE: "x.atlassian.net" } as NodeJS.ProcessEnv);
    const server = createServer(config, { fetch: fetchMock });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = (await client.callTool({ name: "jira_download_issue_attachment", arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
    return { res, text: res.content[0]?.text ?? "" };
  }

  beforeEach(async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const p = await import("node:path");
    tmp = await fs.realpath(await fs.mkdtemp(p.join(os.tmpdir(), "devmcp-jira-")));
    prevRoots = process.env.DEV_MCP_SAVE_ROOTS;
    process.env.DEV_MCP_SAVE_ROOTS = tmp;
    hops = [];
    meta = { id: "77", filename: "notes.txt", mimeType: "text/plain", size: 11, content: "https://x.atlassian.net/rest/api/3/attachment/content/77" };
  });
  afterEach(async () => {
    const fs = await import("node:fs/promises");
    if (prevRoots === undefined) delete process.env.DEV_MCP_SAVE_ROOTS;
    else process.env.DEV_MCP_SAVE_ROOTS = prevRoots;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("downloads into a directory, sanitising the server file name, and does not forward auth cross-origin", async () => {
    const fs = await import("node:fs/promises");
    const p = await import("node:path");
    meta.filename = "..\\evil.txt";
    const { res, text } = await run({ attachmentId: "77", save_to: tmp + p.sep });
    expect(res.isError, text).toBeUndefined();
    const out = JSON.parse(text);
    expect(out).toMatchObject({ kind: "file", bytes: 11, saved_to: p.join(tmp, "evil.txt") });
    expect(out.sha256).toHaveLength(64);
    expect(await fs.readFile(p.join(tmp, "evil.txt"), "utf8")).toBe("hello bytes");
    const site = hops.filter((h) => h.url.startsWith("https://x.atlassian.net/rest/api/3/attachment/content"));
    const media = hops.filter((h) => h.url.startsWith("https://media.example.net"));
    expect(site[0]!.auth).toMatch(/^Basic /);
    expect(site[0]!.redirect).toBe("manual");
    expect(media).toHaveLength(1);
    expect(media[0]!.auth).toBeNull();
  });

  it("refuses a bad target before any network call and an existing file unless overwrite", async () => {
    const fs = await import("node:fs/promises");
    const p = await import("node:path");
    let r = await run({ attachmentId: "77", save_to: p.join(tmp, "a.exe") });
    expect(r.res.isError).toBe(true);
    expect(hops).toHaveLength(0);
    r = await run({ attachmentId: "77", save_to: "relative.txt" });
    expect(r.res.isError).toBe(true);
    expect(hops).toHaveLength(0);
    await fs.writeFile(p.join(tmp, "notes.txt"), "old");
    r = await run({ attachmentId: "77", save_to: tmp + p.sep });
    expect(r.res.isError).toBe(true);
    expect(r.text).toMatch(/already exists/);
    expect(hops.some((h) => h.url.includes("/content/"))).toBe(false);
    r = await run({ attachmentId: "77", save_to: tmp + p.sep, overwrite: true });
    expect(r.res.isError, r.text).toBeUndefined();
    expect(await fs.readFile(p.join(tmp, "notes.txt"), "utf8")).toBe("hello bytes");
  });

  it("rejects dot-file names from the server and keeps metadata-only behaviour without save_to", async () => {
    const p = await import("node:path");
    meta.filename = ".env";
    const r = await run({ attachmentId: "77", save_to: tmp + p.sep });
    expect(r.res.isError).toBe(true);
    expect(hops.some((h) => h.url.includes("/content/"))).toBe(false);
    const plain = await run({ attachmentId: "77" });
    expect(JSON.parse(plain.text)).toMatchObject({ id: "77", content: expect.stringContaining("/attachment/content/77") });
  });

  it("enforces DEV_MCP_SAVE_MAX_MB while downloading", async () => {
    const prev = process.env.DEV_MCP_SAVE_MAX_MB;
    process.env.DEV_MCP_SAVE_MAX_MB = "0.00001"; // about 10 bytes
    try {
      const p = await import("node:path");
      const r = await run({ attachmentId: "77", save_to: tmp + p.sep });
      expect(r.res.isError).toBe(true);
      expect(r.text).toMatch(/limit/);
    } finally {
      if (prev === undefined) delete process.env.DEV_MCP_SAVE_MAX_MB;
      else process.env.DEV_MCP_SAVE_MAX_MB = prev;
    }
  });
});

import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { HttpClient, downloadBytes } from "../src/http.js";
import { resolveSavePath, sanitizeFileName } from "../src/save.js";
import { createServer } from "../src/server.js";
import { resetTenantIdCache } from "../src/tools/cloud-id.js";

const ENV = {
  GITLAB_TOKEN: "t",
  FIGMA_ACCESS_TOKEN: "f",
  ATLASSIAN_EMAIL: "a@b.c",
  ATLASSIAN_API_TOKEN: "tok",
  ATLASSIAN_SITE: "site.atlassian.net",
};

type Res = { isError?: boolean; content: Array<{ type: string; text?: string }> };
type Seen = { method: string; url: URL; body: any };

async function connect(env: Record<string, string>, fetchImpl: typeof fetch) {
  const server = createServer(loadConfig({ ...ENV, ...env } as NodeJS.ProcessEnv), { fetch: fetchImpl });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------- 1. write-tool gate

const GATED = [
  "gitlab_save_note",
  "gitlab_save_work_item",
  "gitlab_link_work_items",
  "gitlab_save_merge_request_review",
  "gitlab_apply_suggestion",
  "gitlab_save_pipeline",
  "gitlab_save_pipeline_job",
  "jira_add_or_edit_issue_comment",
  "jira_add_or_edit_issue_worklog",
  "jira_create_issue_remote_issue_link",
  "jira_watch_issue",
  "confluence_create_content",
  "confluence_update_content",
  "confluence_create_comment",
  "confluence_update_comment",
  "confluence_update_comment_resolution",
  "confluence_complete_task",
  "confluence_reopen_task",
  "confluence_add_labels_to_content",
];
const ALWAYS = [
  "gitlab_save_merge_request",
  "gitlab_accept_merge_request",
  "gitlab_add_commit",
  "gitlab_add_branch",
  "gitlab_create_issue",
  "gitlab_create_merge_request_note",
  "jira_create_issue",
  "jira_edit_issue",
  "jira_transition_issue",
  "jira_create_issue_link",
  "jira_add_comment",
  "jira_add_worklog",
  "jira_create_remote_issue_link",
  "confluence_create_page",
  "confluence_update_page",
  "confluence_create_footer_comment",
  "confluence_create_inline_comment",
];

describe("DEV_MCP_PARITY_WRITES gate", () => {
  const names = async (env: Record<string, string>) => {
    const client = await connect(env, async () => json({}));
    return new Set((await client.listTools()).tools.map((t) => t.name));
  };

  it("defaults to off", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).parityWrites).toBe(false);
    expect(loadConfig({ DEV_MCP_PARITY_WRITES: "1" } as NodeJS.ProcessEnv).parityWrites).toBe(true);
  });

  it("off: the 19 new write tools are absent, pre-existing writes stay", async () => {
    const tools = await names({});
    for (const n of GATED) expect(tools.has(n), n).toBe(false);
    for (const n of ALWAYS) expect(tools.has(n), n).toBe(true);
    expect(tools.has("gitlab_get_issue")).toBe(true);
  });

  it("on: the 19 new write tools are listed", async () => {
    const tools = await names({ DEV_MCP_PARITY_WRITES: "1" });
    for (const n of [...GATED, ...ALWAYS]) expect(tools.has(n), n).toBe(true);
  });
});

// ---------------------------------------------------------------- 2/10. download

describe("downloadBytes", () => {
  const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

  it("caps a streamed body that has no content-length", async () => {
    const chunk = new Uint8Array(400);
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(chunk);
      },
    });
    const f: typeof fetch = async () => new Response(stream, { status: 200 });
    await expect(downloadBytes(f, "https://a.test/x", { maxBytes: 1000 })).rejects.toThrow(/exceeds the 1000-byte limit/);
  });

  it("cancels the body when content-length is over the cap", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    });
    const f: typeof fetch = async () => new Response(stream, { status: 200, headers: { "content-length": "5000" } });
    await expect(downloadBytes(f, "https://a.test/x", { maxBytes: 100 })).rejects.toThrow(/limit/);
    expect(cancelled).toBe(true);
  });

  it("fails after more than 5 redirects", async () => {
    let n = 0;
    const f: typeof fetch = async () => redirect(`https://a.test/${++n}`);
    await expect(downloadBytes(f, "https://a.test/0", { maxBytes: 100 })).rejects.toThrow(/Too many redirects/);
    expect(n).toBe(6);
  });

  it("fails on a redirect loop", async () => {
    const f: typeof fetch = async (u) => redirect(String(u).endsWith("/a") ? "https://a.test/b" : "https://a.test/a");
    await expect(downloadBytes(f, "https://a.test/a", { maxBytes: 100 })).rejects.toThrow(/Too many redirects/);
  });

  it("drops auth on an https to http downgrade of the same host", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const f: typeof fetch = async (u, init) => {
      seen.push({ url: String(u), headers: new Headers(init?.headers) });
      return seen.length === 1 ? redirect("http://a.test/y") : new Response("ok", { status: 200 });
    };
    await downloadBytes(f, "https://a.test/x", {
      maxBytes: 100,
      authOrigin: "https://a.test",
      headers: { Authorization: "Basic zzz", Accept: "*/*" },
    });
    expect(seen[0]!.headers.get("authorization")).toBe("Basic zzz");
    expect(seen[1]!.url).toBe("http://a.test/y");
    expect(seen[1]!.headers.get("authorization")).toBeNull();
    expect(seen[1]!.headers.get("accept")).toBe("*/*");
  });

  it("forwards only Accept and User-Agent off the auth origin", async () => {
    const seen: Headers[] = [];
    const f: typeof fetch = async (_u, init) => {
      seen.push(new Headers(init?.headers));
      return seen.length === 1 ? redirect("https://cdn.test/y") : new Response("ok", { status: 200 });
    };
    await downloadBytes(f, "https://a.test/x", {
      maxBytes: 100,
      authOrigin: "https://a.test",
      headers: {
        Authorization: "Basic zzz",
        "PRIVATE-TOKEN": "glpat",
        "X-Figma-Token": "fig",
        Cookie: "c=1",
        Accept: "image/png",
        "User-Agent": "dev.mcp",
      },
    });
    expect([...seen[0]!.keys()].sort()).toEqual(["accept", "authorization", "cookie", "private-token", "user-agent", "x-figma-token"]);
    expect([...seen[1]!.keys()].sort()).toEqual(["accept", "user-agent"]);
  });
});

// ---------------------------------------------------------------- 5. retries

describe("HttpClient retries", () => {
  const make = (statuses: Array<number | "net">, method: string) => {
    let calls = 0;
    const f: typeof fetch = async () => {
      const s = statuses[Math.min(calls++, statuses.length - 1)]!;
      if (s === "net") throw new TypeError("fetch failed");
      return s === 200 ? json({ ok: true }) : new Response("x", { status: s });
    };
    const http = new HttpClient({ fetch: f, maxRetries: 3, sleep: async () => undefined });
    return { run: () => http.json("https://a.test/x", { method }), count: () => calls };
  };

  it("does not retry a POST/PUT/PATCH/DELETE on 503 or a network error", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const a = make([503, 200], method);
      await expect(a.run()).rejects.toMatchObject({ status: 503 });
      expect(a.count(), method).toBe(1);
      const b = make(["net", 200], method);
      await expect(b.run()).rejects.toThrow(/fetch failed/);
      expect(b.count(), method).toBe(1);
    }
  });

  it("retries a write on 429", async () => {
    const a = make([429, 200], "POST");
    await expect(a.run()).resolves.toEqual({ ok: true });
    expect(a.count()).toBe(2);
  });

  it("keeps retrying GET on 503 and network errors", async () => {
    const a = make([503, 200], "GET");
    await expect(a.run()).resolves.toEqual({ ok: true });
    const b = make(["net", 200], "GET");
    await expect(b.run()).resolves.toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------- 3. save path

describe("resolveSavePath: '~' and dot segments", () => {
  let base: string;
  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), "devmcp-fix-")));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("rejects '~' below the root but accepts a root that contains '~'", async () => {
    const root = path.join(base, "RUNNER~1", "Temp");
    await mkdir(root, { recursive: true });
    const env = { DEV_MCP_SAVE_ROOTS: root };
    await expect(resolveSavePath(path.join(root, "a.json"), { env })).resolves.toBe(path.join(root, "a.json"));
    await expect(resolveSavePath(path.join(root, "sub", "b.json"), { env })).resolves.toBeTruthy();
    await expect(resolveSavePath(path.join(root, "PROGRA~1", "a.json"), { env })).rejects.toThrow(/~/);
    await expect(resolveSavePath(path.join(root, "a~1.json"), { env })).rejects.toThrow(/~/);
  });

  it("refuses a dot-segment reached through a link (realpath), unless allowed", async () => {
    const root = path.join(base, "root");
    await mkdir(path.join(root, ".git"), { recursive: true });
    try {
      await symlink(path.join(root, ".git"), path.join(root, "lnk"), "junction");
    } catch {
      return; // links unavailable here
    }
    const target = path.join(root, "lnk", "a.json");
    await expect(resolveSavePath(target, { env: { DEV_MCP_SAVE_ROOTS: root } })).rejects.toThrow(/dot-prefixed segment ".git"/);
    await expect(resolveSavePath(target, { env: { DEV_MCP_SAVE_ROOTS: root, DEV_MCP_SAVE_ALLOW_DOT: ".git" } })).resolves.toBe(target);
  });
});

describe("sanitizeFileName reserved names", () => {
  it.each(["COM¹", "COM².txt", "com³", "LPT¹.log", "LPT²", "lpt³.x", "con .txt", "nul  .txt", "aux.", "COM1 .md"])(
    "rejects %s",
    (name) => {
      expect(() => sanitizeFileName(name)).toThrow(/Reserved|Unusable/);
    },
  );
  it("keeps normal names and replaces '~'", () => {
    expect(sanitizeFileName("report.pdf")).toBe("report.pdf");
    expect(sanitizeFileName("PROGRA~1.txt")).toBe("PROGRA_1.txt");
    expect(sanitizeFileName("console.txt")).toBe("console.txt");
  });
});

// ---------------------------------------------------------------- 4. submit_review

describe("gitlab submit_review", () => {
  const MR = "/api/v4/projects/g%2Fp/merge_requests/7";
  const setup = (failOn: (s: Seen, n: number) => boolean) => {
    const seen: Seen[] = [];
    let drafts = 0;
    const f: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const s: Seen = { method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      seen.push(s);
      if (s.method === "GET") return json({ diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" } });
      if (failOn(s, drafts)) return json({ message: "boom" }, 400);
      if (s.method === "POST" && url.pathname.endsWith("/draft_notes")) return json({ id: 100 + drafts++ });
      return json({ ok: true });
    };
    return { seen, f };
  };
  const args = (comments: unknown[], extra: Record<string, unknown> = {}) => ({
    project_id: "g/p",
    merge_request_iid: 7,
    method: "submit_review",
    comments,
    ...extra,
  });
  const good = (n: string) => ({ file: "a.ts", body: `c${n}`, new_line: 1 });
  const run = async (f: typeof fetch, a: Record<string, unknown>) => {
    const client = await connect({ DEV_MCP_PARITY_WRITES: "1" }, f);
    return (await client.callTool({ name: "gitlab_save_merge_request_review", arguments: a })) as Res;
  };

  it("validates every comment before the first POST", async () => {
    const { seen, f } = setup(() => false);
    const res = await run(f, args([good("1"), good("2"), { file: "a.ts", body: "/close", new_line: 2 }]));
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/cannot start with \//);
    expect(seen.filter((s) => s.method !== "GET")).toEqual([]);
    const noLine = await run(f, args([good("1"), { file: "a.ts", body: "x" }]));
    expect(noLine.isError).toBe(true);
    expect(seen.filter((s) => s.method !== "GET")).toEqual([]);
  });

  it("deletes the drafts it created when a draft POST fails", async () => {
    const { seen, f } = setup((s, n) => s.method === "POST" && n === 2);
    const res = await run(f, args([good("1"), good("2"), good("3")]));
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/deleted: \[100, 101\]/);
    const deletes = seen.filter((s) => s.method === "DELETE").map((s) => s.url.pathname);
    expect(deletes).toEqual([`${MR}/draft_notes/100`, `${MR}/draft_notes/101`]);
    expect(seen.some((s) => s.url.pathname.endsWith("bulk_publish"))).toBe(false);
  });

  it("deletes the drafts when bulk_publish fails and reports undeletable ones", async () => {
    const { seen, f } = setup((s) => s.url.pathname.endsWith("bulk_publish") || (s.method === "DELETE" && s.url.pathname.endsWith("/101")));
    const res = await run(f, args([good("1"), good("2")]));
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/deleted: \[100\]/);
    expect(res.content[0]!.text).toMatch(/could NOT be deleted.*\[101\]/);
    expect(seen.filter((s) => s.method === "DELETE")).toHaveLength(2);
  });

  it("publishes on the happy path", async () => {
    const { seen, f } = setup(() => false);
    const res = await run(f, args([good("1")], { summary: "ok" }));
    expect(res.isError).toBeUndefined();
    expect(seen.filter((s) => s.method === "POST").map((s) => s.url.pathname.split("/").pop())).toEqual(["draft_notes", "draft_notes", "bulk_publish"]);
  });
});

// ---------------------------------------------------------------- 6/7. confluence

describe("confluence update fixes", () => {
  const token = (id: string, v: number, t: string) => Buffer.from(JSON.stringify({ id, v, t })).toString("base64url");
  const run = async (state: { comment?: any; page?: any }, name: string, args: Record<string, unknown>) => {
    const seen: Seen[] = [];
    const f: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      seen.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET" && url.pathname.includes("inline-comments")) return json(state.comment ?? {});
      if (method === "GET") return json(state.page ?? {});
      return json({ ok: true });
    };
    const client = await connect({ DEV_MCP_PARITY_WRITES: "1" }, f);
    const res = (await client.callTool({ name, arguments: args })) as Res;
    return { res, seen };
  };

  it("update_comment_resolution errors instead of sending an empty body", async () => {
    const { res, seen } = await run({ comment: { id: "9", version: { number: 2 } } }, "confluence_update_comment_resolution", {
      commentId: "9",
      resolved: true,
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/storage body was not returned/);
    expect(seen.some((s) => s.method === "PUT")).toBe(false);
  });

  it("update_comment_resolution keeps the existing body", async () => {
    const { res, seen } = await run(
      { comment: { id: "9", version: { number: 2 }, body: { storage: { value: "<p>hi</p>" } } } },
      "confluence_update_comment_resolution",
      { commentId: "9", resolved: true },
    );
    expect(res.isError).toBeUndefined();
    expect(seen.find((s) => s.method === "PUT")!.body).toMatchObject({ body: { value: "<p>hi</p>" }, resolved: true, version: { number: 3 } });
  });

  it("update_content keeps a draft status when status is not passed", async () => {
    const page = { id: "5", title: "T", status: "draft", version: { number: 4 } };
    const { res, seen } = await run({ page }, "confluence_update_content", {
      contentId: "5",
      contentType: "page",
      snapshotToken: token("5", 4, "page"),
      body: { format: "storage", value: "<p>x</p>" },
    });
    expect(res.isError, res.content[0]?.text).toBeUndefined();
    expect(seen.find((s) => s.method === "PUT")!.body.status).toBe("draft");
  });

  it("update_content lets an explicit status win", async () => {
    const page = { id: "5", title: "T", status: "draft", version: { number: 4 } };
    const { seen } = await run({ page }, "confluence_update_content", {
      contentId: "5",
      contentType: "page",
      snapshotToken: token("5", 4, "page"),
      body: { format: "storage", value: "<p>x</p>" },
      status: "current",
    });
    expect(seen.find((s) => s.method === "PUT")!.body.status).toBe("current");
  });

  it("legacy update_page keeps the current status when status is omitted", async () => {
    const { res, seen } = await run({ page: { id: "5", status: "draft" } }, "confluence_update_page", {
      pageId: "5",
      title: "T",
      versionNumber: 5,
      bodyValue: "<p>x</p>",
    });
    expect(res.isError, res.content[0]?.text).toBeUndefined();
    expect(seen.find((s) => s.method === "PUT")!.body.status).toBe("draft");
  });
});

// ---------------------------------------------------------------- 8. cloudId

describe("cloudId validation", () => {
  const UUID = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";
  const OTHER = "ffffffff-4f50-6172-8394-a5b6c7d8e9f0";
  beforeEach(() => resetTenantIdCache());

  const setup = (tenant: "ok" | "fail") => {
    const seen: Seen[] = [];
    const f: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      seen.push({ method, url, body: undefined });
      if (url.pathname === "/_edge/tenant_info") return tenant === "ok" ? json({ cloudId: UUID }) : json({}, 500);
      return json({ id: "1", key: "A-1" });
    };
    return { seen, f };
  };
  const call = async (f: typeof fetch, name: string, args: Record<string, unknown>) => {
    const client = await connect({ DEV_MCP_PARITY_WRITES: "1" }, f);
    return (await client.callTool({ name, arguments: args })) as Res;
  };
  const read = { issueIdOrKey: "A-1" };
  const write = { issueIdOrKey: "A-1", body: "hi" };
  const api = (seen: Seen[]) => seen.filter((s) => s.url.pathname !== "/_edge/tenant_info");

  it("absent cloudId is unchanged and makes no tenant call", async () => {
    const { seen, f } = setup("ok");
    const res = await call(f, "jira_get_issue", read);
    expect(res.isError).toBeUndefined();
    expect(seen.map((s) => s.url.pathname)).toEqual(["/rest/api/3/issue/A-1"]);
  });

  it("accepts the configured hostname (case-insensitive) and rejects another one", async () => {
    const { seen, f } = setup("ok");
    expect((await call(f, "jira_get_issue", { ...read, cloudId: "SITE.atlassian.net" })).isError).toBeUndefined();
    const bad = await call(f, "jira_get_issue", { ...read, cloudId: "other.atlassian.net" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/cloudId mismatch/);
    expect(api(seen)).toHaveLength(1);
    const junk = await call(f, "jira_get_issue", { ...read, cloudId: "c" });
    expect(junk.isError).toBe(true);
  });

  it("compares a UUID with the tenant id (cached) on Jira and Confluence", async () => {
    const { seen, f } = setup("ok");
    expect((await call(f, "jira_add_or_edit_issue_comment", { ...write, cloudId: UUID })).isError).toBeUndefined();
    const bad = await call(f, "jira_add_or_edit_issue_comment", { ...write, cloudId: OTHER });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/cloudId mismatch/);
    const conf = await call(f, "confluence_list_spaces", { cloudId: OTHER });
    expect(conf.isError).toBe(true);
    expect(seen.filter((s) => s.url.pathname === "/_edge/tenant_info")).toHaveLength(1);
    expect(api(seen).filter((s) => s.method === "POST")).toHaveLength(1);
  });

  it("tenant lookup failure: writes rejected, reads allowed with a warning", async () => {
    const { seen, f } = setup("fail");
    const w = await call(f, "jira_add_or_edit_issue_comment", { ...write, cloudId: UUID });
    expect(w.isError).toBe(true);
    expect(w.content[0]!.text).toMatch(/mismatch-unknown/);
    expect(api(seen)).toEqual([]);
    const r = await call(f, "jira_get_issue", { ...read, cloudId: UUID });
    expect(r.isError).toBeUndefined();
    expect(r.content.map((c) => c.text).join("\n")).toMatch(/warning: cloudId .* could not be verified/);
  });
});

// ---------------------------------------------------------------- 10. save_to on legacy aliases

describe("save_to round trip on legacy aliases", () => {
  let dir: string;
  const saved = process.env.DEV_MCP_SAVE_ROOTS;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "devmcp-legacy-")));
    process.env.DEV_MCP_SAVE_ROOTS = dir;
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.DEV_MCP_SAVE_ROOTS;
    else process.env.DEV_MCP_SAVE_ROOTS = saved;
    await rm(dir, { recursive: true, force: true });
  });

  const f: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/jobs")) return json([{ id: 1, name: "build", status: "success" }]);
    if (url.pathname.includes("/search/jql")) return json({ issues: [{ key: "A-1", fields: { summary: "s" } }], isLast: true });
    if (url.pathname.includes("/pages/")) return json({ id: "5", title: "T", status: "current", version: { number: 1 }, body: { storage: { value: "<p>x</p>" } } });
    return json({ id: 1, iid: 3, title: "t", state: "opened" });
  };

  const cases: Array<[string, Record<string, unknown>]> = [
    ["gitlab_get_issue", { projectId: "g/p", issueIid: 3 }],
    ["gitlab_get_pipeline_jobs", { projectId: "g/p", pipelineId: 9 }],
    ["jira_search_jql", { jql: "project = A" }],
    ["confluence_get_page", { pageId: "5" }],
  ];
  it.each(cases)("%s writes the payload and returns a compact summary", async (name, args) => {
    const file = path.join(dir, `${name}.json`);
    const client = await connect({}, f);
    const res = (await client.callTool({ name, arguments: { ...args, save_to: file } })) as Res;
    expect(res.isError, res.content[0]?.text).toBeUndefined();
    const out = JSON.parse(res.content[0]!.text!);
    expect(out).toMatchObject({ saved_to: file, kind: "json" });
    expect(out.sha256).toHaveLength(64);
    expect(JSON.parse(await readFile(file, "utf8"))).toBeTruthy();
  });
});

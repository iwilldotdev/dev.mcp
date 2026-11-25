import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

type Call = { method: string; url: URL; body: any };
let calls: Call[];
let responses: Array<[RegExp, unknown]>;

const fetchMock: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, url, body });
  const key = `${method} ${url.pathname}`;
  const hit = responses.find(([re]) => re.test(key));
  return new Response(JSON.stringify(hit ? hit[1] : {}), { status: 200, headers: { "content-type": "application/json" } });
};

const ENV = {
  ATLASSIAN_EMAIL: "a@b.c",
  ATLASSIAN_API_TOKEN: "tok",
  ATLASSIAN_SITE: "site.atlassian.net",
  DEV_MCP_PARITY_WRITES: "1",
} as NodeJS.ProcessEnv;

async function connect(extra: Record<string, string> = {}) {
  const server = createServer(loadConfig({ ...ENV, ...extra } as NodeJS.ProcessEnv), { fetch: fetchMock });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type Res = { isError?: boolean; content: Array<{ type: string; text?: string }> };
async function call(name: string, args: Record<string, unknown>, extra?: Record<string, string>) {
  const client = await connect(extra);
  const res = (await client.callTool({ name, arguments: args })) as Res;
  return { res, text: res.content[0]?.text ?? "" };
}
const last = () => calls[calls.length - 1]!;

beforeEach(() => {
  calls = [];
  responses = [];
});

const body = { format: "storage", value: "<p>x</p>" };
const rep = { representation: "storage", value: "<p>x</p>" };

describe("canonical read tools", () => {
  it("list_spaces / get_space (id and key)", async () => {
    await call("confluence_list_spaces", { keys: "ENG", cloudId: "site.atlassian.net" });
    expect(last().url.pathname).toBe("/wiki/api/v2/spaces");
    expect(last().url.searchParams.get("keys")).toBe("ENG");
    expect(last().url.searchParams.has("cloudId")).toBe(false);
    await call("confluence_get_space", { spaceId: "12" });
    expect(last().url.pathname).toBe("/wiki/api/v2/spaces/12");
    calls = [];
    responses = [[/GET \/wiki\/api\/v2\/spaces$/, { results: [{ id: "99" }] }]];
    await call("confluence_get_space", { spaceId: "ENG" });
    expect(calls.map((c) => c.url.pathname)).toEqual(["/wiki/api/v2/spaces", "/wiki/api/v2/spaces/99"]);
  });

  it("list_content uses the space or global collection", async () => {
    await call("confluence_list_content", { spaceId: "1", title: "T" });
    expect(last().url.pathname).toBe("/wiki/api/v2/spaces/1/pages");
    await call("confluence_list_content", { contentType: "blogpost" });
    expect(last().url.pathname).toBe("/wiki/api/v2/blogposts");
  });

  it("get_content summary omits body, full asks for it, and returns a snapshotToken", async () => {
    responses = [[/pages\/5$/, { id: "5", title: "T", version: { number: 3 }, body: { storage: { value: "x" } } }]];
    const s = await call("confluence_get_content", { contentId: "5" });
    expect(last().url.searchParams.has("body-format")).toBe(false);
    const out = JSON.parse(s.text);
    expect(out.body).toBeUndefined();
    expect(out.snapshotToken).toEqual(expect.any(String));
    await call("confluence_get_content", { contentId: "5", detail: "full", contentType: "page" });
    expect(last().url.searchParams.get("body-format")).toBe("storage");
    await call("confluence_get_content", { contentId: "7", contentType: "blogpost" });
    expect(last().url.pathname).toBe("/wiki/api/v2/blogposts/7");
  });

  it("versions, comments, attachments, tasks, search", async () => {
    await call("confluence_list_content_versions", { contentId: "5" });
    expect(last().url.pathname).toBe("/wiki/api/v2/pages/5/versions");
    await call("confluence_get_content_version", { contentId: "5", versionNumber: 2, contentType: "blogpost" });
    expect(last().url.pathname).toBe("/wiki/api/v2/blogposts/5/versions/2");
    await call("confluence_list_comments", { contentId: "5", commentType: "inline" });
    expect(last().url.pathname).toBe("/wiki/api/v2/pages/5/inline-comments");
    calls = [];
    await call("confluence_list_comments", { contentId: "5" });
    expect(calls.map((c) => c.url.pathname).sort()).toEqual([
      "/wiki/api/v2/pages/5/footer-comments",
      "/wiki/api/v2/pages/5/inline-comments",
    ]);
    await call("confluence_get_comment", { commentId: "9", commentType: "inline" });
    expect(last().url.pathname).toBe("/wiki/api/v2/inline-comments/9");
    await call("confluence_list_attachments", { contentId: "5", filename: "a.png" });
    expect(last().url.pathname).toBe("/wiki/api/v2/pages/5/attachments");
    expect(last().url.searchParams.get("filename")).toBe("a.png");
    await call("confluence_get_attachment", { attachmentId: "att1" });
    expect(last().url.pathname).toBe("/wiki/api/v2/attachments/att1");
    await call("confluence_list_tasks", { status: "incomplete", pageId: "5", assignedTo: "u1" });
    expect(last().url.pathname).toBe("/wiki/api/v2/tasks");
    expect(last().url.searchParams.get("page-id")).toBe("5");
    expect(last().url.searchParams.get("assigned-to")).toBe("u1");
    await call("confluence_get_task", { taskId: "t1" });
    expect(last().url.pathname).toBe("/wiki/api/v2/tasks/t1");
    await call("confluence_search", { cql: "type=page", cursor: "c1", cloudId: "site.atlassian.net" });
    expect(last().url.pathname).toBe("/wiki/rest/api/search");
    expect(last().url.searchParams.get("cursor")).toBe("c1");
    expect(last().url.searchParams.has("cloudId")).toBe(false);
  });

  it("download_attachment returns metadata and an absolute URL", async () => {
    responses = [[/attachments\/att1$/, { id: "att1", downloadLink: "/download/attachments/5/a.png?version=1" }]];
    const { text } = await call("confluence_download_attachment", { attachmentId: "att1" });
    expect(JSON.parse(text).downloadUrl).toBe("https://site.atlassian.net/wiki/download/attachments/5/a.png?version=1");
  });
});

describe("canonical write tools", () => {
  it("create_content for page, blogpost, folder", async () => {
    await call("confluence_create_content", { contentType: "page", spaceId: "1", title: "T", parent: { id: "9" }, body });
    expect(last()).toMatchObject({ method: "POST", body: { spaceId: "1", title: "T", parentId: "9", status: "current", body: rep } });
    expect(last().url.pathname).toBe("/wiki/api/v2/pages");
    await call("confluence_create_content", { contentType: "blogpost", spaceId: "1", title: "B", body: { format: "atlas_doc_format", value: { type: "doc" } } });
    expect(last().url.pathname).toBe("/wiki/api/v2/blogposts");
    expect(last().body.body).toEqual({ representation: "atlas_doc_format", value: '{"type":"doc"}' });
    await call("confluence_create_content", { contentType: "folder", spaceId: "1", title: "F", parent: { id: "9" } });
    expect(last()).toMatchObject({ method: "POST", body: { spaceId: "1", title: "F", parentId: "9" } });
    expect(last().url.pathname).toBe("/wiki/api/v2/folders");
  });

  it("rejects markdown and a missing body", async () => {
    const md = await call("confluence_create_content", { contentType: "page", spaceId: "1", title: "T", body: { format: "markdown", value: "# x" } });
    expect(md.res.isError).toBe(true);
    expect(md.text).toMatch(/markdown/);
    expect(calls).toEqual([]);
    const none = await call("confluence_create_content", { contentType: "page", spaceId: "1", title: "T" });
    expect(none.res.isError).toBe(true);
  });

  it("snapshotToken round trip and stale rejection", async () => {
    responses = [[/GET \/wiki\/api\/v2\/pages\/5$/, { id: "5", title: "Old", version: { number: 3 } }]];
    const read = await call("confluence_get_content", { contentId: "5" });
    const { snapshotToken } = JSON.parse(read.text);
    calls = [];
    await call("confluence_update_content", { contentId: "5", contentType: "page", snapshotToken, body, versionMessage: "m" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect(last().url.pathname).toBe("/wiki/api/v2/pages/5");
    expect(last().body).toMatchObject({ id: "5", status: "current", title: "Old", body: rep, version: { number: 4, message: "m" } });

    responses = [[/GET \/wiki\/api\/v2\/pages\/5$/, { id: "5", title: "Old", version: { number: 4 } }]];
    calls = [];
    const stale = await call("confluence_update_content", { contentId: "5", contentType: "page", snapshotToken, body });
    expect(stale.res.isError).toBe(true);
    expect(stale.text).toMatch(/Conflict/);
    expect(calls.every((c) => c.method === "GET")).toBe(true);

    const other = await call("confluence_update_content", { contentId: "6", contentType: "page", snapshotToken, body });
    expect(other.res.isError).toBe(true);
    const bad = await call("confluence_update_content", { contentId: "5", contentType: "page", snapshotToken: "zzz", body });
    expect(bad.text).toMatch(/Invalid snapshotToken/);
  });

  it("comments: create, update, resolution", async () => {
    await call("confluence_create_comment", { contentId: "5", body, parentCommentId: "2" });
    expect(last()).toMatchObject({ method: "POST", body: { pageId: "5", parentCommentId: "2", body: rep } });
    expect(last().url.pathname).toBe("/wiki/api/v2/footer-comments");
    await call("confluence_create_comment", { contentId: "5", commentType: "inline", body, inlineCommentProperties: { textSelection: "a" } });
    expect(last().url.pathname).toBe("/wiki/api/v2/inline-comments");
    expect(last().body.inlineCommentProperties).toEqual({ textSelection: "a" });
    await call("confluence_update_comment", { commentId: "9", body, versionNumber: 3 });
    expect(last()).toMatchObject({ method: "PUT", body: { version: { number: 3 }, body: rep } });
    expect(last().url.pathname).toBe("/wiki/api/v2/footer-comments/9");
    responses = [[/GET \/wiki\/api\/v2\/inline-comments\/9$/, { version: { number: 2 }, body: { storage: { value: "<p>c</p>" } } }]];
    await call("confluence_update_comment_resolution", { commentId: "9", resolved: true });
    expect(last()).toMatchObject({
      method: "PUT",
      body: { version: { number: 3 }, body: { representation: "storage", value: "<p>c</p>" }, resolved: true },
    });
  });

  it("tasks and labels", async () => {
    await call("confluence_complete_task", { taskId: "t1" });
    expect(last()).toMatchObject({ method: "PUT", body: { status: "complete" } });
    expect(last().url.pathname).toBe("/wiki/api/v2/tasks/t1");
    await call("confluence_reopen_task", { taskId: "t1" });
    expect(last().body.status).toBe("incomplete");
    await call("confluence_add_labels_to_content", { contentId: "5", labels: ["a", "b"] });
    expect(last()).toMatchObject({ method: "POST", body: [{ prefix: "global", name: "a" }, { prefix: "global", name: "b" }] });
    expect(last().url.pathname).toBe("/wiki/rest/api/content/5/label");
  });
});

describe("legacy aliases", () => {
  it("keep their old arguments", async () => {
    await call("confluence_get_spaces", { keys: "ENG", limit: 5 });
    expect(last().url.pathname).toBe("/wiki/api/v2/spaces");
    await call("confluence_get_pages_in_space", { spaceId: "1", title: "T" });
    expect(last().url.pathname).toBe("/wiki/api/v2/spaces/1/pages");
    await call("confluence_get_page", { pageId: "5" });
    expect(last().url.pathname).toBe("/wiki/api/v2/pages/5");
    expect(last().url.searchParams.get("body-format")).toBe("storage");
    await call("confluence_get_page_footer_comments", { pageId: "5" });
    expect(last().url.pathname).toBe("/wiki/api/v2/pages/5/footer-comments");
    await call("confluence_get_page_inline_comments", { pageId: "5" });
    expect(last().url.pathname).toBe("/wiki/api/v2/pages/5/inline-comments");
    await call("confluence_search_cql", { cql: "x", start: 2 });
    expect(last().url.pathname).toBe("/wiki/rest/api/search");
    await call("confluence_create_page", { spaceId: "1", title: "T", parentId: "9", bodyValue: "<p>x</p>" });
    expect(last()).toMatchObject({ method: "POST", body: { spaceId: "1", title: "T", parentId: "9", status: "current", body: rep } });
    await call("confluence_update_page", { pageId: "5", title: "T", versionNumber: 4, bodyValue: "<p>x</p>" });
    expect(last()).toMatchObject({ method: "PUT", body: { id: "5", title: "T", version: { number: 4 }, body: rep } });
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    await call("confluence_create_footer_comment", { pageId: "5", bodyValue: "<p>x</p>" });
    expect(last()).toMatchObject({ method: "POST", body: { pageId: "5", body: rep } });
    await call("confluence_create_inline_comment", { pageId: "5", bodyValue: "<p>x</p>", inlineCommentProperties: { a: 1 } });
    expect(last().url.pathname).toBe("/wiki/api/v2/inline-comments");
    expect(last().body.inlineCommentProperties).toEqual({ a: 1 });
  });

  it("are hidden with DEV_MCP_LEGACY_TOOL_NAMES=0, canonical and extra tools stay", async () => {
    const names = (await (await connect({ DEV_MCP_LEGACY_TOOL_NAMES: "0" })).listTools()).tools.map((t) => t.name);
    for (const n of [
      "confluence_get_spaces", "confluence_get_pages_in_space", "confluence_get_page", "confluence_get_page_footer_comments",
      "confluence_get_page_inline_comments", "confluence_search_cql", "confluence_create_page", "confluence_update_page",
      "confluence_create_footer_comment", "confluence_create_inline_comment",
    ]) expect(names).not.toContain(n);
    for (const n of ["confluence_get_content", "confluence_update_content", "confluence_search", "confluence_get_page_descendants"]) {
      expect(names).toContain(n);
    }
    const on = (await (await connect()).listTools()).tools.map((t) => t.name);
    expect(on).toContain("confluence_get_page");
  });

  it("every canonical tool accepts cloudId", async () => {
    const tools = (await (await connect()).listTools()).tools.filter(
      (t) => t.name.startsWith("confluence_") && !t.description?.startsWith("Deprecated alias"),
    );
    expect(tools.length).toBeGreaterThan(20);
    for (const t of tools) expect((t.inputSchema.properties as Record<string, unknown>).cloudId, t.name).toBeDefined();
  });
});

describe("confluence_download_attachment with save_to", () => {
  let tmp: string;
  let prevRoots: string | undefined;
  let hops: Array<{ url: string; auth: string | null }>;
  let metaTitle: string;
  let link: string;

  const dlFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    hops.push({ url: url.toString(), auth: new Headers(init?.headers).get("authorization") });
    if (url.pathname === "/wiki/api/v2/attachments/att1") {
      return new Response(JSON.stringify({ id: "att1", title: metaTitle, mediaType: "image/png", downloadLink: link }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.startsWith("/wiki/download/")) {
      return new Response(null, { status: 302, headers: { location: "https://cdn.example.org/blob/1?sig=z" } });
    }
    if (url.hostname === "cdn.example.org" || url.hostname === "evil.example.org") {
      return new Response(Buffer.from([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/png" } });
    }
    return new Response("nope", { status: 404 });
  };

  async function run(args: Record<string, unknown>) {
    const server = createServer(loadConfig(ENV), { fetch: dlFetch });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const res = (await client.callTool({ name: "confluence_download_attachment", arguments: args })) as Res;
    return { res, text: res.content[0]?.text ?? "" };
  }

  beforeEach(async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const p = await import("node:path");
    tmp = await fs.realpath(await fs.mkdtemp(p.join(os.tmpdir(), "devmcp-conf-")));
    prevRoots = process.env.DEV_MCP_SAVE_ROOTS;
    process.env.DEV_MCP_SAVE_ROOTS = tmp;
    hops = [];
    metaTitle = "diagram.png";
    link = "/download/attachments/5/diagram.png?version=1";
  });
  afterEach(async () => {
    const fs = await import("node:fs/promises");
    if (prevRoots === undefined) delete process.env.DEV_MCP_SAVE_ROOTS;
    else process.env.DEV_MCP_SAVE_ROOTS = prevRoots;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("saves into a directory, auth only on the site hop, not on the redirect target", async () => {
    const fs = await import("node:fs/promises");
    const p = await import("node:path");
    const { res, text } = await run({ attachmentId: "att1", save_to: tmp + p.sep });
    expect(res.isError, text).toBeUndefined();
    expect(JSON.parse(text)).toMatchObject({ kind: "file", bytes: 4, saved_to: p.join(tmp, "diagram.png") });
    expect([...(await fs.readFile(p.join(tmp, "diagram.png")))]).toEqual([1, 2, 3, 4]);
    expect(hops.find((h) => h.url.includes("/wiki/download/"))!.auth).toMatch(/^Basic /);
    expect(hops.find((h) => h.url.includes("cdn.example.org"))!.auth).toBeNull();
  });

  it("never sends credentials to an absolute download link on another host", async () => {
    const p = await import("node:path");
    link = "https://evil.example.org/steal/diagram.png";
    const { res, text } = await run({ attachmentId: "att1", save_to: p.join(tmp, "x.png") });
    expect(res.isError, text).toBeUndefined();
    expect(hops.find((h) => h.url.startsWith("https://evil.example.org"))!.auth).toBeNull();
  });

  it("sanitises the title, refuses collisions without overwrite, and prechecks before the network", async () => {
    const fs = await import("node:fs/promises");
    const p = await import("node:path");
    metaTitle = "a:b.png.";
    let r = await run({ attachmentId: "att1", save_to: tmp + p.sep });
    expect(r.res.isError, r.text).toBeUndefined();
    expect(JSON.parse(r.text).saved_to).toBe(p.join(tmp, "a_b.png"));
    r = await run({ attachmentId: "att1", save_to: tmp + p.sep });
    expect(r.res.isError).toBe(true);
    expect(r.text).toMatch(/already exists/);
    hops = [];
    r = await run({ attachmentId: "att1", save_to: p.join(tmp, "..", "x.png") });
    expect(r.res.isError).toBe(true);
    expect(hops).toHaveLength(0);
    expect((await fs.readdir(tmp)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { collectUsage, filterComments, mergeNodeIds } from "../src/figma/parity.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const NODE_DOC = {
  id: "1:2",
  name: "Frame",
  type: "FRAME",
  styles: { fill: "S:1" },
  boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: "VariableID:9:1" }] },
  children: [
    {
      id: "1:3",
      name: "Text",
      type: "TEXT",
      characters: "hello",
      styles: { text: "S:2" },
      boundVariables: { fontSize: { type: "VARIABLE_ALIAS", id: "VariableID:9:2" } },
    },
  ],
};

const COMMENTS = {
  comments: [
    { id: "c1", message: "open @ana", user: { handle: "bob", id: "u1" }, resolved_at: null, client_meta: { node_id: "1:3" } },
    { id: "c2", message: "done", user: { handle: "ana", id: "u2" }, resolved_at: "2026-01-01", client_meta: { node_id: "7:7" } },
    { id: "c3", message: "reply", parent_id: "c2", user: { handle: "bob", id: "u1" }, resolved_at: null },
  ],
};

let calls: string[];
let variablesStatus = 200;

let imgAuth: Array<string | null> = [];

const fetchMock: typeof fetch = async (input, init) => {
  const url = String(input);
  calls.push(url);
  if (url.startsWith("https://img.test/")) imgAuth.push(new Headers(init?.headers).get("authorization") ?? new Headers(init?.headers).get("x-figma-token"));
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (url.includes("/variables/local")) {
    if (variablesStatus !== 200) return json({ err: "forbidden" }, variablesStatus);
    return json({
      meta: {
        variables: {
          "VariableID:9:1": { id: "VariableID:9:1", name: "color/bg", variableCollectionId: "C:1" },
          "VariableID:9:2": { id: "VariableID:9:2", name: "size/body", variableCollectionId: "C:1" },
          "VariableID:9:3": { id: "VariableID:9:3", name: "unused", variableCollectionId: "C:1" },
        },
        variableCollections: { "C:1": { id: "C:1", name: "Tokens" } },
      },
    });
  }
  if (url.includes("/comments")) return json(COMMENTS);
  if (url.includes("/v1/images/")) {
    const fmt = new URL(url).searchParams.get("format") ?? "png";
    return json({ images: { "1:2": `https://img.test/a.${fmt}`, "3:4": `https://img.test/b.${fmt}` } });
  }
  if (url.startsWith("https://img.test/")) {
    const ext = url.split(".").pop();
    if (ext === "svg") return new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", { status: 200, headers: { "content-type": "image/svg+xml" } });
    if (ext === "pdf") return new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf" } });
    if (ext === "jpg") return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { "content-type": "image/jpeg" } });
    return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  }
  if (url.includes("/files/KEY/nodes")) {
    const u = new URL(url);
    const ids = (u.searchParams.get("ids") ?? "").split(",");
    return json({
      name: "File",
      nodes: Object.fromEntries(
        ids.map((id) => [
          id,
          id === "1:2"
            ? { document: NODE_DOC, styles: { "S:1": { name: "Brand", styleType: "FILL" }, "S:2": { name: "Body", styleType: "TEXT" } } }
            : id === "2:1"
              ? {
                  document: {
                    id: "2:1",
                    name: "Board",
                    type: "SECTION",
                    children: [{ id: "2:2", name: "S", type: "STICKY", text: { characters: "idea" } }],
                  },
                }
              : null,
        ]),
      ),
    });
  }
  if (url.includes("/files/KEY") && !url.includes("/images")) {
    return json({
      name: "File",
      document: { id: "0:0", name: "Doc", type: "DOCUMENT", children: [{ id: "0:1", name: "Home", type: "CANVAS", children: [] }] },
    });
  }
  return new Response("not found", { status: 404 });
};

let dir: string;
let saved: string | undefined;

async function connect() {
  const config = loadConfig({ FIGMA_ACCESS_TOKEN: "f" } as NodeJS.ProcessEnv);
  const server = createServer(config, { fetch: fetchMock });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type Res = { isError?: boolean; content: Array<{ type: string; text?: string }> };
async function call(name: string, args: Record<string, unknown>): Promise<Res> {
  return (await (await connect()).callTool({ name, arguments: args })) as Res;
}
const body = (r: Res) => JSON.parse(r.content[0]!.text!);

beforeEach(async () => {
  calls = [];
  imgAuth = [];
  variablesStatus = 200;
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "devmcp-figma-")));
  saved = process.env.DEV_MCP_SAVE_ROOTS;
  process.env.DEV_MCP_SAVE_ROOTS = dir;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.DEV_MCP_SAVE_ROOTS;
  else process.env.DEV_MCP_SAVE_ROOTS = saved;
  await rm(dir, { recursive: true, force: true });
});

describe("helpers", () => {
  it("merges nodeId and nodeIds, accepting dash form", () => {
    expect(mergeNodeIds(["1-2"], "3:4")).toEqual(["1:2", "3:4"]);
    expect(mergeNodeIds(undefined, undefined)).toBeUndefined();
  });
  it("collects bound variables and styles with their nodes", () => {
    const u = collectUsage(NODE_DOC);
    expect([...u.variableIds.keys()].sort()).toEqual(["VariableID:9:1", "VariableID:9:2"]);
    expect([...u.variableIds.get("VariableID:9:2")!]).toEqual(["1:3"]);
    expect([...u.styles.keys()].sort()).toEqual(["S:1", "S:2"]);
  });
  it("filters comments, replies follow the thread root", () => {
    const c = COMMENTS.comments;
    expect(filterComments(c, { resolved: true }).map((x) => x.id)).toEqual(["c2", "c3"]);
    expect(filterComments(c, { resolved: false }).map((x) => x.id)).toEqual(["c1"]);
    expect(filterComments(c, { author: "@ana" }).map((x) => x.id)).toEqual(["c2"]);
    expect(filterComments(c, { mention: "ana" }).map((x) => x.id)).toEqual(["c1"]);
  });
});

describe("screenshots", () => {
  it("figma_get_screenshot returns image content and accepts nodeId", async () => {
    const res = await call("figma_get_screenshot", { fileKey: "KEY", nodeId: "1-2" });
    expect(res.isError).toBeUndefined();
    expect(res.content.some((c) => c.type === "image")).toBe(true);
    expect(body(res).images[0]).toMatchObject({ nodeId: "1:2", mime: "image/png" });
  });

  it("figma_fetch_screenshot behaves identically", async () => {
    const res = await call("figma_fetch_screenshot", { fileKey: "KEY", nodeId: "1:2" });
    expect(res.content.some((c) => c.type === "image")).toBe(true);
  });

  it("figma_get_image_urls returns the URLs, not images", async () => {
    const res = await call("figma_get_image_urls", { fileKey: "KEY", nodeId: "1:2" });
    expect(res.content.every((c) => c.type === "text")).toBe(true);
    expect(body(res).images["1:2"]).toBe("https://img.test/a.png");
  });

  it("requires a node id", async () => {
    const res = await call("figma_get_screenshot", { fileKey: "KEY" });
    expect(res.isError).toBe(true);
  });
});

describe("figma_get_variable_defs", () => {
  it("without nodeId keeps the whole-file result", async () => {
    const out = body(await call("figma_get_variable_defs", { fileKey: "KEY" }));
    expect(Object.keys(out.local.variables)).toHaveLength(3);
    expect(calls.some((u) => u.includes("/nodes"))).toBe(false);
  });

  it("with nodeId returns only used variables and styles", async () => {
    const out = body(await call("figma_get_variable_defs", { fileKey: "KEY", nodeId: "1-2" }));
    expect(Object.keys(out.local.variables).sort()).toEqual(["VariableID:9:1", "VariableID:9:2"]);
    expect(Object.keys(out.local.variableCollections)).toEqual(["C:1"]);
    expect(out.styles.map((s: { name: string }) => s.name).sort()).toEqual(["Body", "Brand"]);
    expect(out.warnings).toBeUndefined();
  });

  it("degrades to styles and bound ids with a warning on 403", async () => {
    variablesStatus = 403;
    const res = await call("figma_get_variable_defs", { fileKey: "KEY", nodeId: "1:2" });
    expect(res.isError).toBeUndefined();
    const out = body(res);
    expect(out.warnings[0]).toMatch(/Variables API unavailable/);
    expect(out.boundVariableIds.map((b: { id: string }) => b.id).sort()).toEqual(["VariableID:9:1", "VariableID:9:2"]);
    expect(out.boundVariableIds.every((b: { resolved: boolean }) => b.resolved === false)).toBe(true);
    expect(out.styles).toHaveLength(2);
  });
});

describe("figma_download_assets", () => {
  it("returns URLs by default and applies defaultFormat/defaultScale", async () => {
    const out = body(await call("figma_download_assets", { fileKey: "KEY", nodeId: "1:2", defaultFormat: "svg", defaultScale: 2, includeImageFills: false }));
    expect(out.exports.images["1:2"]).toBeDefined();
    const imgCall = calls.find((u) => u.includes("/v1/images/"))!;
    expect(imgCall).toContain("format=svg");
    expect(imgCall).toContain("scale=2");
  });

  it("explicit format wins over defaultFormat", async () => {
    await call("figma_download_assets", { fileKey: "KEY", nodeId: "1:2", format: "jpg", defaultFormat: "svg", includeImageFills: false });
    expect(calls.find((u) => u.includes("/v1/images/"))).toContain("format=jpg");
  });

  it("with save_to downloads PNG files into a directory", async () => {
    const out = path.join(dir, "assets") + path.sep;
    const res = await call("figma_download_assets", { fileKey: "KEY", nodeIds: ["1:2", "3:4"], save_to: out });
    expect(res.isError).toBeUndefined();
    expect(body(res)).toMatchObject({ kind: "png" });
    expect((await readdir(path.join(dir, "assets"))).sort()).toEqual(["1-2.png", "3-4.png"]);
  });

  it("with save_to saves svg, jpg and pdf, sends no auth header to the render host", async () => {
    for (const [fmt, magic] of [["svg", "<svg"], ["jpg", "ÿØ"], ["pdf", "%PDF"]] as const) {
      const out = path.join(dir, fmt) + path.sep;
      const res = await call("figma_download_assets", { fileKey: "KEY", nodeIds: ["1:2", "3:4"], format: fmt, save_to: out });
      expect(res.isError, res.content[0]!.text).toBeUndefined();
      expect(body(res)).toMatchObject({ kind: fmt });
      expect((await readdir(path.join(dir, fmt))).sort()).toEqual([`1-2.${fmt}`, `3-4.${fmt}`]);
      expect((await readFile(path.join(dir, fmt, `1-2.${fmt}`))).toString("latin1").startsWith(magic)).toBe(true);
    }
    expect(imgAuth.length).toBeGreaterThan(0);
    expect(imgAuth.every((a) => a === null)).toBe(true);
  });

  it("with save_to refuses a file whose extension does not match the format", async () => {
    const res = await call("figma_download_assets", { fileKey: "KEY", nodeId: "1:2", format: "pdf", save_to: path.join(dir, "a.png") });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/must end in .pdf/);
    expect(calls.some((u) => u.includes("/v1/images/"))).toBe(false); // checked before any network call
  });
});

describe("figma_get_comments", () => {
  it("returns everything without filters", async () => {
    expect(body(await call("figma_get_comments", { fileKey: "KEY" })).comments).toHaveLength(3);
  });
  it("filters resolved, author and mention", async () => {
    expect(body(await call("figma_get_comments", { fileKey: "KEY", resolved: false })).comments.map((c: { id: string }) => c.id)).toEqual(["c1"]);
    expect(body(await call("figma_get_comments", { fileKey: "KEY", author: "ana" })).comments.map((c: { id: string }) => c.id)).toEqual(["c2"]);
    expect(body(await call("figma_get_comments", { fileKey: "KEY", mention: "@ana" })).comments.map((c: { id: string }) => c.id)).toEqual(["c1"]);
  });
  it("filters by page using the page subtree", async () => {
    const res = await call("figma_get_comments", { fileKey: "KEY", page: "nope" });
    expect(body(res).comments).toEqual([]);
  });
});

describe("figma_get_figjam", () => {
  it("returns slim XML, texts and a screenshot", async () => {
    const res = await call("figma_get_figjam", { fileKey: "KEY", nodeId: "2-1" });
    expect(res.isError).toBeUndefined();
    const out = body(res);
    expect(out.xml).toContain('type="STICKY"');
    expect(out.texts).toEqual([{ id: "2:2", type: "STICKY", text: "idea" }]);
    expect(res.content.some((c) => c.type === "image")).toBe(false); // 2:1 has no render URL in the mock
    expect(out.warnings[0]).toMatch(/Screenshot failed/);
  });

  it("includes the image when the node renders", async () => {
    const res = await call("figma_get_figjam", { fileKey: "KEY", nodeId: "1:2" });
    expect(res.content.some((c) => c.type === "image")).toBe(true);
  });
});

describe("descriptions", () => {
  it("states design_context has no code generation", async () => {
    const tool = (await (await connect()).listTools()).tools.find((t) => t.name === "figma_get_design_context")!;
    expect(tool.description).toMatch(/does NOT generate code/);
    expect((tool.inputSchema.properties as Record<string, unknown>).nodeId).toBeDefined();
  });
});

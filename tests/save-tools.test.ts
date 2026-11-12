import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const BIG_PNG = Buffer.concat([PNG, Buffer.alloc(3000)]);
const MR = {
  iid: 7,
  state: "opened",
  draft: false,
  source_branch: "f",
  target_branch: "main",
  sha: "abc",
  web_url: "https://gl/x/-/merge_requests/7",
  description: "x".repeat(3000),
};

const fetchMock: typeof fetch = async (input) => {
  const url = String(input);
  const json = (b: unknown) =>
    new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (url.includes("/merge_requests/7")) return json(MR);
  if (url.includes("/v1/images/")) {
    return json({ images: { "1:2": "https://img.test/a.png", "3:4": "https://img.test/b.png", "5:6": "https://img.test/big.png" } });
  }
  if (url.startsWith("https://img.test/")) {
    const body = url.endsWith("big.png") ? BIG_PNG : PNG;
    return new Response(body, { status: 200, headers: { "content-type": "image/png" } });
  }
  return new Response("not found", { status: 404 });
};

let dir: string;
const saved: Record<string, string | undefined> = {};

async function connect() {
  const config = loadConfig({ GITLAB_TOKEN: "t", FIGMA_ACCESS_TOKEN: "f" } as NodeJS.ProcessEnv);
  const server = createServer(config, { fetch: fetchMock });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type Res = { isError?: boolean; content: Array<{ type: string; text?: string }> };

async function call(name: string, args: Record<string, unknown>): Promise<Res> {
  const client = await connect();
  return (await client.callTool({ name, arguments: args })) as Res;
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "devmcp-tools-")));
  for (const k of ["DEV_MCP_SAVE_ROOTS", "DEV_MCP_SPILL_KB", "DEV_MCP_SPILL_DIR"]) saved[k] = process.env[k];
  process.env.DEV_MCP_SAVE_ROOTS = dir;
  delete process.env.DEV_MCP_SPILL_KB;
  delete process.env.DEV_MCP_SPILL_DIR;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

const mrArgs = { projectId: "g/p", mergeRequestIid: 7 };

describe("save_to on a JSON tool", () => {
  it("returns the full payload without save_to (unchanged)", async () => {
    const res = await call("gitlab_get_merge_request", mrArgs);
    expect(JSON.parse(res.content[0]!.text!)).toEqual({ merge_request: MR });
  });

  it("writes the payload and returns only a compact summary", async () => {
    const file = path.join(dir, "mr.json");
    const res = await call("gitlab_get_merge_request", { ...mrArgs, save_to: file });
    const out = JSON.parse(res.content[0]!.text!);
    expect(out).toMatchObject({
      saved_to: file,
      kind: "json",
      summary: { iid: 7, state: "opened", draft: false, source_branch: "f", target_branch: "main", sha: "abc", web_url: MR.web_url },
    });
    expect(out.sha256).toHaveLength(64);
    expect(res.content[0]!.text).not.toContain("xxxx");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ merge_request: MR });
  });

  it("returns a tool error for a path outside the roots", async () => {
    const res = await call("gitlab_get_merge_request", {
      ...mrArgs,
      save_to: path.join(tmpdir(), "elsewhere-devmcp", "x.json"),
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/outside the allowed roots/);
  });

  it("refuses to overwrite an existing file unless overwrite is true", async () => {
    const file = path.join(dir, "mr.json");
    await call("gitlab_get_merge_request", { ...mrArgs, save_to: file });
    const again = await call("gitlab_get_merge_request", { ...mrArgs, save_to: file });
    expect(again.isError).toBe(true);
    expect(again.content[0]!.text).toMatch(/overwrite: true/);
    const ok = await call("gitlab_get_merge_request", { ...mrArgs, save_to: file, overwrite: true });
    expect(ok.isError).toBeUndefined();
  });

  it("rejects a bad extension and dot-folders before any network call", async () => {
    const calls: string[] = [];
    const spy: typeof fetch = async (i, init) => {
      calls.push(String(i));
      return fetchMock(i, init);
    };
    const config = loadConfig({ GITLAB_TOKEN: "t" } as NodeJS.ProcessEnv);
    const server = createServer(config, { fetch: spy });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    for (const save_to of [path.join(dir, "x.txt"), path.join(dir, ".ssh", "x.json")]) {
      const res = (await client.callTool({ name: "gitlab_get_merge_request", arguments: { ...mrArgs, save_to } })) as Res;
      expect(res.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it("exposes save_to in the schema and description", async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === "gitlab_get_merge_request")!;
    expect(tool.description).toMatch(/save_to/);
    expect((tool.inputSchema.properties as Record<string, unknown>).save_to).toBeDefined();
  });
});

describe("save_to on an image tool", () => {
  it("writes PNG bytes and returns no image content", async () => {
    const file = path.join(dir, "shot.png");
    const res = await call("figma_fetch_screenshot", { fileKey: "KEY", nodeIds: "1:2", save_to: file });
    expect(res.content.every((c) => c.type === "text")).toBe(true);
    const out = JSON.parse(res.content[0]!.text!);
    expect(out).toMatchObject({ saved_to: file, kind: "png", bytes: PNG.length });
    expect(out.summary.images[0]).toMatchObject({ nodeId: "1:2", width: 1, height: 1 });
    expect((await readFile(file)).equals(PNG)).toBe(true);
  });

  it("writes one file per node into a directory and refuses a file path for several", async () => {
    const res = await call("figma_get_screenshot", {
      fileKey: "KEY",
      nodeIds: ["1:2", "3:4"],
      save_to: path.join(dir, "out") + path.sep,
    });
    expect(res.isError).toBeUndefined();
    expect((await readdir(path.join(dir, "out"))).sort()).toEqual(["1-2.png", "3-4.png"]);
    const bad = await call("figma_fetch_screenshot", {
      fileKey: "KEY",
      nodeIds: ["1:2", "3:4"],
      save_to: path.join(dir, "x.png"),
    });
    expect(bad.isError).toBe(true);
  });

  it("fails on a wrong image extension or colliding node ids", async () => {
    const ext = await call("figma_fetch_screenshot", { fileKey: "KEY", nodeIds: "1:2", save_to: path.join(dir, "x.json") });
    expect(ext.isError).toBe(true);
    const dup = await call("figma_fetch_screenshot", { fileKey: "KEY", nodeIds: ["1:2", "1-2"], save_to: path.join(dir, "d") + path.sep });
    expect(dup.isError).toBe(true);
    expect(dup.content[0]!.text).toMatch(/same file name/);
  });

  it("still returns image content without save_to", async () => {
    const res = await call("figma_fetch_screenshot", { fileKey: "KEY", nodeIds: "1:2" });
    expect(res.content.some((c) => c.type === "image")).toBe(true);
  });
});

describe("auto-spill", () => {
  it("is off by default", async () => {
    const res = await call("gitlab_get_merge_request", mrArgs);
    expect(JSON.parse(res.content[0]!.text!).merge_request.iid).toBe(7);
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps the normal payload below the threshold", async () => {
    process.env.DEV_MCP_SPILL_KB = "64";
    const res = await call("gitlab_get_merge_request", mrArgs);
    expect(JSON.parse(res.content[0]!.text!).merge_request.iid).toBe(7);
    const img = await call("figma_fetch_screenshot", { fileKey: "KEY", nodeIds: "5:6" });
    expect(img.content.some((c) => c.type === "image")).toBe(true);
  });

  it("spills a JSON payload above the threshold with summary, spilled and hint", async () => {
    process.env.DEV_MCP_SPILL_KB = "1";
    process.env.DEV_MCP_SPILL_DIR = path.join(dir, "spill");
    const res = await call("gitlab_get_merge_request", mrArgs);
    const out = JSON.parse(res.content[0]!.text!);
    expect(out.spilled).toBe(true);
    expect(out.hint).toContain("Payload exceeded DEV_MCP_SPILL_KB; full content saved to ");
    expect(out.saved_to).toMatch(/spill[\\/]gitlab_get_merge_request-\d{14}-[0-9a-f]{8}\.json$/);
    expect(out.summary.iid).toBe(7);
    expect(JSON.parse(await readFile(out.saved_to, "utf8"))).toEqual({ merge_request: MR });
  });

  it("spills oversized images as PNG files", async () => {
    process.env.DEV_MCP_SPILL_KB = "1";
    process.env.DEV_MCP_SPILL_DIR = path.join(dir, "spill");
    const res = await call("figma_fetch_screenshot", { fileKey: "KEY", nodeIds: "5:6" });
    expect(res.content.every((c) => c.type === "text")).toBe(true);
    const out = JSON.parse(res.content[0]!.text!);
    expect(out).toMatchObject({ spilled: true, kind: "png", bytes: BIG_PNG.length });
    expect(out.saved_to).toMatch(/figma_fetch_screenshot-\d{14}-[0-9a-f]{8}\.png$/);
    expect((await readFile(out.saved_to)).equals(BIG_PNG)).toBe(true);
  });
});

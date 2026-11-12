import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, lstat } from "node:fs/promises";
import { allowedRoots, defaultRoot, precheckSave, resolveSavePath, saveJson, saveJsonWithImages, savePngs, spillBytes, spillDir } from "../src/save.js";

let root: string;
let outside: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "devmcp-root-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "devmcp-out-")));
  env = { DEV_MCP_SAVE_ROOTS: root };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("allowedRoots", () => {
  it("defaults to <tmpdir>/dev.mcp only, and honours DEV_MCP_SAVE_ROOTS", () => {
    expect(allowedRoots({})).toEqual([defaultRoot()]);
    expect(path.basename(defaultRoot())).toBe("dev.mcp");
    expect(allowedRoots({ DEV_MCP_SAVE_ROOTS: [root, outside].join(path.delimiter) })).toEqual([root, outside]);
    expect(() => allowedRoots({ DEV_MCP_SAVE_ROOTS: "relative/dir" })).toThrow(/absolute/);
  });
});

describe("resolveSavePath", () => {
  it("rejects relative, outside-root, and traversal paths", async () => {
    await expect(resolveSavePath("a.json", { env })).rejects.toThrow(/absolute/);
    await expect(resolveSavePath(path.join(outside, "a.json"), { env })).rejects.toThrow(/outside/);
    const traversal = path.join(root, "..", path.basename(outside), "a.json");
    await expect(resolveSavePath(traversal, { env })).rejects.toThrow(/outside/);
  });

  it("rejects a symlink/junction that escapes the roots", async () => {
    const link = path.join(root, "link");
    try {
      await symlink(outside, link, "junction");
    } catch {
      return; // symlinks unavailable on this machine
    }
    await expect(resolveSavePath(path.join(link, "sub", "a.json"), { env })).rejects.toThrow(/symlink|outside/);
  });
});

describe("saveJson", () => {
  it("writes pretty UTF-8 JSON atomically, creates parents, overwrites, and reports sha256", async () => {
    const file = path.join(root, "deep", "dir", "a.json");
    const res = await saveJson(file, { a: "ç", n: [1] }, { env });
    const text = await readFile(file, "utf8");
    expect(text).toBe(`${JSON.stringify({ a: "ç", n: [1] }, null, 2)}\n`);
    expect(res).toMatchObject({ saved_to: file, kind: "json", bytes: Buffer.byteLength(text) });
    expect(res.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    await expect(saveJson(file, { b: 1 }, { env })).rejects.toThrow(/overwrite: true/);
    await saveJson(file, { b: 1 }, { env, overwrite: true });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ b: 1 });
    expect(await readdir(path.dirname(file))).toEqual(["a.json"]); // no tmp leftovers
  });

  it("re-serialises a JSON string pretty", async () => {
    const file = path.join(root, "s.json");
    await saveJson(file, '{"x":1}', { env });
    expect(await readFile(file, "utf8")).toBe('{\n  "x": 1\n}\n');
  });

  it("rejects a wrong extension and writes nothing", async () => {
    await expect(saveJson(path.join(root, "a.txt"), {}, { env })).rejects.toThrow(/\.json/);
    await expect(saveJson(path.join(root, "a.png"), {}, { env })).rejects.toThrow(/\.json/);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("savePngs", () => {
  const png = Buffer.from([137, 80, 78, 71, 1, 2, 3]);

  it("writes one file, or <node-id-dashed>.png per node in a directory", async () => {
    const one = path.join(root, "one.png");
    const [r] = await savePngs(one, [{ nodeId: "1:2", data: png }], { env });
    expect(r).toMatchObject({ kind: "png", bytes: png.length });
    expect((await readFile(one)).equals(png)).toBe(true);

    const dir = path.join(root, "shots") + path.sep;
    await savePngs(dir, [{ nodeId: "1:2", data: png }, { nodeId: "3:4", data: png }], { env });
    expect((await readdir(path.join(root, "shots"))).sort()).toEqual(["1-2.png", "3-4.png"]);
  });

  it("requires a directory for several images and a .png file for one", async () => {
    const imgs = [{ nodeId: "1:2", data: png }, { nodeId: "3:4", data: png }];
    await expect(savePngs(path.join(root, "x.png"), imgs, { env })).rejects.toThrow(/directory/);
    await expect(savePngs(path.join(root, "x.json"), imgs.slice(0, 1), { env })).rejects.toThrow(/\.png/);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("spill config", () => {
  it("is disabled unless DEV_MCP_SPILL_KB is a positive integer", () => {
    expect(spillBytes({})).toBe(0);
    expect(spillBytes({ DEV_MCP_SPILL_KB: "0" })).toBe(0);
    expect(spillBytes({ DEV_MCP_SPILL_KB: "abc" })).toBe(0);
    expect(spillBytes({ DEV_MCP_SPILL_KB: "2" })).toBe(2048);
  });

  it("validates DEV_MCP_SPILL_DIR against the roots", async () => {
    await expect(spillDir({ ...env, DEV_MCP_SPILL_DIR: path.join(outside, "s") })).rejects.toThrow(/outside/);
    const ok = await spillDir({ ...env, DEV_MCP_SPILL_DIR: path.join(root, "s") });
    expect(ok).toBe(path.join(root, "s"));
    await mkdir(ok, { recursive: true });
  });
});

describe("hardening", () => {
  it("rejects dot-prefixed config folders, with a DEV_MCP_SAVE_ALLOW_DOT allowlist (default .factory)", async () => {
    for (const bad of [".ssh", ".claude", ".git", ".config", ".aws", ".env.local"]) {
      await expect(resolveSavePath(path.join(root, bad, "a.json"), { env })).rejects.toThrow(/dot-prefixed/);
    }
    await expect(resolveSavePath(path.join(root, ".claude.json"), { env })).rejects.toThrow(/dot-prefixed/);
    await expect(resolveSavePath(path.join(root, ".factory", "runs", "a.json"), { env })).resolves.toBeTruthy();
    await expect(
      resolveSavePath(path.join(root, ".custom", "a.json"), { env: { ...env, DEV_MCP_SAVE_ALLOW_DOT: ".custom" } }),
    ).resolves.toBeTruthy();
    await expect(
      resolveSavePath(path.join(root, ".factory", "a.json"), { env: { ...env, DEV_MCP_SAVE_ALLOW_DOT: ".custom" } }),
    ).rejects.toThrow(/dot-prefixed/);
  });

  it("rejects ':' after the drive letter and trailing dots or spaces before touching the filesystem", async () => {
    await expect(resolveSavePath(path.join(root, "a.json:stream"), { env })).rejects.toThrow(/':'/);
    await expect(resolveSavePath(path.join(root, "dir.", "a.json"), { env })).rejects.toThrow(/dot or space/);
    await expect(resolveSavePath(path.join(root, "dir ", "a.json"), { env })).rejects.toThrow(/dot or space/);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses to overwrite unless overwrite is true (pre-check too)", async () => {
    const file = path.join(root, "o.json");
    await saveJson(file, { a: 1 }, { env });
    await expect(precheckSave(file, "json", { env })).rejects.toThrow(/already exists/);
    await expect(precheckSave(file, "json", { env, overwrite: true })).resolves.toEqual([file]);
    await expect(saveJson(file, { a: 2 }, { env })).rejects.toThrow(/already exists/);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ a: 1 });
  });

  it("checks the extension in the pre-check", async () => {
    await expect(precheckSave(path.join(root, "a.txt"), "json", { env })).rejects.toThrow(/\.json/);
    await expect(precheckSave(path.join(root, "a.json"), "png", { env, nodeIds: ["1:2"] })).rejects.toThrow(/\.png/);
  });

  it("errors when two node ids map to the same file name", async () => {
    const dir = path.join(root, "shots") + path.sep;
    const png = Buffer.from([1]);
    await expect(savePngs(dir, [{ nodeId: "1:2", data: png }, { nodeId: "1-2", data: png }], { env })).rejects.toThrow(/same file name/);
    await expect(precheckSave(dir, "png", { env, nodeIds: ["1:2", "1-2"] })).rejects.toThrow(/same file name/);
    expect(await readdir(root)).toEqual([]);
  });

  it("saves embedded images next to the JSON as <name>.images/<n>.<ext>", async () => {
    const file = path.join(root, "issue.json");
    const img = Buffer.from([137, 80, 78, 71]);
    const r = await saveJsonWithImages(file, { k: 1 }, [{ data: img, mime: "image/png" }, { data: img, mime: "image/jpeg" }], { env });
    expect(r.images.map((i) => path.basename(i.saved_to))).toEqual(["1.png", "2.jpg"]);
    expect((await readFile(path.join(root, "issue.images", "1.png"))).equals(img)).toBe(true);
    expect(r.images[0]).toMatchObject({ bytes: 4, mime: "image/png" });
    await expect(saveJsonWithImages(file, {}, [{ data: img, mime: "image/png" }], { env })).rejects.toThrow(/already exists/);
  });

  it("re-checks the real parent before writing (junction in the path)", async () => {
    const link = path.join(root, "swap");
    try {
      await symlink(outside, link, "junction");
    } catch {
      return;
    }
    await expect(saveJson(path.join(link, "a.json"), {}, { env })).rejects.toThrow(/symlink|outside/);
    expect(await readdir(outside)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("uses 0700 dirs and 0600 files, and refuses a symlinked spill dir", async () => {
    const file = path.join(root, "m", "a.json");
    await saveJson(file, {}, { env });
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await lstat(path.dirname(file))).mode & 0o777).toBe(0o700);
    await chmod(root, 0o700);
    const target = path.join(root, "real");
    await mkdir(target);
    await symlink(target, path.join(root, "linked"));
    await expect(spillDir({ ...env, DEV_MCP_SPILL_DIR: path.join(root, "linked") })).rejects.toThrow(/symlink|not a directory/);
  });

  it("names the default spill dir per user and creates it", async () => {
    const dir = await spillDir({ DEV_MCP_SAVE_ROOTS: root });
    expect(path.basename(dir)).toMatch(/^dev\.mcp-spill-/);
    expect(path.dirname(dir)).toBe(root);
  });
});

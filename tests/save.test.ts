import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, lstat } from "node:fs/promises";
import { BYTES_EXTENSIONS, allowedRoots, defaultRoot, maxSaveBytes, precheckBytes, precheckSave, resolveSavePath, sanitizeFileName, saveBytes, saveJson, saveJsonWithImages, savePngs, spillBytes, spillDir } from "../src/save.js";

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

describe("sanitizeFileName", () => {
  it("keeps only the last segment and neutralises traversal", () => {
    expect(sanitizeFileName("..\\evil.txt")).toBe("evil.txt");
    expect(sanitizeFileName("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(sanitizeFileName("C:\\dir\\x.png")).toBe("x.png");
  });
  it("replaces ':' (NTFS streams), drops leading dots and trailing dots/spaces", () => {
    expect(sanitizeFileName("a:b.txt")).toBe("a_b.txt");
    expect(sanitizeFileName("a.txt:stream")).toBe("a.txt_stream");
    expect(sanitizeFileName(".env")).toBe("env");
    expect(sanitizeFileName("..hidden.txt")).toBe("hidden.txt");
    expect(sanitizeFileName("report.pdf. ")).toBe("report.pdf");
  });
  it("rejects empty, dot-only and device names", () => {
    expect(() => sanitizeFileName("")).toThrow();
    expect(() => sanitizeFileName("..")).toThrow();
    expect(() => sanitizeFileName("...  ")).toThrow();
    expect(() => sanitizeFileName("NUL.txt")).toThrow(/Reserved/);
  });
  it("caps the length and keeps the extension", () => {
    const n = sanitizeFileName(`${"a".repeat(300)}.png`);
    expect(n.length).toBeLessThanOrEqual(120);
    expect(n.endsWith(".png")).toBe(true);
  });
});

describe("saveBytes / precheckBytes", () => {
  const data = Buffer.from("payload");

  it("accepts every allow-listed extension and refuses others", async () => {
    for (const ext of BYTES_EXTENSIONS) {
      const r = await saveBytes(path.join(root, `f${ext}`), data, { env });
      expect(r).toMatchObject({ kind: "file", bytes: 7, sha256: createHash("sha256").update(data).digest("hex") });
      expect(r.saved_to).toBe(path.join(root, `f${ext}`));
    }
    for (const bad of ["a.exe", "a.sh", "a.bat", "a.html", "a", "a.PNG.exe"]) {
      await expect(saveBytes(path.join(root, bad), data, { env })).rejects.toThrow(/not allowed/);
    }
    await saveBytes(path.join(root, "UPPER.PNG"), data, { env });
  });

  it("directory mode uses the sanitised server file name", async () => {
    const r = await saveBytes(root + path.sep, data, { env, fileName: "..\\evil.txt" });
    expect(r.saved_to).toBe(path.join(root, "evil.txt"));
    expect((await readdir(root)).sort()).toEqual(["evil.txt"]);
    await expect(saveBytes(root + path.sep, data, { env, fileName: ".env" })).rejects.toThrow(/not allowed/);
    await expect(saveBytes(root + path.sep, data, { env, fileName: "run.exe" })).rejects.toThrow(/not allowed/);
    await expect(saveBytes(root + path.sep, data, { env })).rejects.toThrow(/no file name/);
    // an existing directory without a trailing separator is a directory too
    const r2 = await saveBytes(root, data, { env, fileName: "b:c.txt." });
    expect(r2.saved_to).toBe(path.join(root, "b_c.txt"));
  });

  it("precheckBytes validates the directory before the name is known", async () => {
    expect(await precheckBytes(root + path.sep, { env })).toEqual({ dir: root });
    await expect(precheckBytes(path.join(outside, "x") + path.sep, { env })).rejects.toThrow(/outside/);
    await expect(precheckBytes("rel/x.txt", { env })).rejects.toThrow(/absolute/);
    await expect(precheckBytes(path.join(root, ".ssh", "x.txt"), { env })).rejects.toThrow(/dot-prefixed/);
    await expect(precheckBytes(path.join(root, "a:b.txt"), { env })).rejects.toThrow(/':'/);
    await expect(precheckBytes(path.join(root, "a.txt."), { env })).rejects.toThrow(/dot or space/);
  });

  it("refuses a collision unless overwrite, leaving no temp files", async () => {
    const f = path.join(root, "a.txt");
    await saveBytes(f, Buffer.from("one"), { env });
    await expect(saveBytes(f, Buffer.from("two"), { env })).rejects.toThrow(/already exists/);
    expect((await readFile(f)).toString()).toBe("one");
    await saveBytes(f, Buffer.from("two"), { env, overwrite: true });
    expect((await readFile(f)).toString()).toBe("two");
    expect((await readdir(root)).sort()).toEqual(["a.txt"]);
    await expect(precheckBytes(root + path.sep, { env, fileName: "a.txt" })).rejects.toThrow(/already exists/);
  });

  it("enforces DEV_MCP_SAVE_MAX_MB (default 100)", async () => {
    expect(maxSaveBytes({})).toBe(100 * 1024 * 1024);
    expect(maxSaveBytes({ DEV_MCP_SAVE_MAX_MB: "bogus" })).toBe(100 * 1024 * 1024);
    const small = { ...env, DEV_MCP_SAVE_MAX_MB: "0.00001" };
    await expect(saveBytes(path.join(root, "big.txt"), Buffer.alloc(100), { env: small })).rejects.toThrow(/limit/);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses roots escape and symlink/junction escape, and honours DEV_MCP_SAVE_ALLOW_DOT", async () => {
    await expect(saveBytes(path.join(outside, "a.txt"), data, { env })).rejects.toThrow(/outside/);
    await expect(saveBytes(path.join(root, "..", "a.txt"), data, { env })).rejects.toThrow(/outside/);
    const link = path.join(root, "link");
    let linked = true;
    try {
      await symlink(outside, link, "junction");
    } catch {
      linked = false; // symlinks unavailable on this machine
    }
    if (linked) {
      await expect(saveBytes(path.join(link, "a.txt"), data, { env })).rejects.toThrow(/symlink|outside/);
      await expect(saveBytes(link + path.sep, data, { env, fileName: "a.txt" })).rejects.toThrow(/symlink|outside/);
      expect(await readdir(outside)).toEqual([]);
    }
    const dotted = path.join(root, ".factory", "a.txt");
    await saveBytes(dotted, data, { env });
    expect((await readFile(dotted)).toString()).toBe("payload");
  });

  it.skipIf(process.platform === "win32")("uses 0700 dirs and 0600 files", async () => {
    const f = path.join(root, "sub", "a.txt");
    await saveBytes(f, data, { env });
    expect((await lstat(f)).mode & 0o777).toBe(0o600);
    expect((await lstat(path.dirname(f))).mode & 0o777).toBe(0o700);
  });

  it("does not weaken the JSON path: json/png still require their own extension", async () => {
    await expect(saveJson(path.join(root, "a.txt"), {}, { env })).rejects.toThrow(/\.json/);
    await expect(savePngs(path.join(root, "a.jpg"), [{ nodeId: "1:2", data }], { env })).rejects.toThrow(/\.png/);
    const [jpg] = await savePngs(path.join(root, "a.jpg"), [{ nodeId: "1:2", data }], { env, ext: "jpg" });
    expect(jpg!.saved_to).toBe(path.join(root, "a.jpg"));
    await expect(savePngs(path.join(root, "b.png"), [{ nodeId: "1:2", data }], { env, ext: "pdf" })).rejects.toThrow(/\.pdf/);
  });
});

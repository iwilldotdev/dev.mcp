import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type SaveKind = "json" | "png";

export type SaveResult = {
  saved_to: string;
  bytes: number;
  sha256: string;
  kind: SaveKind;
};

export type ImageSaveResult = {
  saved_to: string;
  bytes: number;
  sha256: string;
  mime: string;
};

type Opts = { env?: NodeJS.ProcessEnv; overwrite?: boolean };

const EXT: Record<SaveKind, string> = { json: ".json", png: ".png" };
const DEFAULT_ALLOW_DOT = ".factory";

/** Default root: `<os tmpdir>/dev.mcp` only. DEV_MCP_SAVE_ROOTS overrides it. */
export function defaultRoot(): string {
  return path.join(path.resolve(tmpdir()), "dev.mcp");
}

export function allowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.DEV_MCP_SAVE_ROOTS;
  const list = raw?.trim()
    ? raw.split(path.delimiter).map((s) => s.trim()).filter(Boolean)
    : [defaultRoot()];
  for (const root of list) {
    if (!path.isAbsolute(root)) throw new Error(`DEV_MCP_SAVE_ROOTS entry is not absolute: ${root}`);
  }
  return list.map((r) => path.resolve(r));
}

/** Dot-prefixed segments that stay allowed (DEV_MCP_SAVE_ALLOW_DOT, default ".factory"). */
export function allowedDotSegments(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.DEV_MCP_SAVE_ALLOW_DOT;
  const src = raw === undefined ? DEFAULT_ALLOW_DOT : raw;
  return src
    .split(/[,;:]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (s.startsWith(".") ? s : `.${s}`));
}

function norm(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

function inside(child: string, root: string): boolean {
  const rel = path.relative(norm(root), norm(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function realOfNearestExisting(target: string): Promise<string> {
  let cur = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(cur);
      return path.join(real, ...tail.reverse());
    } catch (err) {
      const parent = path.dirname(cur);
      if (parent === cur) throw err;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

async function realRoots(roots: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const r of roots) {
    out.push(r);
    try {
      out.push(await realOfNearestExisting(r));
    } catch {
      /* unresolvable root */
    }
  }
  return out;
}

/** String-level checks that run before the filesystem is touched. */
function checkRawPath(saveTo: string, env: NodeJS.ProcessEnv): void {
  if (saveTo.indexOf(":", 2) !== -1) {
    throw new Error(`save_to must not contain ':' after the drive letter (alternate data streams): ${saveTo}`);
  }
  for (const seg of saveTo.split(/[\\/]/)) {
    if (!seg || seg === "." || seg === "..") continue;
    if (/[. ]$/.test(seg)) throw new Error(`save_to segment must not end in a dot or space: "${seg}"`);
  }
  const allow = allowedDotSegments(env);
  for (const seg of path.resolve(saveTo).split(/[\\/]/)) {
    if (seg.length > 1 && seg.startsWith(".") && seg !== ".." && !allow.includes(seg.toLowerCase())) {
      throw new Error(
        `save_to must not contain the dot-prefixed segment "${seg}" (config/secret folders are refused; allowlist: DEV_MCP_SAVE_ALLOW_DOT).`,
      );
    }
  }
}

/** Validates a target: absolute, clean segments, inside the roots, no symlink/junction escape. */
export async function resolveSavePath(saveTo: string, opts: Opts = {}): Promise<string> {
  const env = opts.env ?? process.env;
  if (typeof saveTo !== "string" || !saveTo.trim()) throw new Error("save_to is empty.");
  if (!path.isAbsolute(saveTo)) throw new Error(`save_to must be an absolute path: ${saveTo}`);
  checkRawPath(saveTo, env);
  const resolved = path.resolve(saveTo);
  const roots = allowedRoots(env);
  if (!roots.some((r) => inside(resolved, r))) {
    throw new Error(
      `save_to is outside the allowed roots (${roots.join(", ")}). Set DEV_MCP_SAVE_ROOTS to change them.`,
    );
  }
  const real = await realOfNearestExisting(resolved);
  const rroots = await realRoots(roots);
  if (!rroots.some((r) => inside(real, r))) {
    throw new Error(`save_to resolves (symlink/junction) outside the allowed roots: ${real}`);
  }
  return resolved;
}

export function isDirectoryForm(saveTo: string): boolean {
  return /[\\/]$/.test(saveTo);
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function isExistingDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isDirectoryTarget(saveTo: string): Promise<boolean> {
  return isDirectoryForm(saveTo) || isExistingDir(path.resolve(saveTo));
}

async function assertRealInside(dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const real = await realpath(dir);
  const rroots = await realRoots(allowedRoots(env));
  if (!rroots.some((r) => inside(real, r))) {
    throw new Error(`save_to resolves (symlink/junction) outside the allowed roots: ${real}`);
  }
}

function noOverwrite(file: string): Error {
  return new Error(`File already exists: ${file}. Pass overwrite: true to replace it.`);
}

async function atomicWrite(target: string, data: Buffer, opts: Opts): Promise<void> {
  const env = opts.env ?? process.env;
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertRealInside(dir, env); // TOCTOU: parents may have changed since the pre-check
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, data, { flag: "wx", mode: 0o600 });
    await assertRealInside(dir, env);
    if (opts.overwrite) {
      await rename(tmp, target);
    } else {
      try {
        await link(tmp, target); // fails if the target appeared meanwhile
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") throw noOverwrite(target);
        if (await exists(target)) throw noOverwrite(target);
        await rename(tmp, target); // filesystem without hard links
      }
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

function describeFile(data: Buffer, file: string, kind: SaveKind): SaveResult {
  return {
    saved_to: file,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    kind,
  };
}

function checkExt(file: string, kind: SaveKind): void {
  if (path.extname(file).toLowerCase() !== EXT[kind]) {
    throw new Error(`save_to must end in ${EXT[kind]} for this tool: ${file}`);
  }
}

/** Pretty JSON (2 spaces, UTF-8). A string that parses as JSON is re-serialised pretty. */
export function prettyJson(data: unknown): Buffer {
  let value = data;
  if (typeof data === "string") {
    try {
      value = JSON.parse(data);
    } catch {
      value = data;
    }
  }
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function pngPlan(base: string, dir: boolean, nodeIds: string[]): Array<{ nodeId: string; file: string }> {
  if (!nodeIds.length) throw new Error("No images to save.");
  if (!dir) {
    if (nodeIds.length > 1) {
      throw new Error("Several images: save_to must be a directory (existing, or ending in / or \\).");
    }
    return [{ nodeId: nodeIds[0]!, file: base }];
  }
  const plan = nodeIds.map((nodeId) => ({
    nodeId,
    file: path.join(base, `${nodeId.replace(/[^A-Za-z0-9_-]+/g, "-")}.png`),
  }));
  const seen = new Map<string, string>();
  for (const item of plan) {
    const key = norm(item.file);
    const prev = seen.get(key);
    if (prev !== undefined) {
      throw new Error(`Node ids "${prev}" and "${item.nodeId}" map to the same file name: ${path.basename(item.file)}.`);
    }
    seen.set(key, item.nodeId);
  }
  return plan;
}

/**
 * Validates everything that can be checked without the payload (path, roots, extension,
 * file-name collisions, overwrite). Call it before any network fetch. Returns the target files.
 */
export async function precheckSave(
  saveTo: string,
  kind: SaveKind,
  opts: Opts & { nodeIds?: string[] } = {},
): Promise<string[]> {
  const base = await resolveSavePath(saveTo, opts);
  let files: string[];
  if (kind === "json") {
    checkExt(base, "json");
    if (isDirectoryForm(saveTo) || (await isExistingDir(base))) {
      throw new Error(`save_to must be a .json file path, not a directory: ${saveTo}`);
    }
    files = [base];
  } else {
    const dir = await isDirectoryTarget(saveTo);
    files = pngPlan(base, dir, opts.nodeIds ?? ["x"]).map((p) => p.file);
    for (const f of files) {
      checkExt(f, "png");
      await resolveSavePath(f, opts);
    }
  }
  if (!opts.overwrite) {
    for (const f of files) if (await exists(f)) throw noOverwrite(f);
  }
  return files;
}

export async function saveJson(saveTo: string, data: unknown, opts: Opts = {}): Promise<SaveResult> {
  const [file] = await precheckSave(saveTo, "json", opts);
  const buf = prettyJson(data);
  await atomicWrite(file!, buf, opts);
  return describeFile(buf, file!, "json");
}

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** Saves the JSON plus embedded images next to it as `<name>.images/<n>.<ext>`. */
export async function saveJsonWithImages(
  saveTo: string,
  data: unknown,
  images: Array<{ data: Buffer; mime: string }>,
  opts: Opts = {},
): Promise<{ json: SaveResult; images: ImageSaveResult[] }> {
  const [file] = await precheckSave(saveTo, "json", opts);
  const imgDir = path.join(path.dirname(file!), `${path.basename(file!, path.extname(file!))}.images`);
  const plan = images.map((img, i) => ({
    ...img,
    file: path.join(imgDir, `${i + 1}.${IMAGE_EXT[img.mime.toLowerCase()] ?? "bin"}`),
  }));
  for (const item of plan) {
    await resolveSavePath(item.file, opts);
    if (!opts.overwrite && (await exists(item.file))) throw noOverwrite(item.file);
  }
  const written: ImageSaveResult[] = [];
  for (const item of plan) {
    await atomicWrite(item.file, item.data, opts);
    written.push({
      saved_to: item.file,
      bytes: item.data.length,
      sha256: createHash("sha256").update(item.data).digest("hex"),
      mime: item.mime,
    });
  }
  const buf = prettyJson(data);
  await atomicWrite(file!, buf, opts);
  return { json: describeFile(buf, file!, "json"), images: written };
}

/**
 * Saves PNG images. A directory target (or several images) writes `<node-id-dashed>.png`
 * under it; one image with a file target writes that file. Validates everything before writing.
 */
export async function savePngs(
  saveTo: string,
  images: Array<{ nodeId: string; data: Buffer }>,
  opts: Opts = {},
): Promise<SaveResult[]> {
  const files = await precheckSave(saveTo, "png", { ...opts, nodeIds: images.map((i) => i.nodeId) });
  const written: SaveResult[] = [];
  for (let i = 0; i < files.length; i++) {
    await atomicWrite(files[i]!, images[i]!.data, opts);
    written.push(describeFile(images[i]!.data, files[i]!, "png"));
  }
  return written;
}

/** DEV_MCP_SPILL_KB in bytes; 0 when unset, invalid, or 0 (spill disabled). */
export function spillBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.DEV_MCP_SPILL_KB ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n * 1024 : 0;
}

function uidTag(): string {
  return typeof process.getuid === "function" ? String(process.getuid()) : "user";
}

/**
 * Spill folder: DEV_MCP_SPILL_DIR, else `<default root, or the first allowed root>/dev.mcp-spill-<uid>`.
 * Validated against the roots, created 0700, and refused if it is a symlink or owned by someone else.
 */
export async function spillDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const roots = allowedRoots(env);
  const override = env.DEV_MCP_SPILL_DIR?.trim();
  let dir: string;
  if (override) {
    dir = override;
  } else {
    const def = defaultRoot();
    const base = roots.some((r) => inside(def, r)) ? def : roots[0]!;
    dir = path.join(base, `dev.mcp-spill-${uidTag()}`);
  }
  const resolved = await resolveSavePath(dir, { env });
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const st = await lstat(resolved);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`Spill folder is a symlink or not a directory: ${resolved}`);
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`Spill folder is not owned by the current user: ${resolved}`);
  }
  await resolveSavePath(resolved, { env });
  return resolved;
}

/** `<spill dir>/<tool>-<timestamp>-<shorthash>.<ext>` for the given bytes. */
export async function spillFile(
  tool: string,
  data: Buffer,
  ext: "json" | "png",
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 8);
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return path.join(await spillDir(env), `${tool}-${ts}-${hash}.${ext}`);
}

export function spillHint(file: string): string {
  return `Payload exceeded DEV_MCP_SPILL_KB; full content saved to ${file}. Read it with a file tool or pass save_to next time.`;
}

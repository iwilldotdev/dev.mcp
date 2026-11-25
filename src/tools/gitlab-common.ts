import { z, type ZodRawShape, type ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type GitLabClient, encodeProjectId } from "../clients/gitlab.js";
import type { Runtime } from "../runtime.js";
import { registerLegacyAlias, registerWriteTool } from "./register.js";
import { saveToShape, wrapSaveTool, wrapTool } from "./result.js";

export type A = Record<string, any>;
export type Ctx = { server: McpServer; runtime: Runtime; gl: GitLabClient };
export type Summ = (payload: any) => Record<string, unknown>;
export type Fn = (a: A) => Promise<unknown>;

const toSnake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (k: string): string => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Copies legacy camelCase arguments onto their snake_case name (the official spelling wins when both are given). */
export function norm(args: A): A {
  const out: A = { ...args };
  for (const [k, v] of Object.entries(args)) {
    const s = toSnake(k);
    if (s !== k && out[s] === undefined) out[s] = v;
  }
  return out;
}

/** Adds an optional, deprecated camelCase twin for every snake_case key of an existing tool's shape. */
export function dual(shape: ZodRawShape, skip: string[] = []): ZodRawShape {
  const out: ZodRawShape = { ...shape };
  for (const [k, v] of Object.entries(shape)) {
    const c = toCamel(k);
    if (c === k || skip.includes(k) || c in shape) continue;
    out[c] = (v as ZodTypeAny).optional().describe(`Deprecated: use ${k}.`);
  }
  return out;
}

export function need<T>(v: T | undefined | null, label: string): T {
  if (v === undefined || v === null || v === "") throw new Error(`Missing required parameter: ${label}.`);
  return v;
}

export const idType = z.union([z.string(), z.number()]);
export const posInt = z.number().int().positive();

export const PROJ = {
  project_id: idType.optional().describe("Numeric ID or path with namespace, e.g. group/project."),
};
export const PROJ_ID = {
  id: idType.optional().describe("Project ID or path (official name on CI and repository tools). Same as project_id."),
  ...PROJ,
};
export const GROUP = { group_id: idType.optional().describe("Numeric ID or path of a group.") };

/** Encoded project reference from project_id / id (legacy projectId is copied by norm). */
export function proj(a: A): string {
  return encodeProjectId(need(arg2(a.project_id, a.id), "project_id (legacy: projectId)"));
}

/** `groups/:id` when group_id is given, otherwise `projects/:id`. */
export function scope(a: A): string {
  if (a.group_id !== undefined && a.group_id !== null) return `groups/${encodeProjectId(a.group_id)}`;
  const id = arg2(a.project_id, a.id);
  if (id === undefined) throw new Error("Missing required parameter: project_id or group_id.");
  return `projects/${encodeProjectId(id)}`;
}

function arg2<T>(...v: Array<T | undefined | null>): T | undefined {
  for (const x of v) if (x !== undefined && x !== null && x !== "") return x;
  return undefined;
}

export function parseGitLabUrl(url: string): { project: string; type: string; iid: number } {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    throw new Error(`Invalid url: ${url}`);
  }
  const m = path.replace(/^\/+/, "").match(/^(.+?)\/-\/(merge_requests|issues|work_items)\/(\d+)/);
  if (!m) throw new Error(`Cannot find a project and iid in url: ${url}`);
  return { project: m[1]!, type: m[2]!, iid: Number(m[3]) };
}

// ---- cursor pagination over REST page/per_page ----

export const PAGE = {
  first: z.number().int().min(1).max(100).optional().describe("Page size (max 100). Default 20."),
  after: z
    .string()
    .optional()
    .describe("Cursor: pass the next_cursor of the previous response to get the next page."),
};
const PAGE_NOTE =
  " Pagination: first = page size, after = cursor; the response is {items, next_cursor, has_next_page} and next_cursor (a synthetic cursor over REST pages) is null on the last page.";

export function pageDesc(desc: string): string {
  return `${desc}${PAGE_NOTE}`;
}

function currentPage(a: A): number {
  if (!a.after) return a.page ?? 1;
  try {
    const p = JSON.parse(Buffer.from(String(a.after), "base64url").toString("utf8")).page;
    if (Number.isInteger(p) && p >= 1) return p;
  } catch {
    /* fall through */
  }
  throw new Error("Invalid cursor: pass the next_cursor value returned by the previous call.");
}

export function pageQuery(a: A, defaultSize?: number): { per_page?: number; page?: number } {
  const size = arg2(a.first, a.per_page) ?? defaultSize;
  const page = currentPage(a);
  return { per_page: size, page: page === 1 && a.after === undefined && a.page === undefined ? undefined : page };
}

/** Wraps a list as {items, next_cursor}. `legacy` lists stay plain arrays unless first/after was used. */
export function pageResult(a: A, data: unknown, legacy = false, defaultSize = 20): unknown {
  if (!Array.isArray(data)) return data;
  if (legacy && a.first === undefined && a.after === undefined) return data;
  const size = arg2(a.first, a.per_page) ?? defaultSize;
  const next = data.length >= size ? Buffer.from(JSON.stringify({ page: currentPage(a) + 1 })).toString("base64url") : null;
  return { items: data, next_cursor: next, has_next_page: next !== null };
}

// ---- summaries ----

export function pick(o: any, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (o && typeof o === "object") for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

export function sumList(fields: string[]): Summ {
  return (p) => {
    const list: any[] = Array.isArray(p) ? p : Array.isArray(p?.items) ? p.items : [];
    return {
      count: list.length,
      items: list.slice(0, 20).map((i) => pick(i, fields)),
      ...(p && !Array.isArray(p) && p.next_cursor !== undefined ? { next_cursor: p.next_cursor } : {}),
    };
  };
}

export const sumObj = (fields: string[]): Summ => (p) => pick(p, fields);

// ---- registration helpers ----

export function readTool(c: Ctx, name: string, desc: string, shape: ZodRawShape, summ: Summ, fn: Fn): void {
  c.server.tool(
    name,
    `${desc} For large payloads pass save_to (absolute path); the response becomes a compact summary.`,
    { ...shape, ...saveToShape },
    wrapSaveTool(name, summ, async (args: any) => fn(norm(args))),
  );
}

export function writeTool(c: Ctx, name: string, desc: string, shape: ZodRawShape, fn: Fn): void {
  c.server.tool(name, desc, shape, wrapTool(async (args: any) => fn(norm(args))));
}

/** Write tool added in 1.3.0: registered only with DEV_MCP_PARITY_WRITES=1 (see registerWriteTool). */
export function parityWriteTool(c: Ctx, name: string, desc: string, shape: ZodRawShape, fn: Fn): void {
  registerWriteTool(c.server, c.runtime, name, desc, shape, wrapTool(async (args: any) => fn(norm(args))));
}

/** Legacy alias with its old schema; `fn` receives the old (normalised) args and calls the canonical implementation. */
export function aliasRead(c: Ctx, canonical: string, name: string, shape: ZodRawShape, summ: Summ, fn: Fn): void {
  registerLegacyAlias(c.server, c.runtime, canonical, {
    name,
    shape,
    handler: wrapSaveTool(name, summ, async (args: any) => fn(norm(args))),
  });
}

export function aliasWrite(c: Ctx, canonical: string, name: string, shape: ZodRawShape, fn: Fn): void {
  registerLegacyAlias(c.server, c.runtime, canonical, {
    name,
    shape,
    handler: wrapTool(async (args: any) => fn(norm(args))),
  });
}

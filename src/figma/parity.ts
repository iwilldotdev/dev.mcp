import { parseFigmaNodeIds } from "./parse.js";

/** Merges the official singular `nodeId` with `nodeIds`; both accept "1:2" or "1-2". */
export function mergeNodeIds(
  nodeIds?: string | string[] | null,
  nodeId?: string | null,
): string[] | undefined {
  const a = parseFigmaNodeIds(nodeIds) ?? [];
  const b = parseFigmaNodeIds(nodeId) ?? [];
  const out = [...a, ...b.filter((id) => !a.includes(id))];
  return out.length ? out : undefined;
}

export type NodeUsage = {
  variableIds: Map<string, Set<string>>;
  styles: Map<string, { kinds: Set<string>; nodes: Set<string> }>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function collectAliasIds(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const v of value) collectAliasIds(v, out);
  } else if (isRecord(value)) {
    if (typeof value.id === "string") out.push(value.id);
    else for (const v of Object.values(value)) collectAliasIds(v, out);
  }
}

/** Walks a node subtree and collects bound variable ids and style ids, with the nodes that use them. */
export function collectUsage(root: unknown, usage?: NodeUsage): NodeUsage {
  const found: NodeUsage = usage ?? { variableIds: new Map(), styles: new Map() };
  const walk = (value: unknown, owner: string): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v, owner);
      return;
    }
    if (!isRecord(value)) return;
    const here = typeof value.id === "string" && typeof value.type === "string" ? value.id : owner;
    for (const [key, v] of Object.entries(value)) {
      if (key === "boundVariables") {
        const ids: string[] = [];
        collectAliasIds(v, ids);
        for (const id of ids) {
          if (!found.variableIds.has(id)) found.variableIds.set(id, new Set());
          found.variableIds.get(id)!.add(here);
        }
      } else if (key === "styles" && isRecord(v) && Object.values(v).every((x) => typeof x === "string")) {
        for (const [kind, id] of Object.entries(v as Record<string, string>)) {
          const entry = found.styles.get(id) ?? { kinds: new Set<string>(), nodes: new Set<string>() };
          entry.kinds.add(kind);
          entry.nodes.add(here);
          found.styles.set(id, entry);
        }
      } else {
        walk(v, here);
      }
    }
  };
  walk(root, "");
  return found;
}

type Rec = Record<string, unknown>;

/** Picks the local variables (and their collections) whose ids were used. */
export function scopeVariables(
  local: { variables: Rec; variableCollections: Rec } | undefined,
  usage: NodeUsage,
): { variables: Rec; variableCollections: Rec; unresolved: string[] } {
  const variables: Rec = {};
  const variableCollections: Rec = {};
  const unresolved: string[] = [];
  for (const id of usage.variableIds.keys()) {
    const found = local?.variables?.[id];
    if (!found) {
      unresolved.push(id);
      continue;
    }
    variables[id] = found;
    const collectionId = (found as { variableCollectionId?: string }).variableCollectionId;
    if (collectionId && local?.variableCollections?.[collectionId]) {
      variableCollections[collectionId] = local.variableCollections[collectionId];
    }
  }
  return { variables, variableCollections, unresolved };
}

export type FigmaComment = {
  id?: string;
  message?: string;
  parent_id?: string;
  resolved_at?: string | null;
  user?: { handle?: string; id?: string };
  client_meta?: { node_id?: string } | null;
  mentions?: unknown[];
  [key: string]: unknown;
};

export type CommentFilters = {
  resolved?: boolean;
  author?: string;
  mention?: string;
  /** Node ids that belong to the requested page(s). */
  pageNodeIds?: Set<string>;
};

function root(c: FigmaComment, byId: Map<string, FigmaComment>): FigmaComment {
  let cur = c;
  for (let i = 0; i < 20 && cur.parent_id && byId.get(cur.parent_id); i++) cur = byId.get(cur.parent_id)!;
  return cur;
}

function mentionsOf(c: FigmaComment, needle: string): boolean {
  const n = needle.replace(/^@/, "").toLowerCase();
  if ((c.message ?? "").toLowerCase().includes(`@${n}`)) return true;
  return (c.mentions ?? []).some((m) => {
    if (typeof m === "string") return m.toLowerCase() === n;
    if (isRecord(m)) return [m.handle, m.id, m.name].some((x) => typeof x === "string" && x.toLowerCase() === n);
    return false;
  });
}

/** Local filters for `figma_get_comments`. Replies follow their thread root for `resolved` and `page`. */
export function filterComments(comments: FigmaComment[], f: CommentFilters): FigmaComment[] {
  const byId = new Map(comments.filter((c) => c.id).map((c) => [c.id!, c]));
  return comments.filter((c) => {
    const top = root(c, byId);
    if (f.resolved !== undefined && Boolean(top.resolved_at) !== f.resolved) return false;
    if (f.author) {
      const a = f.author.replace(/^@/, "").toLowerCase();
      if (c.user?.handle?.toLowerCase() !== a && c.user?.id?.toLowerCase() !== a) return false;
    }
    if (f.mention && !mentionsOf(c, f.mention)) return false;
    if (f.pageNodeIds) {
      const node = top.client_meta?.node_id;
      if (!node || !f.pageNodeIds.has(node)) return false;
    }
    return true;
  });
}

export function collectIds(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (!isRecord(node)) return out;
  if (typeof node.id === "string") out.add(node.id);
  if (Array.isArray(node.children)) for (const c of node.children) collectIds(c, out);
  return out;
}

/** FigJam text lives in `characters` (text) or `text.characters` (stickies, shapes). */
export function figjamText(node: unknown): string | undefined {
  if (!isRecord(node)) return undefined;
  if (typeof node.characters === "string" && node.characters) return node.characters;
  const t = node.text;
  if (isRecord(t) && typeof t.characters === "string" && t.characters) return t.characters;
  return undefined;
}

export function collectFigjamTexts(
  node: unknown,
  out: Array<{ id: string; type: string; text: string }> = [],
): Array<{ id: string; type: string; text: string }> {
  if (!isRecord(node)) return out;
  const text = figjamText(node);
  if (text && typeof node.id === "string") out.push({ id: node.id, type: String(node.type ?? ""), text });
  if (Array.isArray(node.children)) for (const c of node.children) collectFigjamTexts(c, out);
  return out;
}

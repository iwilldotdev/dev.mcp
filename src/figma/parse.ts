export function parseFigmaFileKey(input: string): string {
  const match = input.match(
    /figma\.com\/(?:file|design|proto|board|slides|make)\/([a-zA-Z0-9]+)/i,
  );
  return match?.[1] ?? input.trim();
}

export function parseFigmaNodeIds(
  input?: string | string[] | null,
): string[] | undefined {
  if (input == null) return undefined;
  const raw = Array.isArray(input) ? input : input.split(/[,\s]+/);
  const ids = raw
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => id.replace(/-/g, ":"));
  return ids.length ? ids : undefined;
}

export function parseFigmaUrl(input: string): {
  fileKey: string;
  nodeIds?: string[];
} {
  const fileKey = parseFigmaFileKey(input);
  try {
    const url = new URL(input);
    const nodeParam = url.searchParams.get("node-id") ?? url.searchParams.get("node_id");
    return { fileKey, nodeIds: parseFigmaNodeIds(nodeParam ?? undefined) };
  } catch {
    return { fileKey };
  }
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export type FigmaNode = {
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  layoutMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  fills?: unknown[];
  strokes?: unknown[];
  strokeWeight?: number;
  characters?: string;
  style?: {
    fontFamily?: string;
    fontSize?: number;
    fontWeight?: number;
    lineHeightPx?: number;
    letterSpacing?: number;
  };
  componentId?: string;
  styles?: Record<string, string>;
  children?: FigmaNode[];
  [key: string]: unknown;
};

export function nodeToXml(node: FigmaNode, indent = 0): string {
  const pad = "  ".repeat(indent);
  const attrs = [
    `id="${escapeXml(node.id)}"`,
    `name="${escapeXml(node.name ?? "")}"`,
    `type="${escapeXml(node.type)}"`,
  ];
  if (node.absoluteBoundingBox) {
    attrs.push(`x="${round(node.absoluteBoundingBox.x)}"`);
    attrs.push(`y="${round(node.absoluteBoundingBox.y)}"`);
    attrs.push(`width="${round(node.absoluteBoundingBox.width)}"`);
    attrs.push(`height="${round(node.absoluteBoundingBox.height)}"`);
  }
  const children = node.children ?? [];
  if (!children.length) {
    return `${pad}<node ${attrs.join(" ")} />`;
  }
  const inner = children.map((child) => nodeToXml(child, indent + 1)).join("\n");
  return `${pad}<node ${attrs.join(" ")}>\n${inner}\n${pad}</node>`;
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export type DesignContextNode = {
  id: string;
  name: string;
  type: string;
  size?: { width: number; height: number };
  position?: { x: number; y: number };
  layout?: Record<string, unknown>;
  fills?: unknown;
  strokes?: unknown;
  text?: Record<string, unknown>;
  componentId?: string;
  styles?: Record<string, string>;
  children?: DesignContextNode[];
};

export function toDesignContextNode(node: FigmaNode, depth = 0, maxDepth = 8): DesignContextNode {
  const box = node.absoluteBoundingBox;
  const layout: Record<string, unknown> = {};
  if (node.layoutMode) layout.mode = node.layoutMode;
  if (node.itemSpacing != null) layout.gap = node.itemSpacing;
  if (
    node.paddingLeft != null ||
    node.paddingRight != null ||
    node.paddingTop != null ||
    node.paddingBottom != null
  ) {
    layout.padding = {
      top: node.paddingTop ?? 0,
      right: node.paddingRight ?? 0,
      bottom: node.paddingBottom ?? 0,
      left: node.paddingLeft ?? 0,
    };
  }
  if (node.primaryAxisAlignItems) layout.primaryAxisAlign = node.primaryAxisAlignItems;
  if (node.counterAxisAlignItems) layout.counterAxisAlign = node.counterAxisAlignItems;

  const text =
    node.characters || node.style
      ? {
          characters: node.characters,
          fontFamily: node.style?.fontFamily,
          fontSize: node.style?.fontSize,
          fontWeight: node.style?.fontWeight,
          lineHeightPx: node.style?.lineHeightPx,
          letterSpacing: node.style?.letterSpacing,
        }
      : undefined;

  const children =
    depth < maxDepth
      ? node.children?.map((child) => toDesignContextNode(child, depth + 1, maxDepth))
      : undefined;

  return {
    id: node.id,
    name: node.name,
    type: node.type,
    size: box ? { width: box.width, height: box.height } : undefined,
    position: box ? { x: box.x, y: box.y } : undefined,
    layout: Object.keys(layout).length ? layout : undefined,
    fills: node.fills,
    strokes: node.strokes,
    text,
    componentId: node.componentId,
    styles: node.styles,
    children,
  };
}

export function summarizeVariables(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const data = payload as {
    meta?: { variables?: Record<string, unknown>; variableCollections?: Record<string, unknown> };
    variables?: Record<string, unknown>;
    variableCollections?: Record<string, unknown>;
  };
  return {
    variables: data.meta?.variables ?? data.variables ?? {},
    variableCollections: data.meta?.variableCollections ?? data.variableCollections ?? {},
  };
}

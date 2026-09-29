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
  visible?: boolean;
  isMask?: boolean;
  /** REST mask operation. `ALPHA`, `VECTOR`, and `LUMINANCE` clip differently. */
  maskType?: string;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  layoutMode?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  layoutPositioning?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  constraints?: { horizontal?: string; vertical?: string };
  /** The REST docs do not state the unit. */
  rotation?: number;
  layoutGrow?: number;
  layoutAlign?: string;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  layoutWrap?: string;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  strokesIncludedInLayout?: boolean;
  counterAxisSpacing?: number;
  counterAxisAlignContent?: string;
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  opacity?: number;
  blendMode?: string;
  clipsContent?: boolean;
  fills?: unknown[];
  strokes?: unknown[];
  strokeWeight?: number;
  strokeAlign?: string;
  individualStrokeWeights?: { top?: number; right?: number; bottom?: number; left?: number };
  effects?: unknown[];
  boundVariables?: Record<string, unknown>;
  characters?: string;
  style?: {
    fontFamily?: string;
    fontStyle?: string;
    italic?: boolean;
    fontSize?: number;
    fontWeight?: number;
    lineHeightPx?: number;
    lineHeightPercentFontSize?: number;
    lineHeightUnit?: string;
    letterSpacing?: number;
    textAlignHorizontal?: string;
    textAlignVertical?: string;
    textDecoration?: string;
    textCase?: string;
    textAutoResize?: string;
    textTruncation?: string;
    maxLines?: number;
    paragraphSpacing?: number;
    paragraphIndent?: number;
    boundVariables?: Record<string, unknown>;
  };
  characterStyleOverrides?: number[];
  styleOverrideTable?: Record<string, unknown>;
  componentId?: string;
  componentProperties?: Record<string, unknown>;
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

export type DesignContextBoundVariable =
  | string
  | DesignContextBoundVariable[]
  | { [key: string]: DesignContextBoundVariable };

export type DesignContextVisual = {
  sizing?: { horizontal?: string; vertical?: string };
  positioning?: string;
  constraints?: { horizontal?: string; vertical?: string };
  /** REST `rotation` as returned; the REST docs do not state the unit. Absent when not rotated. */
  rotation?: number;
  radius?: number | number[];
  opacity?: number;
  blendMode?: string;
  clipsContent?: boolean;
  stroke?: {
    weight?: number;
    align?: string;
    individual?: { top?: number; right?: number; bottom?: number; left?: number };
  };
  effects?: Record<string, unknown>[];
  boundVariables?: Record<string, DesignContextBoundVariable>;
};

export type DesignContextNode = {
  id: string;
  name: string;
  type: string;
  /** Present only when the layer is hidden; its whole subtree is not rendered. */
  visible?: false;
  isMask?: true;
  /** Present with `isMask`. REST `maskType`, passed through. */
  maskType?: string;
  size?: { width: number; height: number };
  position?: { x: number; y: number };
  layout?: Record<string, unknown>;
  visual?: DesignContextVisual;
  fills?: unknown;
  strokes?: unknown;
  text?: Record<string, unknown>;
  componentId?: string;
  component?: { name?: string; key?: string; set?: string };
  componentProperties?: Record<string, unknown>;
  styles?: Record<string, string>;
  styleNames?: Record<string, string>;
  children?: DesignContextNode[];
  childrenTruncated?: boolean;
};

export type DesignContextRefs = {
  components?: Record<string, { key?: string; name?: string; componentSetId?: string }>;
  componentSets?: Record<string, { key?: string; name?: string }>;
  styles?: Record<string, { key?: string; name?: string; styleType?: string }>;
};

export type DesignContextOptions = {
  /** Levels of children kept below the root; a node cut there sets `childrenTruncated`. */
  maxDepth?: number;
  /** Stop after this many nodes, including the roots. Omit for no node cap. */
  maxNodes?: number;
  /** Stop when another node's own JSON would exceed this budget. Omit for no byte cap. */
  maxBytes?: number;
  /** `components`, `componentSets`, and `styles` maps from the REST response. */
  refs?: DesignContextRefs;
};

/** Default subtree cap for `figma_get_design_context`. */
export const DESIGN_CONTEXT_NODE_LIMIT = 400;
/** Default cap for `figma_get_design_context`, in UTF-8 bytes of compact JSON. */
export const DESIGN_CONTEXT_BYTE_LIMIT = 750_000;

export function jsonUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export type DesignContextTree = {
  nodes: DesignContextNode[];
  nodeLimitHit: boolean;
  byteLimitHit: boolean;
};

type ContextBudget = {
  nodesLeft: number;
  bytesLeft: number;
  nodeHit: boolean;
  byteHit: boolean;
};

export function toDesignContextNode(
  node: FigmaNode,
  options: DesignContextOptions = {},
): DesignContextNode {
  return toDesignContextNodes([node], options).nodes[0];
}

export function toDesignContextNodes(
  nodes: FigmaNode[],
  options: DesignContextOptions = {},
): DesignContextTree {
  const budget: ContextBudget = {
    nodesLeft: options.maxNodes ?? Number.POSITIVE_INFINITY,
    bytesLeft: options.maxBytes ?? Number.POSITIVE_INFINITY,
    nodeHit: false,
    byteHit: false,
  };
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const refs = options.refs ?? {};
  const out: DesignContextNode[] = [];
  for (const node of nodes) {
    if (budget.nodesLeft <= 0) {
      budget.nodeHit = true;
      break;
    }
    if (budget.bytesLeft <= 0) {
      budget.byteHit = true;
      break;
    }
    out.push(contextNode(node, 0, maxDepth, refs, budget));
  }
  return { nodes: out, nodeLimitHit: budget.nodeHit, byteLimitHit: budget.byteHit };
}

export function hasTruncatedChildren(node: DesignContextNode): boolean {
  if (node.childrenTruncated) return true;
  return (node.children ?? []).some(hasTruncatedChildren);
}

function ownByteSize(node: FigmaNode): number {
  const { children: _children, ...rest } = node;
  return jsonUtf8Bytes(rest);
}

function slimFigmaNode(node: FigmaNode): FigmaNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    isMask: node.isMask,
    maskType: typeof node.maskType === "string" ? node.maskType : undefined,
  };
}

function contextNode(
  node: FigmaNode,
  depth: number,
  maxDepth: number,
  refs: DesignContextRefs,
  budget: ContextBudget,
): DesignContextNode {
  const own = ownByteSize(node);
  const bodyCut = own > budget.bytesLeft;
  const body = bodyCut ? slimFigmaNode(node) : node;
  if (bodyCut) budget.byteHit = true;
  budget.nodesLeft -= 1;
  budget.bytesLeft -= ownByteSize(body);

  const box = body.absoluteBoundingBox;
  const layout: Record<string, unknown> = {};
  if (body.layoutMode) layout.mode = body.layoutMode;
  if (body.itemSpacing != null) layout.gap = body.itemSpacing;
  if (
    body.paddingLeft != null ||
    body.paddingRight != null ||
    body.paddingTop != null ||
    body.paddingBottom != null
  ) {
    layout.padding = {
      top: body.paddingTop ?? 0,
      right: body.paddingRight ?? 0,
      bottom: body.paddingBottom ?? 0,
      left: body.paddingLeft ?? 0,
    };
  }
  if (body.primaryAxisAlignItems) layout.primaryAxisAlign = body.primaryAxisAlignItems;
  if (body.counterAxisAlignItems) layout.counterAxisAlign = body.counterAxisAlignItems;
  for (const key of [
    "layoutGrow",
    "layoutAlign",
    "minWidth",
    "maxWidth",
    "minHeight",
    "maxHeight",
    "layoutWrap",
    "primaryAxisSizingMode",
    "counterAxisSizingMode",
    "strokesIncludedInLayout",
    "counterAxisSpacing",
    "counterAxisAlignContent",
  ] as const) {
    if (body[key] != null) layout[key] = body[key];
  }

  const text = toText(body);
  const visual = toVisual(body);

  const nested = node.children ?? [];
  const depthCut = nested.length > 0 && depth >= maxDepth;
  let childCut = false;
  const kept: DesignContextNode[] = [];
  if (!depthCut && !bodyCut) {
    for (const child of nested) {
      if (budget.nodesLeft <= 0) {
        budget.nodeHit = true;
        childCut = true;
        break;
      }
      if (budget.bytesLeft <= 0) {
        budget.byteHit = true;
        childCut = true;
        break;
      }
      kept.push(contextNode(child, depth + 1, maxDepth, refs, budget));
    }
    if (kept.length < nested.length) childCut = true;
  }
  const childrenTruncated = depthCut || bodyCut || childCut;
  const children = kept.length ? kept : undefined;
  const properties = body.componentProperties;
  const maskType =
    body.isMask === true && typeof body.maskType === "string" && body.maskType
      ? body.maskType
      : undefined;

  return {
    id: body.id,
    name: body.name,
    type: body.type,
    visible: body.visible === false ? false : undefined,
    isMask: body.isMask === true ? true : undefined,
    maskType,
    size: box ? { width: box.width, height: box.height } : undefined,
    position: box ? { x: box.x, y: box.y } : undefined,
    layout: Object.keys(layout).length ? layout : undefined,
    visual,
    fills: body.fills,
    strokes: body.strokes,
    text,
    componentId: body.componentId,
    component: toComponent(body.componentId, refs),
    componentProperties: properties && Object.keys(properties).length ? properties : undefined,
    styles: body.styles,
    styleNames: toStyleNames(body.styles, refs),
    children: children?.length ? children : undefined,
    childrenTruncated: childrenTruncated || undefined,
  };
}

function toComponent(
  componentId: string | undefined,
  refs: DesignContextRefs,
): DesignContextNode["component"] {
  const meta = componentId ? refs.components?.[componentId] : undefined;
  if (!meta) return undefined;
  const out: NonNullable<DesignContextNode["component"]> = {};
  if (meta.name) out.name = meta.name;
  if (meta.key) out.key = meta.key;
  const set = meta.componentSetId ? refs.componentSets?.[meta.componentSetId]?.name : undefined;
  if (set) out.set = set;
  return Object.keys(out).length ? out : undefined;
}

function toStyleNames(
  styles: Record<string, string> | undefined,
  refs: DesignContextRefs,
): Record<string, string> | undefined {
  if (!styles) return undefined;
  const out: Record<string, string> = {};
  for (const [kind, id] of Object.entries(styles)) {
    const name = refs.styles?.[id]?.name;
    if (name) out[kind] = name;
  }
  return Object.keys(out).length ? out : undefined;
}

function toText(node: FigmaNode): Record<string, unknown> | undefined {
  const style = node.style;
  if (!node.characters && !style) return undefined;
  const text: Record<string, unknown> = {};
  if (node.characters) text.characters = node.characters;
  if (style?.fontFamily) text.fontFamily = style.fontFamily;
  if (style?.fontStyle) text.fontStyle = style.fontStyle;
  if (typeof style?.italic === "boolean") text.italic = style.italic;
  if (style?.fontSize != null) text.fontSize = style.fontSize;
  if (style?.fontWeight != null) text.fontWeight = style.fontWeight;
  if (style?.lineHeightPx != null) text.lineHeightPx = style.lineHeightPx;
  if (style?.lineHeightPercentFontSize != null) {
    text.lineHeightPercentFontSize = style.lineHeightPercentFontSize;
  }
  if (style?.lineHeightUnit) text.lineHeightUnit = style.lineHeightUnit;
  if (style?.letterSpacing != null) text.letterSpacing = style.letterSpacing;
  if (style?.textAlignHorizontal) text.align = style.textAlignHorizontal;
  if (style?.textAlignVertical) text.alignVertical = style.textAlignVertical;
  if (style?.textDecoration) text.decoration = style.textDecoration;
  if (style?.textCase) text.case = style.textCase;
  if (style?.textAutoResize) text.autoResize = style.textAutoResize;
  if (style?.textTruncation) text.truncation = style.textTruncation;
  if (typeof style?.maxLines === "number") text.maxLines = style.maxLines;
  if (style?.paragraphSpacing != null) text.paragraphSpacing = style.paragraphSpacing;
  if (style?.paragraphIndent != null) text.paragraphIndent = style.paragraphIndent;
  const styleVariables = summarizeBoundVariables(style?.boundVariables);
  if (styleVariables) text.boundVariables = styleVariables;
  if (node.characterStyleOverrides?.length) {
    text.characterStyleOverrides = node.characterStyleOverrides;
  }
  if (node.styleOverrideTable && Object.keys(node.styleOverrideTable).length) {
    text.styleOverrideTable = node.styleOverrideTable;
  }
  return Object.keys(text).length ? text : undefined;
}

function toVisual(node: FigmaNode): DesignContextVisual | undefined {
  const visual: DesignContextVisual = {};
  if (node.layoutSizingHorizontal || node.layoutSizingVertical) {
    const sizing: { horizontal?: string; vertical?: string } = {};
    if (node.layoutSizingHorizontal) sizing.horizontal = node.layoutSizingHorizontal;
    if (node.layoutSizingVertical) sizing.vertical = node.layoutSizingVertical;
    visual.sizing = sizing;
  }
  if (node.layoutPositioning) visual.positioning = node.layoutPositioning;
  if (node.constraints?.horizontal || node.constraints?.vertical) {
    visual.constraints = {
      horizontal: node.constraints.horizontal,
      vertical: node.constraints.vertical,
    };
  }
  if (typeof node.rotation === "number" && node.rotation !== 0) {
    visual.rotation = node.rotation;
  }
  if (Array.isArray(node.rectangleCornerRadii) && node.rectangleCornerRadii.length) {
    visual.radius = node.rectangleCornerRadii;
  } else if (typeof node.cornerRadius === "number") {
    visual.radius = node.cornerRadius;
  }
  if (typeof node.opacity === "number") visual.opacity = node.opacity;
  if (node.blendMode && node.blendMode !== "NORMAL" && node.blendMode !== "PASS_THROUGH") {
    visual.blendMode = node.blendMode;
  }
  if (typeof node.clipsContent === "boolean") visual.clipsContent = node.clipsContent;

  const stroke: NonNullable<DesignContextVisual["stroke"]> = {};
  if (typeof node.strokeWeight === "number") stroke.weight = node.strokeWeight;
  if (node.strokeAlign) stroke.align = node.strokeAlign;
  const individual = numericSides(node.individualStrokeWeights);
  if (individual) stroke.individual = individual;
  if (Object.keys(stroke).length) visual.stroke = stroke;

  const effects = summarizeEffects(node.effects);
  if (effects) visual.effects = effects;
  const boundVariables = summarizeBoundVariables(node.boundVariables);
  if (boundVariables) visual.boundVariables = boundVariables;

  return Object.keys(visual).length ? visual : undefined;
}

function numericSides(
  raw: FigmaNode["individualStrokeWeights"],
): { top?: number; right?: number; bottom?: number; left?: number } | undefined {
  if (!raw) return undefined;
  const out: { top?: number; right?: number; bottom?: number; left?: number } = {};
  for (const side of ["top", "right", "bottom", "left"] as const) {
    if (typeof raw[side] === "number") out[side] = raw[side];
  }
  return Object.keys(out).length ? out : undefined;
}

function summarizeEffects(effects: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(effects)) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const raw of effects) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const effect = { ...(raw as Record<string, unknown>) };
    const boundVariables = summarizeBoundVariables(effect.boundVariables);
    if (boundVariables) effect.boundVariables = boundVariables;
    else delete effect.boundVariables;
    out.push(effect);
  }
  return out.length ? out : undefined;
}

function summarizeBoundVariables(
  raw: unknown,
): Record<string, DesignContextBoundVariable> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, DesignContextBoundVariable> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = normalizeBoundVariable(value);
    if (normalized !== undefined) out[key] = normalized;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeBoundVariable(
  value: unknown,
): DesignContextBoundVariable | undefined {
  if (Array.isArray(value)) {
    const values = value
      .map(normalizeBoundVariable)
      .filter(
        (item): item is DesignContextBoundVariable => item !== undefined,
      );
    return values.length ? values : undefined;
  }
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  }
  if (value && typeof value === "object") {
    const nested: Record<string, DesignContextBoundVariable> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeBoundVariable(item);
      if (normalized !== undefined) nested[key] = normalized;
    }
    return Object.keys(nested).length ? nested : undefined;
  }
  return undefined;
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

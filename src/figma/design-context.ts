import type {
  FigmaFileResponse,
  FigmaImagesResponse,
  FigmaNodesResponse,
} from "../clients/figma.js";
import { errorMessage } from "../errors.js";
import {
  DESIGN_CONTEXT_BYTE_LIMIT,
  DESIGN_CONTEXT_NODE_LIMIT,
  hasTruncatedChildren,
  jsonUtf8Bytes,
  nodeToXml,
  summarizeVariables,
  toDesignContextNodes,
  type DesignContextNode,
  type DesignContextRefs,
  type FigmaNode,
} from "./parse.js";

export const DESIGN_CONTEXT_TRUNCATION_HINT =
  "Pass depth or a child node id to fetch the next level.";
/** Cap on the actionable list of node ids whose children were cut. */
const NEXT_CHILD_IDS_LIMIT = 50;

export type DesignContextSource = {
  getNodes(
    fileKey: string,
    ids: string[],
    params?: { depth?: number },
  ): Promise<FigmaNodesResponse>;
  getFile(fileKey: string, params?: { depth?: number }): Promise<FigmaFileResponse>;
  getLocalVariables(fileKey: string): Promise<unknown>;
  getImages(
    fileKey: string,
    ids: string[],
    params?: { format?: "jpg" | "png" | "svg" | "pdf"; scale?: number },
  ): Promise<FigmaImagesResponse>;
};

export type DesignContextRequest = {
  fileKey: string;
  nodeIds?: string[];
  depth?: number;
  includeScreenshot?: boolean;
  includeVariables?: boolean;
  includeMetadataXml?: boolean;
  /** Emit only these blocks per node (`layout`, `visual`, `fills`, `strokes`, `text`, `component`). */
  fields?: string[];
  /** Defaults to the design-context node and byte caps. */
  limits?: { maxNodes: number; maxBytes: number };
};

export type DesignContextPayload = {
  fileKey: string;
  name?: string;
  /** REST file revision at fetch time; a pack consumer compares it to detect staleness. */
  lastModified?: string;
  note: string;
  truncated: boolean;
  truncation?: {
    reasons: string[];
    hint: string;
    /** Node ids whose children were cut; refetch these ids to continue. */
    nextChildIds?: string[];
  };
  metadataXml?: string;
  nodes: DesignContextNode[];
  variables?: unknown;
  screenshots?: Record<string, string | null>;
  warnings: string[];
  missingNodeIds?: string[];
  nodeErrors?: Record<string, string>;
};

const NOTE =
  "Context derived from the REST API; does not include Figma MCP proprietary codegen.";

export async function buildDesignContext(
  source: DesignContextSource,
  request: DesignContextRequest,
): Promise<DesignContextPayload> {
  const limits = request.limits ?? {
    maxNodes: DESIGN_CONTEXT_NODE_LIMIT,
    maxBytes: DESIGN_CONTEXT_BYTE_LIMIT,
  };
  const includeScreenshot = request.includeScreenshot !== false;
  const includeVariables = request.includeVariables === true;
  const nodeIds = request.nodeIds?.length ? request.nodeIds : undefined;

  let rawNodes: FigmaNode[] = [];
  let fileName: string | undefined;
  let lastModified: string | undefined;
  const refs: Required<DesignContextRefs> = { components: {}, componentSets: {}, styles: {} };
  const missingNodeIds: string[] = [];
  const nodeErrors: Record<string, string> = {};

  if (nodeIds) {
    const payload = await source.getNodes(
      request.fileKey,
      nodeIds,
      request.depth ? { depth: request.depth + 1 } : {},
    );
    fileName = payload.name;
    lastModified = payload.lastModified;
    for (const id of nodeIds) {
      const entry = lookupNode(payload.nodes, id);
      if (!entry || entry.err || !entry.document) {
        missingNodeIds.push(id);
        nodeErrors[id] = entry?.err ?? (entry ? "missing document" : "not returned");
        continue;
      }
      assignRefs(refs, entry);
      rawNodes.push(entry.document as FigmaNode);
    }
  } else {
    const file = await source.getFile(request.fileKey, { depth: 3 });
    fileName = file.name;
    lastModified = file.lastModified;
    assignRefs(refs, file);
    rawNodes = file.document ? [file.document as FigmaNode] : [];
  }

  const tree = toDesignContextNodes(rawNodes, {
    maxDepth: nodeIds ? request.depth : undefined,
    maxNodes: limits.maxNodes,
    maxBytes: limits.maxBytes,
    refs,
    fields: request.fields,
  });
  const reasons: string[] = [];
  if (!nodeIds) reasons.push("file-depth");
  if (request.depth != null && tree.nodes.some(hasTruncatedChildren)) reasons.push("depth");
  if (tree.nodeLimitHit) reasons.push("node-limit");
  if (tree.byteLimitHit) reasons.push("byte-limit");

  const screenshotIds = nodeIds?.length ? nodeIds : rawNodes.slice(0, 1).map((node) => node.id);
  const [variablesResult, screenshotResult] = await Promise.allSettled([
    includeVariables
      ? source.getLocalVariables(request.fileKey).then(summarizeVariables)
      : Promise.resolve(undefined),
    includeScreenshot && screenshotIds.length
      ? source.getImages(request.fileKey, screenshotIds, { format: "png", scale: 2 })
      : Promise.resolve(undefined),
  ]);

  const warnings: string[] = [];
  let variables: unknown;
  if (includeVariables) {
    if (variablesResult.status === "fulfilled") variables = variablesResult.value;
    else warnings.push(`variables: ${errorMessage(variablesResult.reason)}`);
  }
  let screenshots: Record<string, string | null> | undefined;
  if (includeScreenshot && screenshotIds.length) {
    if (screenshotResult.status === "fulfilled") screenshots = screenshotResult.value?.images;
    else warnings.push(`screenshot: ${errorMessage(screenshotResult.reason)}`);
  }

  const payload: DesignContextPayload = {
    fileKey: request.fileKey,
    name: fileName,
    lastModified,
    note: NOTE,
    truncated: reasons.length > 0,
    metadataXml: request.includeMetadataXml
      ? rawNodes.map((node) => nodeToXml(node)).join("\n")
      : undefined,
    nodes: tree.nodes,
    variables,
    screenshots,
    warnings,
    missingNodeIds: missingNodeIds.length ? missingNodeIds : undefined,
    nodeErrors: Object.keys(nodeErrors).length ? nodeErrors : undefined,
  };
  fitPayload(payload, reasons, limits.maxBytes);
  payload.truncated = reasons.length > 0;
  if (payload.truncated) {
    const nextChildIds = collectCutNodeIds(payload.nodes);
    payload.truncation = {
      reasons,
      hint: DESIGN_CONTEXT_TRUNCATION_HINT,
      ...(nextChildIds.length ? { nextChildIds } : {}),
    };
  }
  return payload;
}

function collectCutNodeIds(nodes: DesignContextNode[]): string[] {
  const out: string[] = [];
  const walk = (list: DesignContextNode[]): void => {
    for (const node of list) {
      if (!node.childrenTruncated) continue;
      if (out.length >= NEXT_CHILD_IDS_LIMIT) return;
      out.push(node.id);
      walk(node.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

function lookupNode(nodes: FigmaNodesResponse["nodes"], id: string) {
  return nodes[id] ?? nodes[id.replaceAll(":", "-")] ?? nodes[id.replaceAll("-", ":")];
}

function assignRefs(
  target: Required<DesignContextRefs>,
  source: DesignContextRefs | null | undefined,
): void {
  Object.assign(target.components, source?.components);
  Object.assign(target.componentSets, source?.componentSets);
  Object.assign(target.styles, source?.styles);
}

function fitPayload(payload: DesignContextPayload, reasons: string[], maxBytes: number): void {
  const mark = (warning: string) => {
    if (!reasons.includes("byte-limit")) reasons.push("byte-limit");
    if (!payload.warnings.includes(warning)) payload.warnings.push(warning);
  };
  if (encodedSize(payload) <= maxBytes) return;
  if (payload.metadataXml) {
    delete payload.metadataXml;
    mark("metadata XML omitted to stay within the byte limit");
  }
  if (encodedSize(payload) <= maxBytes) return;
  if (payload.variables !== undefined) {
    delete payload.variables;
    mark("variables omitted to stay within the byte limit");
  }
  if (encodedSize(payload) <= maxBytes) return;
  if (payload.screenshots) {
    delete payload.screenshots;
    mark("screenshot omitted to stay within the byte limit");
  }
  let guard = 0;
  let cut = false;
  while (encodedSize(payload) > maxBytes && guard++ < 100_000) {
    if (!removeLastLeaf(payload.nodes)) {
      payload.nodes = payload.nodes.map(slimContextNode);
      cut = true;
      break;
    }
    cut = true;
  }
  if (cut) mark("nodes cut to stay within the byte limit");
}

function encodedSize(payload: DesignContextPayload): number {
  return jsonUtf8Bytes(payload);
}

function removeLastLeaf(nodes: DesignContextNode[]): boolean {
  if (!nodes.length) return false;
  const last = nodes[nodes.length - 1];
  if (last.children?.length) {
    const removed = removeLastLeaf(last.children);
    if (removed) last.childrenTruncated = true;
    if (!last.children?.length) last.children = undefined;
    return removed;
  }
  if (nodes.length === 1) return false;
  nodes.pop();
  return true;
}

function slimContextNode(node: DesignContextNode): DesignContextNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    isMask: node.isMask,
    maskType: node.maskType,
    childrenTruncated: true,
  };
}

import { describe, expect, it } from "vitest";
import type { FigmaFileResponse, FigmaNodesResponse } from "../src/clients/figma.js";
import {
  buildDesignContext,
  type DesignContextSource,
} from "../src/figma/design-context.js";
import type { FigmaNode } from "../src/figma/parse.js";

function frame(id: string, children?: FigmaNode[]): FigmaNode {
  return { id, name: id, type: "FRAME", children };
}

function source(partial: Partial<DesignContextSource> = {}): DesignContextSource & {
  nodesCalls: Array<{ ids: string[]; depth?: number }>;
  fileCalls: Array<{ depth?: number }>;
} {
  const nodesCalls: Array<{ ids: string[]; depth?: number }> = [];
  const fileCalls: Array<{ depth?: number }> = [];
  return {
    nodesCalls,
    fileCalls,
    async getNodes(_fileKey, ids, params) {
      nodesCalls.push({ ids, depth: params?.depth });
      return { name: "File", nodes: {} };
    },
    async getFile(_fileKey, params) {
      fileCalls.push({ depth: params?.depth });
      return { name: "File", document: frame("0:1") };
    },
    async getLocalVariables() {
      return { meta: { variables: { a: { name: "color" } }, variableCollections: {} } };
    },
    async getImages(_fileKey, ids) {
      return { images: Object.fromEntries(ids.map((id) => [id, `https://example.test/${id}.png`])) };
    },
    ...partial,
  };
}

describe("buildDesignContext", () => {
  it("does not request variables unless asked", async () => {
    let called = false;
    const api = source({
      async getNodes() {
        return { name: "File", nodes: { "1:1": { document: frame("1:1") } } };
      },
      async getLocalVariables() {
        called = true;
        return {};
      },
    });
    const payload = await buildDesignContext(api, {
      fileKey: "abc",
      nodeIds: ["1:1"],
      includeScreenshot: false,
    });
    expect(called).toBe(false);
    expect(payload.variables).toBeUndefined();
    expect(payload.warnings).toEqual([]);
  });

  it("keeps nodes when variables fail and reports the warning", async () => {
    const api = source({
      async getNodes() {
        return {
          name: "File",
          nodes: { "1:1": { document: frame("1:1") } },
        };
      },
      async getLocalVariables() {
        throw new Error("403");
      },
    });
    const payload = await buildDesignContext(api, {
      fileKey: "abc",
      nodeIds: ["1:1"],
      includeVariables: true,
      includeMetadataXml: false,
    });
    expect(payload.nodes).toHaveLength(1);
    expect(payload.nodes[0]?.id).toBe("1:1");
    expect(payload.variables).toBeUndefined();
    expect(payload.screenshots?.["1:1"]).toContain("1:1");
    expect(payload.warnings.some((warning) => warning.startsWith("variables:"))).toBe(true);
    expect(payload.metadataXml).toBeUndefined();
  });

  it("keeps nodes when the screenshot fails", async () => {
    const api = source({
      async getNodes() {
        return { name: "File", nodes: { "1:1": { document: frame("1:1") } } };
      },
      async getImages() {
        throw new Error("render failed");
      },
    });
    const payload = await buildDesignContext(api, {
      fileKey: "abc",
      nodeIds: ["1:1"],
      includeVariables: true,
    });
    expect(payload.nodes[0]?.id).toBe("1:1");
    expect(payload.variables).toBeDefined();
    expect(payload.screenshots).toBeUndefined();
    expect(payload.warnings.some((warning) => warning.startsWith("screenshot:"))).toBe(true);
  });

  it("returns requested node ids in order and lists the ones that are missing", async () => {
    const api = source({
      async getNodes() {
        const nodes: FigmaNodesResponse["nodes"] = {
          "9:9": { document: frame("9:9") },
          "2:2": { document: frame("2:2") },
          "3:3": { err: "not found" },
        };
        return { name: "File", nodes };
      },
    });
    const payload = await buildDesignContext(api, {
      fileKey: "abc",
      nodeIds: ["3:3", "1:1", "2:2"],
      includeScreenshot: false,
      includeVariables: false,
    });
    expect(payload.nodes.map((node) => node.id)).toEqual(["2:2"]);
    expect(payload.missingNodeIds).toEqual(["3:3", "1:1"]);
    expect(payload.nodeErrors?.["3:3"]).toBe("not found");
    expect(payload.nodeErrors?.["1:1"]).toBe("not returned");
  });

  it("merges component and style refs and passes depth through", async () => {
    const api = source({
      async getNodes(_fileKey, ids, params) {
        api.nodesCalls.push({ ids, depth: params?.depth });
        return {
          name: "File",
          nodes: {
            "1:1": {
              document: frame("1:1", [frame("1:2", [frame("1:3")])]),
              components: { "10:1": { name: "Primary", key: "k", componentSetId: "9:1" } },
              componentSets: { "9:1": { name: "Button" } },
              styles: { "S:1": { name: "Heading" } },
            },
          },
        };
      },
    });
    const document = frame("1:1", [frame("1:2", [frame("1:3")])]) as FigmaNode & {
      componentId: string;
      styles: Record<string, string>;
    };
    document.componentId = "10:1";
    document.styles = { text: "S:1" };
    api.getNodes = async (_fileKey, ids, params) => {
      api.nodesCalls.push({ ids, depth: params?.depth });
      return {
        name: "File",
        nodes: {
          "1:1": {
            document,
            components: { "10:1": { name: "Primary", key: "k", componentSetId: "9:1" } },
            componentSets: { "9:1": { name: "Button" } },
            styles: { "S:1": { name: "Heading" } },
          },
        },
      };
    };
    const payload = await buildDesignContext(api, {
      fileKey: "abc",
      nodeIds: ["1:1"],
      depth: 1,
      includeScreenshot: false,
      includeVariables: false,
      includeMetadataXml: true,
    });
    expect(api.nodesCalls[0]?.depth).toBe(2);
    expect(payload.nodes[0]?.component).toEqual({ name: "Primary", key: "k", set: "Button" });
    expect(payload.nodes[0]?.styleNames).toEqual({ text: "Heading" });
    expect(payload.nodes[0]?.children?.[0]?.id).toBe("1:2");
    expect(payload.nodes[0]?.children?.[0]?.children).toBeUndefined();
    expect(payload.nodes[0]?.children?.[0]?.childrenTruncated).toBe(true);
    expect(payload.truncation?.reasons).toContain("depth");
    expect(payload.truncation?.hint).toContain("child node id");
    expect(payload.metadataXml).toContain('id="1:1"');
    expect(JSON.stringify(payload)).not.toContain("\n");
  });

  it("cuts a wide tree at the node cap", async () => {
    const root = frame(
      "1:1",
      Array.from({ length: 5 }, (_, index) => frame(`1:${index + 2}`)),
    );
    const api = source({
      async getNodes() {
        return { name: "File", nodes: { "1:1": { document: root } } };
      },
    });
    const payload = await buildDesignContext(api, {
      fileKey: "abc",
      nodeIds: ["1:1"],
      includeScreenshot: false,
      includeVariables: false,
      limits: { maxNodes: 3, maxBytes: 750_000 },
    });
    expect(payload.nodes[0]?.children?.map((child) => child.id)).toEqual(["1:2", "1:3"]);
    expect(payload.nodes[0]?.childrenTruncated).toBe(true);
    expect(payload.truncation?.reasons).toContain("node-limit");
    expect(payload.truncation?.hint).toContain("depth");
  });

  it("drops an oversized node body at the byte cap", async () => {
    const api = source({
      async getNodes() {
        return {
          name: "File",
          nodes: {
            "1:1": {
              document: {
                id: "1:1",
                name: "Essay",
                type: "TEXT",
                characters: "x".repeat(20_000),
              },
            },
          },
        };
      },
    });
    const payload = await buildDesignContext(api, {
      fileKey: "abc",
      nodeIds: ["1:1"],
      includeScreenshot: false,
      includeVariables: false,
      limits: { maxNodes: 20, maxBytes: 2_000 },
    });
    const encoded = JSON.stringify(payload);
    expect(encoded.length).toBeLessThanOrEqual(2_000);
    expect(encoded).not.toContain("x".repeat(100));
    expect(payload.truncation?.reasons).toContain("byte-limit");
    expect(payload.nodes[0]?.childrenTruncated).toBe(true);
  });

  it("counts the byte cap in UTF-8, not JSON string length", async () => {
    const api = source({
      async getNodes() {
        return {
          name: "File",
          nodes: {
            "1:1": {
              document: {
                id: "1:1",
                name: "Essay",
                type: "TEXT",
                characters: "漢".repeat(800),
              },
            },
          },
        };
      },
    });
    const payload = await buildDesignContext(api, {
      fileKey: "abc",
      nodeIds: ["1:1"],
      includeScreenshot: false,
      includeVariables: false,
      limits: { maxNodes: 20, maxBytes: 1_500 },
    });
    const encoded = JSON.stringify(payload);
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(1_500);
    expect(encoded).not.toContain("漢".repeat(50));
    expect(payload.truncation?.reasons).toContain("byte-limit");
  });

  it("marks a file-wide fetch as truncated at file depth", async () => {
    const file: FigmaFileResponse = {
      name: "File",
      document: frame("0:1"),
      components: { "10:1": { name: "Icon", key: "ik" } },
    };
    const api = source({
      async getFile(_fileKey, params) {
        api.fileCalls.push({ depth: params?.depth });
        return file;
      },
    });
    const payload = await buildDesignContext(api, {
      fileKey: "abc",
      includeScreenshot: false,
      includeVariables: false,
    });
    expect(api.fileCalls[0]?.depth).toBe(3);
    expect(payload.truncated).toBe(true);
    expect(payload.truncation?.reasons).toContain("file-depth");
    expect(payload.nodes[0]?.id).toBe("0:1");
  });

  it("passes lastModified through for pack freshness checks", async () => {
    const api = source({
      async getNodes() {
        return {
          name: "File",
          lastModified: "2026-10-28T12:00:00Z",
          nodes: { "1:1": { document: frame("1:1") } },
        };
      },
    });
    const payload = await buildDesignContext(api, {
      fileKey: "abc",
      nodeIds: ["1:1"],
      includeScreenshot: false,
      includeVariables: false,
    });
    expect(payload.lastModified).toBe("2026-10-28T12:00:00Z");
  });

  it("emits only the requested blocks when fields is set", async () => {
    const node: FigmaNode = {
      id: "1:1",
      name: "Row",
      type: "FRAME",
      layoutMode: "HORIZONTAL",
      itemSpacing: 8,
      fills: [{ type: "SOLID" }],
      strokes: [{ type: "SOLID" }],
      characters: "Hello",
      style: { fontFamily: "Inter", fontSize: 14 },
      componentId: "10:1",
      styles: { text: "S:1" },
      children: [frame("1:2")],
    };
    const api = source({
      async getNodes() {
        return { name: "File", nodes: { "1:1": { document: node } } };
      },
    });
    const payload = await buildDesignContext(api, {
      fileKey: "abc",
      nodeIds: ["1:1"],
      includeScreenshot: false,
      includeVariables: false,
      fields: ["text", "layout"],
    });
    const out = payload.nodes[0] as Record<string, unknown>;
    expect(out.layout).toBeDefined();
    expect(out.text).toBeDefined();
    expect(out.fills).toBeUndefined();
    expect(out.strokes).toBeUndefined();
    expect(out.visual).toBeUndefined();
    expect(out.componentId).toBeUndefined();
    expect(out.children).toBeDefined();
  });

  it("exposes hyperlink and prototype reactions for pointer resolution", async () => {
    const node: FigmaNode & { reactions: unknown[] } = {
      id: "1:1",
      name: "Spec",
      type: "FRAME",
      hyperlink: { nodeId: "203:13054" },
      reactions: [
        { action: { type: "NODE", destination: { destinationNodeId: "203:13054" } } },
      ],
    };
    const api = source({
      async getNodes() {
        return { name: "File", nodes: { "1:1": { document: node } } };
      },
    });
    const payload = await buildDesignContext(api, {
      fileKey: "abc",
      nodeIds: ["1:1"],
      includeScreenshot: false,
      includeVariables: false,
    });
    expect(payload.nodes[0]?.hyperlink).toEqual({ nodeId: "203:13054" });
    expect(payload.nodes[0]?.reactions?.[0]).toMatchObject({
      action: { destination: { destinationNodeId: "203:13054" } },
    });
  });

  it("lists the cut nodes as nextChildIds", async () => {
    const root = frame(
      "1:1",
      Array.from({ length: 6 }, (_, index) => frame(`1:${index + 2}`)),
    );
    const api = source({
      async getNodes() {
        return { name: "File", nodes: { "1:1": { document: root } } };
      },
    });
    const payload = await buildDesignContext(api, {
      fileKey: "abc",
      nodeIds: ["1:1"],
      includeScreenshot: false,
      includeVariables: false,
      limits: { maxNodes: 3, maxBytes: 750_000 },
    });
    expect(payload.truncated).toBe(true);
    expect(payload.truncation?.nextChildIds).toContain("1:1");
    for (const cut of payload.truncation?.nextChildIds ?? []) {
      expect(cut).toMatch(/^\d+:\d+$/);
    }
  });
});

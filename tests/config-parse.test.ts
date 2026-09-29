import { describe, expect, it, vi } from "vitest";
import { log } from "../src/log.js";
import {
  hasTruncatedChildren,
  nodeToXml,
  parseFigmaFileKey,
  parseFigmaNodeIds,
  parseFigmaUrl,
  toDesignContextNode,
} from "../src/figma/parse.js";
import { loadConfig, MISSING, normalizeAtlassianSite } from "../src/config.js";
import { encodeProjectId } from "../src/clients/gitlab.js";

describe("stdio logging", () => {
  it("writes only to stderr", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    log("hello");
    expect(err).toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
    err.mockRestore();
    out.mockRestore();
  });
});

describe("parsers", () => {
  it("extracts file key and node-id from Figma URLs", () => {
    const parsed = parseFigmaUrl(
      "https://www.figma.com/design/AbCdEf123/Name?node-id=12-34",
    );
    expect(parsed.fileKey).toBe("AbCdEf123");
    expect(parsed.nodeIds).toEqual(["12:34"]);
    expect(parseFigmaFileKey("AbCdEf123")).toBe("AbCdEf123");
    expect(parseFigmaNodeIds("1-2,3-4")).toEqual(["1:2", "3:4"]);
  });

  it("serializes a slim XML tree", () => {
    const xml = nodeToXml({
      id: "1:2",
      name: "Button & CTA",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 40 },
      children: [{ id: "1:3", name: "Label", type: "TEXT" }],
    });
    expect(xml).toContain('name="Button &amp; CTA"');
    expect(xml).toContain('width="120"');
    expect(xml).toContain('id="1:3"');
  });

  it("keeps metadata XML free of visual contract fields", () => {
    const xml = nodeToXml({
      id: "1:2",
      name: "Card",
      type: "FRAME",
      absoluteBoundingBox: { x: 0, y: 0, width: 120, height: 40 },
      layoutSizingHorizontal: "FIXED",
      cornerRadius: 8,
      effects: [{ type: "DROP_SHADOW", radius: 4 }],
    });
    expect(xml).toContain('width="120"');
    expect(xml).not.toContain("FIXED");
    expect(xml).not.toContain("DROP_SHADOW");
  });

  it("emits fixed sizing, complex styles, and text detail", () => {
    const node = toDesignContextNode({
      id: "9:1",
      name: "Modal",
      type: "FRAME",
      absoluteBoundingBox: { x: 10, y: 20, width: 320, height: 180 },
      layoutSizingHorizontal: "FIXED",
      layoutSizingVertical: "HUG",
      layoutPositioning: "ABSOLUTE",
      constraints: { horizontal: "CENTER", vertical: "CENTER" },
      rectangleCornerRadii: [8, 8, 0, 0],
      opacity: 0.9,
      blendMode: "MULTIPLY",
      clipsContent: true,
      strokeWeight: 1,
      strokeAlign: "INSIDE",
      effects: [
        {
          type: "DROP_SHADOW",
          visible: true,
          radius: 12,
          spread: 0,
          offset: { x: 0, y: 4 },
          color: { r: 0, g: 0, b: 0, a: 0.25 },
          boundVariables: {
            radius: { type: "VARIABLE_ALIAS", id: "VariableID:effect-radius" },
          },
        },
        { type: "LAYER_BLUR", visible: false, radius: 2 },
      ],
      boundVariables: {
        fills: [
          { type: "VARIABLE_ALIAS", id: "VariableID:fill-0" },
          { type: "VARIABLE_ALIAS", id: "VariableID:fill-1" },
        ],
        size: {
          x: { type: "VARIABLE_ALIAS", id: "VariableID:size-x" },
          y: { type: "VARIABLE_ALIAS", id: "VariableID:size-y" },
        },
        individualStrokeWeights: {
          top: { type: "VARIABLE_ALIAS", id: "VariableID:stroke-top" },
        },
        rectangleCornerRadii: {
          RECTANGLE_TOP_LEFT_CORNER_RADIUS: {
            type: "VARIABLE_ALIAS",
            id: "VariableID:radius-top-left",
          },
        },
      },
      characters: "Pay now",
      style: {
        fontFamily: "Inter",
        fontSize: 16,
        fontWeight: 600,
        textAlignHorizontal: "CENTER",
        textAlignVertical: "CENTER",
        textDecoration: "NONE",
        textCase: "UPPER",
      },
    });
    expect(node.visual).toMatchObject({
      sizing: { horizontal: "FIXED", vertical: "HUG" },
      positioning: "ABSOLUTE",
      constraints: { horizontal: "CENTER", vertical: "CENTER" },
      radius: [8, 8, 0, 0],
      opacity: 0.9,
      blendMode: "MULTIPLY",
      clipsContent: true,
      stroke: { weight: 1, align: "INSIDE" },
      boundVariables: {
        fills: ["VariableID:fill-0", "VariableID:fill-1"],
        size: {
          x: "VariableID:size-x",
          y: "VariableID:size-y",
        },
        individualStrokeWeights: {
          top: "VariableID:stroke-top",
        },
        rectangleCornerRadii: {
          RECTANGLE_TOP_LEFT_CORNER_RADIUS: "VariableID:radius-top-left",
        },
      },
    });
    expect(node.visual?.effects).toEqual([
      {
        type: "DROP_SHADOW",
        radius: 12,
        spread: 0,
        offset: { x: 0, y: 4 },
        color: { r: 0, g: 0, b: 0, a: 0.25 },
        visible: true,
        boundVariables: {
          radius: "VariableID:effect-radius",
        },
      },
      { type: "LAYER_BLUR", visible: false, radius: 2 },
    ]);
    expect(node.text).toMatchObject({
      characters: "Pay now",
      fontSize: 16,
      align: "CENTER",
      alignVertical: "CENTER",
      decoration: "NONE",
      case: "UPPER",
    });
  });

  it("keeps line height units, text sizing, and rotation", () => {
    const node = toDesignContextNode({
      id: "3:1",
      name: "Label",
      type: "TEXT",
      rotation: 0.5,
      characters: "Total",
      style: {
        fontStyle: "Semi Bold Italic",
        italic: true,
        lineHeightPercentFontSize: 150,
        lineHeightUnit: "FONT_SIZE_%",
        textAutoResize: "HEIGHT",
        textTruncation: "ENDING",
        maxLines: 2,
      },
    });
    expect(node.visual?.rotation).toBe(0.5);
    expect(node.text).toMatchObject({
      fontStyle: "Semi Bold Italic",
      italic: true,
      lineHeightPercentFontSize: 150,
      lineHeightUnit: "FONT_SIZE_%",
      autoResize: "HEIGHT",
      truncation: "ENDING",
      maxLines: 2,
    });
  });

  it("drops empty stroke sides and effect offsets", () => {
    const node = toDesignContextNode({
      id: "4:1",
      name: "Box",
      type: "FRAME",
      rotation: 0,
      individualStrokeWeights: {},
      effects: [{ type: "INNER_SHADOW", visible: true, radius: 2, offset: {} }],
    });
    expect(node.visual?.stroke).toBeUndefined();
    expect(node.visual?.rotation).toBeUndefined();
    expect(node.visual?.effects).toEqual([
      { type: "INNER_SHADOW", visible: true, radius: 2, offset: {} },
    ]);

    const partial = toDesignContextNode({
      id: "4:2",
      name: "Divider",
      type: "FRAME",
      individualStrokeWeights: { top: 0, bottom: 1 },
    });
    expect(partial.visual?.stroke).toEqual({ individual: { top: 0, bottom: 1 } });
  });

  it("keeps mixed text styles, auto-layout fields, and deep children", () => {
    const node = toDesignContextNode({
      id: "5:1",
      name: "Row",
      type: "FRAME",
      layoutGrow: 1,
      layoutAlign: "STRETCH",
      minWidth: 120,
      layoutWrap: "WRAP",
      primaryAxisSizingMode: "AUTO",
      strokesIncludedInLayout: true,
      characters: "Pay now",
      characterStyleOverrides: [0, 1, 1],
      styleOverrideTable: {
        "1": { fontWeight: 700, fontSize: 16 },
      },
      style: {
        fontSize: 14,
        paragraphSpacing: 8,
        boundVariables: {
          fontSize: { type: "VARIABLE_ALIAS", id: "VariableID:font-size" },
        },
      },
      children: [
        {
          id: "5:2",
          name: "Nested",
          type: "FRAME",
          children: [{ id: "5:3", name: "Label", type: "TEXT" }],
        },
      ],
    });
    expect(node.layout).toMatchObject({
      layoutGrow: 1,
      layoutAlign: "STRETCH",
      minWidth: 120,
      layoutWrap: "WRAP",
      primaryAxisSizingMode: "AUTO",
      strokesIncludedInLayout: true,
    });
    expect(node.text).toMatchObject({
      characterStyleOverrides: [0, 1, 1],
      styleOverrideTable: { "1": { fontWeight: 700, fontSize: 16 } },
      paragraphSpacing: 8,
      boundVariables: { fontSize: "VariableID:font-size" },
    });
    expect(node.children?.[0]?.children?.[0]?.id).toBe("5:3");
    expect(node.childrenTruncated).toBeUndefined();

    const capped = toDesignContextNode(
      {
        id: "5:1",
        name: "Row",
        type: "FRAME",
        children: [
          {
            id: "5:2",
            name: "Child",
            type: "FRAME",
            children: [{ id: "5:3", name: "Grandchild", type: "TEXT" }],
          },
        ],
      },
      { maxDepth: 1 },
    );
    expect(capped.children?.[0]?.id).toBe("5:2");
    expect(capped.children?.[0]?.children).toBeUndefined();
    expect(capped.children?.[0]?.childrenTruncated).toBe(true);
    expect(capped.childrenTruncated).toBeUndefined();
    expect(hasTruncatedChildren(capped)).toBe(true);
    expect(hasTruncatedChildren(node)).toBe(false);
  });

  it("marks hidden layers and masks, and names components, variants, and styles", () => {
    const node = toDesignContextNode(
      {
        id: "6:1",
        name: "Button",
        type: "INSTANCE",
        componentId: "10:1",
        componentProperties: {
          Size: { type: "VARIANT", value: "Large" },
          State: { type: "VARIANT", value: "Hover" },
        },
        styles: { text: "S:text", fill: "S:unknown" },
        children: [
          { id: "6:2", name: "Icon left", type: "INSTANCE", visible: false },
          { id: "6:3", name: "Clip", type: "RECTANGLE", isMask: true, maskType: "ALPHA" },
          { id: "6:4", name: "Label", type: "TEXT", visible: true },
        ],
      },
      {
        refs: {
          components: { "10:1": { key: "abc", name: "Size=Large, State=Hover", componentSetId: "9:1" } },
          componentSets: { "9:1": { name: "Button/Primary" } },
          styles: { "S:text": { name: "Heading/H1", styleType: "TEXT" } },
        },
      },
    );
    expect(node.component).toEqual({
      name: "Size=Large, State=Hover",
      key: "abc",
      set: "Button/Primary",
    });
    expect(node.componentProperties).toMatchObject({ State: { value: "Hover" } });
    expect(node.styleNames).toEqual({ text: "Heading/H1" });
    expect(node.visible).toBeUndefined();
    expect(node.children?.[0]?.visible).toBe(false);
    expect(node.children?.[1]?.isMask).toBe(true);
    expect(node.children?.[1]?.maskType).toBe("ALPHA");
    expect(node.children?.[2]?.visible).toBeUndefined();
  });

  it("uses a single corner radius when per-corner radii are absent", () => {
    const node = toDesignContextNode({
      id: "2:2",
      name: "Chip",
      type: "FRAME",
      cornerRadius: 4,
      blendMode: "NORMAL",
    });
    expect(node.visual?.radius).toBe(4);
    expect(node.visual?.blendMode).toBeUndefined();
  });

  it("encodes GitLab project id", () => {
    expect(encodeProjectId("12")).toBe("12");
    expect(encodeProjectId("group/project")).toBe("group%2Fproject");
  });
});

describe("loadConfig", () => {
  it("allows Figma without Atlassian/GitLab token", () => {
    const config = loadConfig({
      FIGMA_ACCESS_TOKEN: "fig_x",
    } as NodeJS.ProcessEnv);
    expect(config.figma?.accessToken).toBe("fig_x");
    expect(config.atlassian).toBeUndefined();
    expect(config.gitlab.token).toBeUndefined();
    expect(config.gitlab.host).toBe("https://gitlab.com");
  });

  it("normalizes Atlassian site", () => {
    expect(normalizeAtlassianSite("https://acme.atlassian.net/wiki")).toBe(
      "acme.atlassian.net",
    );
  });

  it("exposes clear missing-credential messages", () => {
    expect(MISSING.figma).toContain("FIGMA_ACCESS_TOKEN");
    expect(MISSING.atlassian).toContain("ATLASSIAN_API_TOKEN");
    expect(MISSING.gitlab).toContain("glab");
  });
});

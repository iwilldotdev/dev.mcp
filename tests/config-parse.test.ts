import { describe, expect, it, vi } from "vitest";
import { log } from "../src/log.js";
import {
  nodeToXml,
  parseFigmaFileKey,
  parseFigmaNodeIds,
  parseFigmaUrl,
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

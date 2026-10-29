import { describe, expect, it } from "vitest";
import { normalizeIssue } from "../src/adf.js";
import { inspectImage } from "../src/figma/image.js";
import { collectFrames, type FigmaNode } from "../src/figma/parse.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("collectFrames", () => {
  it("indexes frames nested in a section", () => {
    const document = {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [
        {
          id: "1:1",
          name: "Screens",
          type: "CANVAS",
          children: [
            {
              id: "2:2",
              name: "Certificates",
              type: "SECTION",
              children: [
                {
                  id: "3:3",
                  name: "PROD-1 default",
                  type: "FRAME",
                  absoluteBoundingBox: { x: 0, y: 0, width: 1366, height: 768 },
                },
              ],
            },
          ],
        },
      ],
    } as FigmaNode;
    const indexed = collectFrames(document);
    expect(indexed.truncated).toBe(false);
    expect(indexed.frames).toEqual([
      expect.objectContaining({
        id: "3:3",
        page: "Screens",
        pagePath: ["Screens"],
        sectionPath: ["Certificates"],
        width: 1366,
      }),
    ]);
  });
});

describe("inspectImage", () => {
  it("reads png dimensions and a stable hash", () => {
    const image = inspectImage(PNG_1X1, "application/octet-stream");
    expect(image).toMatchObject({ mime: "image/png", width: 1, height: 1, byteLength: PNG_1X1.length });
    expect(image.sha256).toHaveLength(64);
  });
});

describe("normalizeIssue", () => {
  it("keeps criteria, links, and attachments with provenance", () => {
    const normalized = normalizeIssue(
      {
        key: "DEV-1",
        fields: {
          summary: "Pay",
          status: { name: "Doing" },
          description: {
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "See the screen", marks: [{ type: "link", attrs: { href: "https://www.figma.com/design/abc?node-id=1-2" } }] }] },
              { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Acceptance criteria" }] },
              { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Shows the modal" }] }] }] },
            ],
          },
          attachment: [{ id: "10", filename: "error.png", mimeType: "image/png" }],
          issuelinks: [{ outwardIssue: { key: "DEV-2" } }],
        },
      },
      [{ object: { url: "https://www.figma.com/design/abc", title: "Design" } }],
    );
    expect(normalized.schemaVersion).toBe(1);
    expect(normalized.acceptanceCriteria).toEqual([{ text: "Shows the modal", source: "description" }]);
    expect(normalized.links.map((link) => link.source).sort()).toEqual(["description", "issuelink", "remotelink"]);
    expect(normalized.attachments).toEqual([{ id: "10", filename: "error.png", mimeType: "image/png", source: "attachment" }]);
    expect(normalized.unknowns).toEqual([]);
  });

  it("names missing description and criteria instead of inventing them", () => {
    const normalized = normalizeIssue({ key: "DEV-2", fields: { summary: "Empty" } }, []);
    expect(normalized.unknowns).toEqual(["description", "acceptance-criteria"]);
  });
});

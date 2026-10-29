import { describe, expect, it } from "vitest";
import { normalizeIssue } from "../src/adf.js";
import { richContent, type DownloadedImage } from "../src/jira/rich-issue.js";
import { inspectImage } from "../src/figma/image.js";
import { collectFrames, type FigmaNode } from "../src/figma/parse.js";

function doc(before: string, mediaId: string, after: string) {
  return {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: before }] },
      { type: "mediaSingle", content: [{ type: "media", attrs: { id: mediaId } }] },
      { type: "paragraph", content: [{ type: "text", text: after }] },
    ],
  };
}

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

  it("keeps each image between the text of the description and of a comment", () => {
    const normalized = normalizeIssue(
      {
        key: "DEV-3",
        fields: {
          summary: "Retorno",
          description: doc("Antes da descrição", "m1", "Depois da descrição"),
        },
      },
      [],
      { comments: [{ id: "9", author: { displayName: "QA" }, created: "2026-10-29T12:00:00.000Z", body: doc("Antes do comentário", "m2", "Depois do comentário") }] },
    );
    expect(normalized.descriptionParts.map((part) => part.type === "text" ? part.text : part.id)).toEqual(["Antes da descrição", "m1", "Depois da descrição"]);
    expect(normalized.comments[0]?.parts.map((part) => part.type === "text" ? part.text : part.id)).toEqual(["Antes do comentário", "m2", "Depois do comentário"]);
    const png = PNG_1X1;
    const downloads: DownloadedImage[] = [
      { url: "https://cdn/desc.png", source: "description", downloaded: true, mime: "image/png", data: png },
      { url: "https://cdn/comment.png", source: "comment", commentId: "9", downloaded: true, mime: "image/png", data: png },
    ];
    const content = richContent(normalized, {
      description: ["https://cdn/desc.png"],
      comments: [{ id: "9", urls: ["https://cdn/comment.png"] }],
      attachments: [],
    }, downloads, 0);
    expect(content.map((block) => block.type === "text" ? block.text : "image")).toEqual([
      expect.any(String),
      "Descrição",
      "Antes da descrição",
      "image",
      "Depois da descrição",
      "Comentário — QA — 2026-10-29T12:00:00.000Z",
      "Antes do comentário",
      "image",
      "Depois do comentário",
    ]);
  });

  it("names missing description and criteria instead of inventing them", () => {
    const normalized = normalizeIssue({ key: "DEV-2", fields: { summary: "Empty" } }, []);
    expect(normalized.unknowns).toEqual(["description", "acceptance-criteria"]);
  });
});

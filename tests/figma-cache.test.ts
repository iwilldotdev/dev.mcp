import { MemoryCache } from "../src/cache.js";
import { FigmaClient } from "../src/clients/figma.js";
import { HttpClient } from "../src/http.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("FigmaClient cache", () => {
  it("caches GET files/nodes/images/variables and does not cache comments", async () => {
    const urls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      urls.push(String(input));
      return jsonResponse({
        name: "File",
        document: { id: "0:1", name: "Page", type: "DOCUMENT", children: [] },
        nodes: { "1:2": { document: { id: "1:2", name: "Btn", type: "FRAME" } } },
        images: { "1:2": "https://img.example/a.png" },
        comments: [],
        meta: { variables: {}, variableCollections: {} },
      });
    };
    const http = new HttpClient({ fetch: fetchMock, sleep: async () => undefined });
    const cache = new MemoryCache();
    const figma = new FigmaClient(
      { accessToken: "fig_test", apiBase: "https://api.figma.com", cacheTtlMs: 60_000 },
      http,
      cache,
    );

    await figma.getFile("KEY");
    await figma.getFile("KEY");
    await figma.getNodes("KEY", ["1:2"]);
    await figma.getNodes("KEY", ["1:2"]);
    await figma.getImages("KEY", ["1:2"]);
    await figma.getImages("KEY", ["1:2"]);
    await figma.getLocalVariables("KEY");
    await figma.getLocalVariables("KEY");
    await figma.getComments("KEY");
    await figma.getComments("KEY");

    const fileCalls = urls.filter((u) => u.includes("/v1/files/KEY") && !u.includes("nodes") && !u.includes("variables") && !u.includes("comments") && !u.includes("images")).length;
    const nodeCalls = urls.filter((u) => u.includes("/nodes")).length;
    const imageCalls = urls.filter((u) => u.includes("/v1/images/KEY")).length;
    const varCalls = urls.filter((u) => u.includes("/variables/local")).length;
    const commentCalls = urls.filter((u) => u.includes("/comments")).length;

    expect(fileCalls).toBe(1);
    expect(nodeCalls).toBe(1);
    expect(imageCalls).toBe(1);
    expect(varCalls).toBe(1);
    expect(commentCalls).toBe(2);
  });
});

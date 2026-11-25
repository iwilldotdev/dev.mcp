import { z } from "zod";

/** Optional on every Rovo-style tool; ignored because dev.mcp serves one configured site. */
export const cloudIdShape = {
  cloudId: z.string().optional().describe("Accepted for Atlassian Rovo compatibility; ignored (one configured site)."),
};

export const contentTypeShape = z
  .enum(["page", "blogpost"])
  .describe("page or blogpost.");

/** REST v2 collection name per content type. */
export const COLLECTION = {
  page: "pages",
  blogpost: "blogposts",
  folder: "folders",
  whiteboard: "whiteboards",
  database: "databases",
} as const;
export type ContentType = keyof typeof COLLECTION;

export const bodyShape = z
  .object({
    format: z.string().describe("storage or atlas_doc_format (markdown is not supported)."),
    value: z.union([z.string(), z.record(z.unknown())]).describe("Body text; an ADF object is JSON-stringified."),
  })
  .describe("Body as {format, value}.");

export type BodyArg = z.infer<typeof bodyShape>;

/** Maps {format,value} onto the REST v2 {representation,value}. Markdown is rejected, not guessed. */
export function toRepresentation(body: BodyArg): { representation: string; value: string } {
  const format = body.format.toLowerCase();
  if (format === "markdown" || format === "md") {
    throw new Error(
      "body.format 'markdown' is not supported: the Confluence REST API only accepts storage (XHTML) or atlas_doc_format. Convert the content first.",
    );
  }
  if (format !== "storage" && format !== "atlas_doc_format") {
    throw new Error(`Unsupported body.format '${body.format}'. Use storage or atlas_doc_format.`);
  }
  return {
    representation: format,
    value: typeof body.value === "string" ? body.value : JSON.stringify(body.value),
  };
}

type TokenPayload = { id: string; v: number; t: string };

/** Opaque snapshot token: base64url of {id, v, t}. Returned by confluence_get_content. */
export function encodeSnapshotToken(id: string, version: number, type: string): string {
  const payload: TokenPayload = { id, v: version, t: type };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeSnapshotToken(token: string): TokenPayload {
  try {
    const p = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as TokenPayload;
    if (typeof p?.id === "string" && Number.isInteger(p.v) && p.v >= 1 && typeof p.t === "string") return p;
  } catch {
    /* fall through */
  }
  throw new Error("Invalid snapshotToken. Read the content again with confluence_get_content and pass the token it returns.");
}

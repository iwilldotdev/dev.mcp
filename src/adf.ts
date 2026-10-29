export function toAdf(text: string): Record<string, unknown> {
  const paragraphs = text.split(/\n{2,}/).map((block) => ({
    type: "paragraph",
    content: block
      ? block.split("\n").flatMap((line, index, arr) => {
          const nodes: unknown[] = [{ type: "text", text: line }];
          if (index < arr.length - 1) nodes.push({ type: "hardBreak" });
          return nodes;
        })
      : [],
  }));
  return {
    type: "doc",
    version: 1,
    content: paragraphs.length ? paragraphs : [{ type: "paragraph", content: [] }],
  };
}

export function maybeAdf(value: unknown): unknown {
  if (typeof value === "string") return toAdf(value);
  return value;
}

export type MediaRef = {
  id?: string;
  alt?: string;
  source: string;
  commentId?: string;
};

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "media"; id?: string; alt?: string };

export type NormalizedComment = {
  id?: string;
  author?: string;
  created?: string;
  updated?: string;
  text: string;
  parts: ContentPart[];
  links: Array<{ url: string; source: string }>;
  media: MediaRef[];
};

export type NormalizedIssue = {
  schemaVersion: 1;
  key?: string;
  summary?: string;
  status?: string;
  descriptionText: string;
  descriptionParts: ContentPart[];
  descriptionMedia: MediaRef[];
  acceptanceCriteria: Array<{ text: string; source: string }>;
  links: Array<{ url?: string; title?: string; source: string }>;
  attachments: Array<{ id?: string; filename?: string; mimeType?: string; content?: string; source: string }>;
  comments: NormalizedComment[];
  commentsTruncated: boolean;
  unknowns: string[];
};

const AC_HEADING = /acceptance criteria|crit[eé]rios? de aceite/i;

export function normalizeIssue(
  issue: unknown,
  remoteLinks: unknown = [],
  commentPage: { comments?: unknown; truncated?: boolean } = {},
): NormalizedIssue {
  const record = asRecord(issue);
  const fields = asRecord(record.fields);
  const description = adfDocument(fields.description);
  const reading = readAdf(fields.description);
  const criteria = acceptanceCriteria(description.blocks);
  const customCriteria = customAcceptance(fields);
  const links = [
    ...reading.links.map((url) => ({ url, source: "description" })),
    ...remoteLinkEntries(remoteLinks),
    ...issueLinkEntries(fields.issuelinks),
  ];
  const attachments = attachmentEntries(fields.attachment);
  const comments = normalizeComments(commentPage.comments);
  const descriptionMedia = mediaRefs(reading.parts, "description");
  const unknowns: string[] = [];
  if (!reading.parts.length) unknowns.push("description");
  if (!criteria.length && !customCriteria.length) unknowns.push("acceptance-criteria");
  return {
    schemaVersion: 1,
    key: typeof record.key === "string" ? record.key : undefined,
    summary: typeof fields.summary === "string" ? fields.summary : undefined,
    status: typeof asRecord(fields.status).name === "string" ? String(asRecord(fields.status).name) : undefined,
    descriptionText: textOfParts(reading.parts),
    descriptionParts: reading.parts,
    descriptionMedia,
    acceptanceCriteria: [...criteria, ...customCriteria],
    links,
    attachments,
    comments,
    commentsTruncated: commentPage.truncated === true,
    unknowns,
  };
}

export function readAdf(value: unknown): { parts: ContentPart[]; links: string[] } {
  const links: string[] = [];
  const parts: ContentPart[] = [];
  let buffer = "";
  const flush = () => {
    const text = buffer.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    buffer = "";
    if (text) parts.push({ type: "text", text });
  };
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const current = node as { type?: string; text?: string; content?: unknown; marks?: unknown; attrs?: unknown };
    if (current.type === "text" && typeof current.text === "string") {
      for (const mark of Array.isArray(current.marks) ? current.marks : []) {
        const href = asRecord(asRecord(mark).attrs).href;
        if (typeof href === "string") links.push(href);
      }
      buffer += current.text;
      return;
    }
    if (current.type === "hardBreak") {
      buffer += "\n";
      return;
    }
    if (current.type === "media" || current.type === "mediaInline") {
      flush();
      const attrs = asRecord(current.attrs);
      parts.push({
        type: "media",
        ...(typeof attrs.id === "string" ? { id: attrs.id } : {}),
        ...(typeof attrs.alt === "string" ? { alt: attrs.alt } : {}),
      });
      return;
    }
    if (current.type === "inlineCard" || current.type === "blockCard") {
      const url = asRecord(current.attrs).url;
      if (typeof url === "string") {
        links.push(url);
        buffer += url;
      }
      return;
    }
    for (const child of Array.isArray(current.content) ? current.content : []) walk(child);
  };
  const nodes = Array.isArray(asRecord(value).content) ? (asRecord(value).content as unknown[]) : [];
  for (const node of nodes) {
    walk(node);
    buffer += "\n";
  }
  flush();
  return { parts, links };
}

export function imageSources(html: string): string[] {
  const urls: string[] = [];
  const pattern = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  for (const match of html.matchAll(pattern)) {
    const raw = match[1] || match[2] || match[3];
    if (!raw) continue;
    const url = raw.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/")) urls.push(url);
  }
  return urls;
}

type Block = { kind: "heading" | "paragraph" | "list-item"; text: string };

function adfDocument(value: unknown): { text: string; links: string[]; blocks: Block[] } {
  const links: string[] = [];
  const blocks: Block[] = [];
  const content = Array.isArray(asRecord(value).content) ? (asRecord(value).content as unknown[]) : [];
  for (const node of content) {
    const type = asRecord(node).type;
    if (type === "bulletList" || type === "orderedList") {
      for (const item of Array.isArray(asRecord(node).content) ? (asRecord(node).content as unknown[]) : []) {
        blocks.push({ kind: "list-item", text: textOf(item, links).trim() });
      }
      continue;
    }
    const kind = type === "heading" ? "heading" : "paragraph";
    blocks.push({ kind, text: textOf(node, links).trim() });
  }
  return { text: blocks.map((block) => block.text).filter(Boolean).join("\n"), links, blocks };
}

function textOf(node: unknown, links: string[]): string {
  if (!node || typeof node !== "object") return "";
  const current = node as { type?: string; text?: string; content?: unknown; marks?: unknown; attrs?: unknown };
  if (current.type === "text" && typeof current.text === "string") {
    for (const mark of Array.isArray(current.marks) ? current.marks : []) {
      const href = asRecord(asRecord(mark).attrs).href;
      if (typeof href === "string") links.push(href);
    }
    return current.text;
  }
  if (current.type === "inlineCard" || current.type === "blockCard") {
    const url = asRecord(current.attrs).url;
    if (typeof url === "string") links.push(url);
  }
  return (Array.isArray(current.content) ? current.content : []).map((child) => textOf(child, links)).join("");
}

function acceptanceCriteria(blocks: Block[]): Array<{ text: string; source: string }> {
  const found: Array<{ text: string; source: string }> = [];
  let capturing = false;
  for (const block of blocks) {
    if (block.kind === "heading") {
      capturing = AC_HEADING.test(block.text);
      continue;
    }
    if (capturing && block.kind === "list-item" && block.text.trim()) {
      found.push({ text: block.text.trim(), source: "description" });
    }
  }
  return found;
}

function customAcceptance(fields: Record<string, unknown>): Array<{ text: string; source: string }> {
  const found: Array<{ text: string; source: string }> = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!/acceptance|criterio|critério/i.test(key)) continue;
    const text = typeof value === "string" ? value : adfDocument(value).text;
    if (text.trim()) found.push({ text: text.trim(), source: key });
  }
  return found;
}

function remoteLinkEntries(value: unknown): Array<{ url?: string; title?: string; source: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((link) => {
    const object = asRecord(asRecord(link).object);
    const url = typeof object.url === "string" ? object.url : undefined;
    if (!url) return [];
    return [{ url, title: typeof object.title === "string" ? object.title : undefined, source: "remotelink" }];
  });
}

function issueLinkEntries(value: unknown): Array<{ url?: string; title?: string; source: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((link) => {
    const record = asRecord(link);
    const inward = asRecord(record.inwardIssue).key;
    const outward = asRecord(record.outwardIssue).key;
    const key = typeof inward === "string" ? inward : typeof outward === "string" ? outward : undefined;
    return key ? [{ title: key, source: "issuelink" }] : [];
  });
}

function normalizeComments(value: unknown): NormalizedComment[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    const author = asRecord(record.author);
    const reading = readAdf(record.body);
    const commentId = typeof record.id === "string" ? record.id : undefined;
    return {
      id: commentId,
      author: typeof author.displayName === "string" ? author.displayName : undefined,
      created: typeof record.created === "string" ? record.created : undefined,
      updated: typeof record.updated === "string" ? record.updated : undefined,
      text: textOfParts(reading.parts),
      parts: reading.parts,
      links: reading.links.map((url) => ({ url, source: "comment" })),
      media: mediaRefs(reading.parts, "comment", commentId),
    };
  });
}

function textOfParts(parts: ContentPart[]): string {
  return parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function mediaRefs(parts: ContentPart[], source: string, commentId?: string): MediaRef[] {
  return parts.flatMap((part) => part.type === "media"
    ? [{ id: part.id, alt: part.alt, source, ...(commentId ? { commentId } : {}) }]
    : []);
}

function attachmentEntries(value: unknown): NormalizedIssue["attachments"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return {
      id: typeof record.id === "string" ? record.id : undefined,
      filename: typeof record.filename === "string" ? record.filename : undefined,
      mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
      ...(typeof record.content === "string" ? { content: record.content } : {}),
      source: "attachment",
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

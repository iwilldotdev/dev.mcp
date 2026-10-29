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

export type NormalizedIssue = {
  schemaVersion: 1;
  key?: string;
  summary?: string;
  status?: string;
  descriptionText: string;
  acceptanceCriteria: Array<{ text: string; source: string }>;
  links: Array<{ url?: string; title?: string; source: string }>;
  attachments: Array<{ id?: string; filename?: string; mimeType?: string; source: string }>;
  unknowns: string[];
};

const AC_HEADING = /acceptance criteria|crit[eé]rios? de aceite/i;

export function normalizeIssue(issue: unknown, remoteLinks: unknown = []): NormalizedIssue {
  const record = asRecord(issue);
  const fields = asRecord(record.fields);
  const description = adfDocument(fields.description);
  const criteria = acceptanceCriteria(description.blocks);
  const customCriteria = customAcceptance(fields);
  const links = [
    ...description.links.map((url) => ({ url, source: "description" })),
    ...remoteLinkEntries(remoteLinks),
    ...issueLinkEntries(fields.issuelinks),
  ];
  const attachments = attachmentEntries(fields.attachment);
  const unknowns: string[] = [];
  if (!description.text.trim()) unknowns.push("description");
  if (!criteria.length && !customCriteria.length) unknowns.push("acceptance-criteria");
  return {
    schemaVersion: 1,
    key: typeof record.key === "string" ? record.key : undefined,
    summary: typeof fields.summary === "string" ? fields.summary : undefined,
    status: typeof asRecord(fields.status).name === "string" ? String(asRecord(fields.status).name) : undefined,
    descriptionText: description.text.trim(),
    acceptanceCriteria: [...criteria, ...customCriteria],
    links,
    attachments,
    unknowns,
  };
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

function attachmentEntries(value: unknown): NormalizedIssue["attachments"] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const record = asRecord(item);
    return {
      id: typeof record.id === "string" ? record.id : undefined,
      filename: typeof record.filename === "string" ? record.filename : undefined,
      mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
      source: "attachment",
    };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

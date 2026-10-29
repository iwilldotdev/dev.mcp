import { imageSources, normalizeIssue, type ContentPart, type NormalizedIssue } from "../adf.js";
import type { JiraClient } from "../clients/jira.js";
import { errorMessage } from "../errors.js";
import { inspectImage } from "../figma/image.js";
import { rawResult, type McpContent } from "../tools/result.js";

export const MAX_IMAGES = 15;
export const MAX_IMAGE_BYTES = 4_000_000;

export type ImageJob = {
  url: string;
  source: "description" | "comment" | "attachment";
  commentId?: string;
  filename?: string;
};

export type DownloadedImage = ImageJob & {
  downloaded: boolean;
  mime?: string;
  sha256?: string;
  width?: number;
  height?: number;
  byteLength?: number;
  reason?: string;
  data?: Buffer;
};

export type ImagePositions = {
  description: string[];
  comments: Array<{ id?: string; urls: string[] }>;
  attachments: ImageJob[];
};

export function imagePositions(issue: unknown, comments: unknown[]): ImagePositions {
  const rendered = asRecord(asRecord(issue).renderedFields);
  const description = typeof rendered.description === "string" ? imageSources(rendered.description) : [];
  const commentUrls = comments.map((comment) => {
    const record = asRecord(comment);
    return {
      id: typeof record.id === "string" ? record.id : undefined,
      urls: typeof record.renderedBody === "string" ? imageSources(record.renderedBody) : [],
    };
  });
  const inline = new Set([...description, ...commentUrls.flatMap((comment) => comment.urls)]);
  const attachments: ImageJob[] = [];
  const attachmentField = asRecord(asRecord(issue).fields).attachment;
  for (const item of Array.isArray(attachmentField) ? attachmentField : []) {
    const record = asRecord(item);
    const mime = typeof record.mimeType === "string" ? record.mimeType : "";
    const content = typeof record.content === "string" ? record.content : "";
    if (!mime.startsWith("image/") || !content || inline.has(content)) continue;
    attachments.push({
      url: content,
      source: "attachment",
      filename: typeof record.filename === "string" ? record.filename : undefined,
    });
  }
  return { description, comments: commentUrls, attachments };
}

export function richContent(
  issue: NormalizedIssue,
  positions: ImagePositions,
  downloads: DownloadedImage[],
  skipped: number,
): McpContent[] {
  const byUrl = new Map(downloads.map((item) => [item.url, item]));
  const missing = downloads.some((item) => !item.downloaded) || skipped > 0;
  const unknowns = missing && !issue.unknowns.includes("undownloaded-media")
    ? [...issue.unknowns, "undownloaded-media"]
    : issue.unknowns;
  const content: McpContent[] = [{
    type: "text",
    text: JSON.stringify({
      schemaVersion: issue.schemaVersion,
      key: issue.key,
      summary: issue.summary,
      status: issue.status,
      acceptanceCriteria: issue.acceptanceCriteria,
      links: issue.links,
      attachments: issue.attachments,
      comments: issue.comments.map(({ parts: _parts, ...comment }) => comment),
      commentsTruncated: issue.commentsTruncated,
      unknowns,
      mediaSkipped: skipped,
    }),
  }];
  content.push(...sectionBlocks("Descrição", issue.descriptionParts, positions.description, byUrl));
  issue.comments.forEach((comment, index) => {
    const located = positions.comments.find((item) => item.id === comment.id) ?? positions.comments[index];
    const who = [comment.author, comment.created].filter(Boolean).join(" — ");
    content.push(...sectionBlocks(`Comentário${who ? ` — ${who}` : ""}`, comment.parts, located?.urls ?? [], byUrl));
  });
  if (positions.attachments.length) {
    content.push({ type: "text", text: "Anexos que não estão dentro do texto" });
    for (const job of positions.attachments) content.push(mediaBlock(job.url, byUrl, job.filename));
  }
  return content;
}

function sectionBlocks(title: string, parts: ContentPart[], urls: string[], byUrl: Map<string, DownloadedImage>): McpContent[] {
  const blocks: McpContent[] = [{ type: "text", text: title }];
  let mediaIndex = 0;
  for (const part of parts) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    blocks.push(mediaBlock(urls[mediaIndex++], byUrl, part.alt || part.id));
  }
  while (mediaIndex < urls.length) blocks.push(mediaBlock(urls[mediaIndex++], byUrl));
  return blocks;
}

function mediaBlock(url: string | undefined, byUrl: Map<string, DownloadedImage>, label?: string): McpContent {
  const image = url ? byUrl.get(url) : undefined;
  if (image?.downloaded && image.data && image.mime?.startsWith("image/")) {
    return { type: "image", data: image.data.toString("base64"), mimeType: image.mime };
  }
  return { type: "text", text: `[imagem não baixada${label ? `: ${label}` : ""}]` };
}

export async function readRichIssue(jira: JiraClient, issueIdOrKey: string) {
  const [issue, remoteLinks, commentPage] = await Promise.all([
    jira.getIssue(issueIdOrKey, {
      fields: "summary,status,description,attachment,comment",
      expand: "renderedFields",
    }),
    jira.getRemoteIssueLinks(issueIdOrKey),
    jira.getComments(issueIdOrKey),
  ]);
  const normalized = normalizeIssue(issue, remoteLinks, commentPage);
  const positions = imagePositions(issue, commentPage.comments);
  const jobs = uniqueJobs(positions);
  const downloads: DownloadedImage[] = [];
  for (const job of jobs.slice(0, MAX_IMAGES)) downloads.push(await downloadImage(jira, job));
  return rawResult(richContent(normalized, positions, downloads, Math.max(0, jobs.length - MAX_IMAGES)));
}

function uniqueJobs(positions: ImagePositions): ImageJob[] {
  const jobs: ImageJob[] = [];
  const seen = new Set<string>();
  const add = (job: ImageJob) => {
    if (!job.url || seen.has(job.url)) return;
    seen.add(job.url);
    jobs.push(job);
  };
  for (const url of positions.description) add({ url, source: "description" });
  for (const comment of positions.comments) {
    for (const url of comment.urls) add({ url, source: "comment", commentId: comment.id });
  }
  for (const job of positions.attachments) add(job);
  return jobs;
}

async function downloadImage(jira: JiraClient, job: ImageJob): Promise<DownloadedImage> {
  try {
    const file = await jira.download(job.url);
    if (file.data.length > MAX_IMAGE_BYTES) {
      return { ...job, downloaded: false, byteLength: file.data.length, reason: "too-large" };
    }
    const inspected = inspectImage(file.data, file.mime);
    const mime = inspected.mime.startsWith("image/") ? inspected.mime : file.mime;
    if (!mime.startsWith("image/")) return { ...job, downloaded: false, mime, reason: "not-an-image" };
    return {
      ...job,
      downloaded: true,
      mime,
      sha256: inspected.sha256,
      width: inspected.width,
      height: inspected.height,
      byteLength: inspected.byteLength,
      data: file.data,
    };
  } catch (err) {
    return { ...job, downloaded: false, reason: errorMessage(err) };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

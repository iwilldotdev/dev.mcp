/* Compact summaries returned instead of the payload when save_to is set. Small key fields only. */

type Rec = Record<string, any>;

function pick(obj: Rec | undefined, keys: string[]): Rec {
  const out: Rec = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export function sumIssue(p: Rec): Rec {
  return pick(p, ["iid", "title", "state", "web_url"]);
}

function mrFields(mr: Rec): Rec {
  return {
    ...pick(mr, ["iid", "state", "draft", "source_branch", "target_branch", "sha", "web_url"]),
    ...(mr?.draft === undefined && mr?.work_in_progress !== undefined ? { draft: mr.work_in_progress } : {}),
  };
}

export function sumMr(p: Rec): Rec {
  const mr = p?.merge_request ?? p;
  const out = mrFields(mr);
  for (const k of ["commits", "diffs", "notes", "pipelines"]) {
    if (Array.isArray(p?.[k])) out[`${k}_count`] = p[k].length;
  }
  return out;
}

export function sumMrList(p: unknown): Rec {
  const list = Array.isArray(p) ? (p as Rec[]) : [];
  return { count: list.length, merge_requests: list.slice(0, 20).map((m) => pick(m, ["iid", "state", "web_url"])) };
}

export function sumPipeline(p: Rec): Rec {
  return pick(p, ["id", "status", "ref", "sha", "web_url"]);
}

export function sumJobs(p: unknown): Rec {
  const list = Array.isArray(p) ? (p as Rec[]) : [];
  return { count: list.length, jobs: list.slice(0, 50).map((j) => pick(j, ["id", "name", "stage", "status"])) };
}

export function sumJob(p: Rec): Rec {
  return pick(p, ["id", "name", "stage", "status", "web_url"]);
}

export function sumJiraIssue(p: Rec): Rec {
  return {
    key: p?.key,
    summary: p?.fields?.summary,
    status: p?.fields?.status?.name,
    type: p?.fields?.issuetype?.name,
  };
}

export function sumJiraRich(p: Rec): Rec {
  const status = p?.status;
  return {
    key: p?.key,
    summary: p?.summary,
    status: status && typeof status === "object" ? status.name : status,
    comments: Array.isArray(p?.comments) ? p.comments.length : undefined,
    attachments: Array.isArray(p?.attachments) ? p.attachments.length : undefined,
  };
}

export function sumJql(p: Rec): Rec {
  const issues: Rec[] = Array.isArray(p?.issues) ? p.issues : [];
  return {
    count: issues.length,
    keys: issues.slice(0, 50).map((i) => i?.key),
    nextPageToken: p?.nextPageToken,
  };
}

export function sumLinks(p: unknown): Rec {
  return { count: Array.isArray(p) ? p.length : 0 };
}

export function sumPage(p: Rec): Rec {
  return pick(p, ["id", "title", "status", "spaceId"]);
}

export function sumFigmaMeta(p: Rec): Rec {
  return pick(p, ["fileKey", "name", "lastModified", "version"]);
}

export function sumFigmaFrames(p: Rec): Rec {
  return {
    ...pick(p, ["fileKey", "name", "lastModified", "version", "truncated"]),
    frames: Array.isArray(p?.frames) ? p.frames.length : 0,
  };
}

export function sumFigmaFile(p: Rec): Rec {
  return {
    ...pick(p, ["name", "lastModified", "version"]),
    documentId: p?.document?.id,
  };
}

export function sumFigmaVars(p: Rec): Rec {
  return { fileKey: p?.fileKey, hasLocal: p?.local !== undefined, hasPublished: p?.published !== undefined };
}

export function sumFigmaContext(p: Rec): Rec {
  const nodes: Rec[] = Array.isArray(p?.nodes) ? p.nodes : [];
  return {
    ...pick(p, ["fileKey", "name", "lastModified", "truncated"]),
    nodeIds: nodes.slice(0, 50).map((n) => n?.id),
    nodes: nodes.length,
    missingNodeIds: p?.missingNodeIds,
  };
}

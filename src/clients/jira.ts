import type { AtlassianConfig } from "../config.js";
import { basicAuth, type HttpClient, withQuery } from "../http.js";

export class JiraClient {
  constructor(
    private readonly config: AtlassianConfig,
    private readonly http: HttpClient,
  ) {}

  private headers(extra?: HeadersInit): HeadersInit {
    return {
      Authorization: basicAuth(this.config.email, this.config.apiToken),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private url(path: string): string {
    return `${this.config.baseUrl}/rest/api/3${path}`;
  }

  getIssue(issueIdOrKey: string, params: { fields?: string; expand?: string } = {}) {
    return this.http.json(
      withQuery(this.url(`/issue/${encodeURIComponent(issueIdOrKey)}`), params),
      { headers: this.headers() },
    );
  }

  searchJql(body: {
    jql: string;
    maxResults?: number;
    nextPageToken?: string;
    fields?: string[];
    expand?: string;
  }) {
    return this.http.json(this.url("/search/jql"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
  }

  getProjects(params: { startAt?: number; maxResults?: number; query?: string } = {}) {
    return this.http.json(withQuery(this.url("/project/search"), params), {
      headers: this.headers(),
    });
  }

  getIssueTypesMetadata(projectIdOrKey: string, issueTypeId?: string) {
    const base = this.url(
      `/issue/createmeta/${encodeURIComponent(projectIdOrKey)}/issuetypes`,
    );
    const url = issueTypeId ? `${base}/${encodeURIComponent(issueTypeId)}` : base;
    return this.http.json(url, { headers: this.headers() });
  }

  getTransitions(issueIdOrKey: string) {
    return this.http.json(
      this.url(`/issue/${encodeURIComponent(issueIdOrKey)}/transitions`),
      { headers: this.headers() },
    );
  }

  createIssue(payload: unknown) {
    return this.http.json(this.url("/issue"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
  }

  editIssue(issueIdOrKey: string, payload: unknown) {
    return this.http.json(this.url(`/issue/${encodeURIComponent(issueIdOrKey)}`), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
  }

  transitionIssue(issueIdOrKey: string, payload: unknown) {
    return this.http.json(
      this.url(`/issue/${encodeURIComponent(issueIdOrKey)}/transitions`),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
      },
    );
  }

  addComment(issueIdOrKey: string, payload: unknown) {
    return this.http.json(
      this.url(`/issue/${encodeURIComponent(issueIdOrKey)}/comment`),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
      },
    );
  }

  addWorklog(issueIdOrKey: string, payload: unknown) {
    return this.http.json(
      this.url(`/issue/${encodeURIComponent(issueIdOrKey)}/worklog`),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
      },
    );
  }

  lookupAccountId(query: string, maxResults = 20) {
    return this.http.json(
      withQuery(this.url("/user/search"), { query, maxResults }),
      { headers: this.headers() },
    );
  }

  getComments(issueIdOrKey: string): Promise<{ comments: unknown[]; truncated: boolean }> {
    return this.collectComments(issueIdOrKey);
  }

  download(url: string) {
    const absolute = url.startsWith("http://") || url.startsWith("https://")
      ? url
      : new URL(url, this.config.baseUrl).toString();
    return this.http.bytes(absolute, {
      headers: {
        Authorization: basicAuth(this.config.email, this.config.apiToken),
        Accept: "*/*",
      },
    });
  }

  private async collectComments(issueIdOrKey: string): Promise<{ comments: unknown[]; truncated: boolean }> {
    const comments: unknown[] = [];
    let startAt = 0;
    let total = Number.POSITIVE_INFINITY;
    while (comments.length < total && comments.length < 200) {
      const page = await this.http.json<{ comments?: unknown[]; total?: number }>(
        withQuery(this.url(`/issue/${encodeURIComponent(issueIdOrKey)}/comment`), {
          startAt,
          maxResults: 100,
          expand: "renderedBody",
        }),
        { headers: this.headers() },
      );
      const batch = Array.isArray(page.comments) ? page.comments : [];
      total = typeof page.total === "number" ? page.total : startAt + batch.length;
      comments.push(...batch);
      if (batch.length === 0) break;
      startAt += batch.length;
    }
    return { comments, truncated: comments.length < total };
  }

  getRemoteIssueLinks(issueIdOrKey: string) {
    return this.http.json(
      this.url(`/issue/${encodeURIComponent(issueIdOrKey)}/remotelink`),
      { headers: this.headers() },
    );
  }

  createRemoteIssueLink(issueIdOrKey: string, payload: unknown) {
    return this.http.json(
      this.url(`/issue/${encodeURIComponent(issueIdOrKey)}/remotelink`),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
      },
    );
  }

  getIssueLinkTypes() {
    return this.http.json(this.url("/issueLinkType"), { headers: this.headers() });
  }

  createIssueLink(payload: unknown) {
    return this.http.json(this.url("/issueLink"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
  }
}

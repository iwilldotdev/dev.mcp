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

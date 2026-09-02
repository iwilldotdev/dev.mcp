import type { AtlassianConfig } from "../config.js";
import { basicAuth, type HttpClient, withQuery } from "../http.js";

export class ConfluenceClient {
  constructor(
    private readonly config: AtlassianConfig,
    private readonly http: HttpClient,
  ) {}

  private headers(): HeadersInit {
    return {
      Authorization: basicAuth(this.config.email, this.config.apiToken),
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private v2(path: string): string {
    return `${this.config.baseUrl}/wiki/api/v2${path}`;
  }

  private rest(path: string): string {
    return `${this.config.baseUrl}/wiki/rest/api${path}`;
  }

  getSpaces(params: { limit?: number; cursor?: string; keys?: string; type?: string } = {}) {
    return this.http.json(withQuery(this.v2("/spaces"), params), {
      headers: this.headers(),
    });
  }

  getPagesInSpace(
    spaceId: string,
    params: { limit?: number; cursor?: string; title?: string; status?: string } = {},
  ) {
    return this.http.json(
      withQuery(this.v2(`/spaces/${encodeURIComponent(spaceId)}/pages`), params),
      { headers: this.headers() },
    );
  }

  getPage(pageId: string, params: { bodyFormat?: string } = {}) {
    return this.http.json(
      withQuery(this.v2(`/pages/${encodeURIComponent(pageId)}`), {
        "body-format": params.bodyFormat ?? "storage",
      }),
      { headers: this.headers() },
    );
  }

  getPageDescendants(
    pageId: string,
    params: { limit?: number; cursor?: string; depth?: number } = {},
  ) {
    return this.http.json(
      withQuery(this.v2(`/pages/${encodeURIComponent(pageId)}/descendants`), params),
      { headers: this.headers() },
    );
  }

  getFooterComments(pageId: string, params: { limit?: number; cursor?: string } = {}) {
    return this.http.json(
      withQuery(this.v2(`/pages/${encodeURIComponent(pageId)}/footer-comments`), params),
      { headers: this.headers() },
    );
  }

  getInlineComments(pageId: string, params: { limit?: number; cursor?: string } = {}) {
    return this.http.json(
      withQuery(this.v2(`/pages/${encodeURIComponent(pageId)}/inline-comments`), params),
      { headers: this.headers() },
    );
  }

  searchCql(params: { cql: string; limit?: number; start?: number; excerpt?: string }) {
    return this.http.json(withQuery(this.rest("/search"), params), {
      headers: this.headers(),
    });
  }

  createPage(payload: unknown) {
    return this.http.json(this.v2("/pages"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
  }

  updatePage(pageId: string, payload: unknown) {
    return this.http.json(this.v2(`/pages/${encodeURIComponent(pageId)}`), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
  }

  createFooterComment(payload: unknown) {
    return this.http.json(this.v2("/footer-comments"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
  }

  createInlineComment(payload: unknown) {
    return this.http.json(this.v2("/inline-comments"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
  }
}

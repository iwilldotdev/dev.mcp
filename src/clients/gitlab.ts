import { MISSING } from "../config.js";
import { isAuthOrPermissionError } from "../errors.js";
import { type HttpClient, withQuery } from "../http.js";
import type { GlabClient } from "./glab.js";

export function encodeProjectId(id: string | number): string {
  const raw = String(id);
  if (/^\d+$/.test(raw)) return raw;
  return encodeURIComponent(raw);
}

export class GitLabRestClient {
  constructor(
    private readonly host: string,
    private readonly token: string,
    private readonly http: HttpClient,
  ) {}

  private headers(): HeadersInit {
    return {
      "PRIVATE-TOKEN": this.token,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  url(path: string, query?: Record<string, string | number | boolean | undefined | null>): string {
    const base = `${this.host.replace(/\/+$/, "")}/api/v4/${path.replace(/^\/+/, "")}`;
    return query ? withQuery(base, query) : base;
  }

  async request<T>(
    path: string,
    init: {
      method?: string;
      query?: Record<string, string | number | boolean | undefined | null>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    return this.http.json<T>(this.url(path, init.query), {
      method,
      headers: this.headers(),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }
}

export class GitLabClient {
  constructor(
    private readonly rest: GitLabRestClient | undefined,
    private readonly glab: GlabClient,
  ) {}

  async request<T>(
    path: string,
    init: {
      method?: string;
      query?: Record<string, string | number | boolean | undefined | null>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    if (this.rest) {
      try {
        return await this.rest.request<T>(path, init);
      } catch (err) {
        if (!isAuthOrPermissionError(err)) {
          throw err;
        }
      }
    }

    const available = await this.glab.available();
    if (!available) {
      throw new Error(MISSING.gitlab);
    }

    const method = (init.method ?? "GET").toUpperCase();
    const pathWithQuery = appendQuery(path, init.query);
    return (await this.glab.api(pathWithQuery, {
      method,
      body: init.body,
    })) as T;
  }
}

function appendQuery(
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>,
): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

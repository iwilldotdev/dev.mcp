import { ApiError } from "./errors.js";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type HttpRequestInit = RequestInit & {
  timeoutMs?: number;
  maxRetries?: number;
  retryOn?: number[];
  raw?: boolean;
};

export type HttpClientOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const DEFAULT_RETRY_ON = [429, 503];
const WRITE_RETRY_ON = [429];

export function parseRetryAfter(
  header: string | null,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

export function backoffMs(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** attempt);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function formatErrorMessage(status: number, url: string, body: unknown): string {
  const snippet =
    typeof body === "string"
      ? body.slice(0, 500)
      : body && typeof body === "object"
        ? JSON.stringify(body).slice(0, 500)
        : "";
  return `HTTP ${status} ${url}${snippet ? `: ${snippet}` : ""}`;
}

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: HttpClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  async request(url: string, init: HttpRequestInit = {}): Promise<{
    status: number;
    headers: Headers;
    body: unknown;
  }> {
    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    const maxRetries = init.maxRetries ?? this.maxRetries;
    // Non-idempotent writes are retried only on 429 (the request was rejected, not processed),
    // never on 503 or after a network error, unless the caller sets retryOn explicitly.
    const method = (init.method ?? "GET").toUpperCase();
    const idempotent = method === "GET" || method === "HEAD" || method === "OPTIONS";
    const retryOn = init.retryOn ?? (idempotent ? DEFAULT_RETRY_ON : WRITE_RETRY_ON);
    const retryNetwork = idempotent || init.retryOn !== undefined;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const parentSignal = init.signal;
      const onAbort = () => controller.abort();
      if (parentSignal) {
        if (parentSignal.aborted) controller.abort();
        else parentSignal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        const res = await this.fetchImpl(url, {
          ...init,
          signal: controller.signal,
        });
        const retryAfterMs = parseRetryAfter(
          res.headers.get("retry-after"),
          this.now(),
        );

        if (retryOn.includes(res.status) && attempt < maxRetries) {
          const wait = retryAfterMs ?? backoffMs(attempt);
          await this.sleep(wait);
          continue;
        }

        const body = init.raw ? Buffer.from(await res.arrayBuffer()) : await readBody(res);
        if (!res.ok) {
          throw new ApiError(
            formatErrorMessage(res.status, url, body),
            res.status,
            url,
            body,
            retryAfterMs,
          );
        }
        return { status: res.status, headers: res.headers, body };
      } catch (err) {
        lastError = err;
        if (err instanceof ApiError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error(`Timeout of ${timeoutMs}ms for ${url}`);
        }
        if (retryNetwork && attempt < maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener("abort", onAbort);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Falha HTTP em ${url}`);
  }

  async json<T>(url: string, init: HttpRequestInit = {}): Promise<T> {
    const { body } = await this.request(url, init);
    return body as T;
  }

  download(url: string, opts: DownloadOptions) {
    return downloadBytes(this.fetchImpl, url, { timeoutMs: this.timeoutMs, ...opts });
  }

  async bytes(url: string, init: HttpRequestInit = {}): Promise<{ mime: string; data: Buffer }> {
    const { headers, body } = await this.request(url, { ...init, raw: true });
    return {
      mime: headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
      data: Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? "")),
    };
  }
}

export type DownloadOptions = {
  headers?: Record<string, string>;
  /** Credentials (Authorization/Cookie) are sent only to this origin, also across redirects. */
  authOrigin?: string;
  maxBytes: number;
  maxRedirects?: number;
  timeoutMs?: number;
};

async function readCapped(res: Response, maxBytes: number, url: string): Promise<Buffer> {
  const tooBig = () => new Error(`Download from ${url} exceeds the ${maxBytes}-byte limit (DEV_MCP_SAVE_MAX_MB); nothing was saved.`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * HttpClient.download: GET with manual redirect handling, a byte cap, and no credential
 * forwarding to any origin other than `authOrigin` (checked on every hop).
 */
export async function downloadBytes(
  fetchImpl: FetchLike,
  startUrl: string,
  opts: DownloadOptions,
): Promise<{ mime: string; data: Buffer; headers: Headers; finalUrl: string }> {
  const maxRedirects = opts.maxRedirects ?? 5;
  let url = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      // Off the auth origin only an allowlist of harmless headers is forwarded.
      if (parsed.origin !== opts.authOrigin && !/^(accept|user-agent)$/i.test(k)) continue;
      headers[k] = v;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    try {
      const res = await fetchImpl(url, { method: "GET", headers, redirect: "manual", signal: controller.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => undefined);
        url = new URL(res.headers.get("location")!, url).toString();
        continue;
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => "")).slice(0, 500);
        throw new ApiError(formatErrorMessage(res.status, url, text), res.status, url, text);
      }
      const data = await readCapped(res, opts.maxBytes, url);
      return {
        mime: res.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream",
        data,
        headers: res.headers,
        finalUrl: url,
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw new Error(`Timeout for ${url}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Too many redirects (>${maxRedirects}) from ${startUrl}`);
}

export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}

export function withQuery(
  url: string,
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

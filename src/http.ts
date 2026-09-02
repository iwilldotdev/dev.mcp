import { ApiError } from "./errors.js";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type HttpRequestInit = RequestInit & {
  timeoutMs?: number;
  maxRetries?: number;
  retryOn?: number[];
};

export type HttpClientOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const DEFAULT_RETRY_ON = [429, 503];

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
    const retryOn = init.retryOn ?? DEFAULT_RETRY_ON;
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

        const body = await readBody(res);
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
        if (attempt < maxRetries) {
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

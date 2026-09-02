import type { AppConfig } from "./config.js";
import { HttpClient, type FetchLike } from "./http.js";
import { MemoryCache } from "./cache.js";
import type { ExecFn } from "./clients/glab.js";

export type Runtime = {
  config: AppConfig;
  http: HttpClient;
  figmaCache: MemoryCache;
  exec?: ExecFn;
  fetch?: FetchLike;
};

export function createRuntime(
  config: AppConfig,
  overrides: Partial<Omit<Runtime, "config">> = {},
): Runtime {
  const http =
    overrides.http ??
    new HttpClient({
      fetch: overrides.fetch,
      timeoutMs: config.httpTimeoutMs,
      maxRetries: config.httpMaxRetries,
    });
  return {
    config,
    http,
    figmaCache: overrides.figmaCache ?? new MemoryCache(),
    exec: overrides.exec,
    fetch: overrides.fetch,
  };
}

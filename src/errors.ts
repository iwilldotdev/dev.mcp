export class ApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body?: unknown;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    status: number,
    url: string,
    body?: unknown,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.url = url;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isAuthOrPermissionError(err: unknown): boolean {
  return err instanceof ApiError && [401, 403, 404].includes(err.status);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body =
      typeof err.body === "string"
        ? err.body
        : err.body
          ? JSON.stringify(err.body)
          : "";
    return [err.message, body].filter(Boolean).join(" — ");
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

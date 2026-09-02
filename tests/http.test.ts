import { HttpClient, parseRetryAfter, backoffMs } from "../src/http.js";
import { ApiError } from "../src/errors.js";

function jsonResponse(body: unknown, init: { status?: number; headers?: HeadersInit } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("2")).toBe(2000);
  });

  it("parses HTTP date", () => {
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    const header = "Wed, 21 Oct 2015 07:28:05 GMT";
    expect(parseRetryAfter(header, now)).toBe(5000);
  });

  it("returns undefined when empty", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("HttpClient", () => {
  it("honors Retry-After on 429 and retries", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchMock: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return jsonResponse({ ok: true });
    };

    const http = new HttpClient({
      fetch: fetchMock,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxRetries: 3,
    });

    const body = await http.json<{ ok: boolean }>("https://example.test/x");
    expect(body).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([0]);
  });

  it("uses backoff when 429 has no Retry-After", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchMock: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("nope", { status: 429 });
      return jsonResponse({ ok: true });
    };
    const http = new HttpClient({
      fetch: fetchMock,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await http.json("https://example.test/x");
    expect(sleeps[0]).toBe(backoffMs(0));
  });

  it("throws ApiError after exhausting 429 retries", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "slow down" }), {
        status: 429,
        headers: { "content-type": "application/json", "Retry-After": "1" },
      });
    const http = new HttpClient({
      fetch: fetchMock,
      maxRetries: 1,
      sleep: async () => undefined,
    });
    await expect(http.json("https://example.test/x")).rejects.toMatchObject({
      name: "ApiError",
      status: 429,
      retryAfterMs: 1000,
    } satisfies Partial<ApiError>);
  });

  it("does not retry 400", async () => {
    let calls = 0;
    const fetchMock: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({ error: "bad" }, { status: 400 });
    };
    const http = new HttpClient({ fetch: fetchMock, sleep: async () => undefined });
    await expect(http.json("https://example.test/x")).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
  });
});

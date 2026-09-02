import { GitLabClient, GitLabRestClient } from "../src/clients/gitlab.js";
import { GlabClient, type ExecFn } from "../src/clients/glab.js";
import { HttpClient } from "../src/http.js";
import { MISSING } from "../src/config.js";

describe("GitLab fallback glab", () => {
  it("uses REST when the token works", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ iid: 1, title: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const rest = new GitLabRestClient(
      "https://gitlab.com",
      "glpat-test",
      new HttpClient({ fetch: fetchMock, sleep: async () => undefined }),
    );
    const exec: ExecFn = async () => {
      throw new Error("glab should not be called");
    };
    const client = new GitLabClient(rest, new GlabClient("https://gitlab.com", "glpat-test", exec));
    const issue = await client.request<{ iid: number }>("projects/1/issues/1");
    expect(issue.iid).toBe(1);
  });

  it("falls back to glab after REST 403", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "403 Forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    const rest = new GitLabRestClient(
      "https://gitlab.com",
      "glpat-guest",
      new HttpClient({ fetch: fetchMock, sleep: async () => undefined }),
    );
    const exec: ExecFn = async (command, args) => {
      if (command === "glab" && args[0] === "version") {
        return { stdout: "glab 1.0", stderr: "", code: 0 };
      }
      expect(args[0]).toBe("api");
      expect(args[1]).toBe("projects/1/issues/1");
      return { stdout: JSON.stringify({ iid: 1, title: "via glab" }), stderr: "", code: 0 };
    };
    const client = new GitLabClient(rest, new GlabClient("https://gitlab.com", "glpat-guest", exec));
    const issue = await client.request<{ title: string }>("projects/1/issues/1");
    expect(issue.title).toBe("via glab");
  });

  it("does not cache POST mutations — each call hits fetch", async () => {
    let calls = 0;
    const fetchMock: typeof fetch = async (_input, init) => {
      calls += 1;
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ iid: calls }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    };
    const rest = new GitLabRestClient(
      "https://gitlab.com",
      "glpat-test",
      new HttpClient({ fetch: fetchMock, sleep: async () => undefined }),
    );
    const exec: ExecFn = async () => {
      throw new Error("glab should not be called");
    };
    const client = new GitLabClient(rest, new GlabClient("https://gitlab.com", "glpat-test", exec));
    await client.request("projects/1/issues", { method: "POST", body: { title: "a" } });
    await client.request("projects/1/issues", { method: "POST", body: { title: "b" } });
    expect(calls).toBe(2);
  });

  it("instructs to install glab/token when REST fails and glab is missing", async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ message: "401 Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const rest = new GitLabRestClient(
      "https://gitlab.com",
      "bad",
      new HttpClient({ fetch: fetchMock, sleep: async () => undefined }),
    );
    const exec: ExecFn = async () => {
      const err = new Error("not found") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    };
    const client = new GitLabClient(rest, new GlabClient("https://gitlab.com", "bad", exec));
    await expect(client.request("projects/1/issues/1")).rejects.toThrow(MISSING.gitlab);
  });

  it("goes straight to glab when GITLAB_TOKEN is unset", async () => {
    const exec: ExecFn = async (command, args) => {
      if (args[0] === "version") return { stdout: "glab", stderr: "", code: 0 };
      return { stdout: JSON.stringify({ ok: true }), stderr: "", code: 0 };
    };
    const client = new GitLabClient(undefined, new GlabClient("https://gitlab.com", undefined, exec));
    const data = await client.request<{ ok: boolean }>("projects/1/issues");
    expect(data.ok).toBe(true);
  });

  it("GET /user and GET /projects with membership", async () => {
    const urls: string[] = [];
    const fetchMock: typeof fetch = async (input) => {
      urls.push(String(input));
      const url = String(input);
      const body = url.includes("/user")
        ? { id: 1, username: "dev" }
        : [{ id: 10, path_with_namespace: "g/p" }];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const rest = new GitLabRestClient(
      "https://gitlab.com",
      "glpat-test",
      new HttpClient({ fetch: fetchMock, sleep: async () => undefined }),
    );
    const exec: ExecFn = async () => {
      throw new Error("glab should not be called");
    };
    const client = new GitLabClient(rest, new GlabClient("https://gitlab.com", "glpat-test", exec));
    await expect(client.request("user")).resolves.toMatchObject({ username: "dev" });
    await expect(
      client.request("projects", {
        query: { membership: true, simple: true, per_page: 100, order_by: "last_activity_at" },
      }),
    ).resolves.toEqual([{ id: 10, path_with_namespace: "g/p" }]);
    expect(urls[0]).toBe("https://gitlab.com/api/v4/user");
    expect(urls[1]).toContain("/api/v4/projects?");
    expect(urls[1]).toContain("membership=true");
  });
});

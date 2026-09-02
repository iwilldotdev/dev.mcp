import { spawn } from "node:child_process";
import { MISSING } from "../config.js";

export type ExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

export type ExecFn = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; input?: string },
) => Promise<ExecResult>;

export async function defaultExec(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code,
      });
    });
    if (options.input != null) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

export function isGlabMissing(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export class GlabClient {
  constructor(
    private readonly host: string,
    private readonly token: string | undefined,
    private readonly exec: ExecFn = defaultExec,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async available(): Promise<boolean> {
    try {
      const result = await this.exec("glab", ["version"], { env: this.childEnv() });
      return result.code === 0;
    } catch (err) {
      if (isGlabMissing(err)) return false;
      return false;
    }
  }

  async api(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const args = ["api", normalizeGlabPath(path)];
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      args.push("-X", method);
    }
    const input = init.body === undefined ? undefined : JSON.stringify(init.body);
    if (input !== undefined) {
      args.push("--input", "-");
    }

    let result: ExecResult;
    try {
      result = await this.exec("glab", args, { env: this.childEnv(), input });
    } catch (err) {
      if (isGlabMissing(err)) {
        throw new Error(MISSING.gitlabGlabMissing);
      }
      throw err;
    }

    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim();
      throw new Error(`glab api failed (${result.code}): ${detail}`);
    }

    const text = result.stdout.trim();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.env };
    env.GITLAB_HOST = this.host;
    if (this.token) env.GITLAB_TOKEN = this.token;
    return env;
  }
}

export function normalizeGlabPath(path: string): string {
  return path.replace(/^\/+/, "").replace(/^api\/v4\//, "");
}

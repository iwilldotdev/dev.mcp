import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GitLabClient } from "../clients/gitlab.js";
import type { Runtime } from "../runtime.js";
import { registerGitLabCi } from "./gitlab-ci.js";
import type { Ctx } from "./gitlab-common.js";
import { registerGitLabCore } from "./gitlab-core.js";
import { registerGitLabRepo } from "./gitlab-repo.js";

/**
 * GitLab tools, named and parameterised like the official GitLab MCP server (prefix gitlab_), over REST with
 * the glab fallback. Pre-parity names stay as legacy aliases (DEV_MCP_LEGACY_TOOL_NAMES). See docs/official-parity.md.
 */
export function registerGitLabTools(server: McpServer, runtime: Runtime, gitlab: GitLabClient): void {
  const ctx: Ctx = { server, runtime, gl: gitlab };
  registerGitLabCore(ctx);
  registerGitLabRepo(ctx);
  registerGitLabCi(ctx);
}

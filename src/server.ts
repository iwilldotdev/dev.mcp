import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GitLabRestClient, GitLabClient } from "./clients/gitlab.js";
import { GlabClient, defaultExec } from "./clients/glab.js";
import { PACKAGE_NAME, PACKAGE_VERSION, type AppConfig } from "./config.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { registerConfluenceTools } from "./tools/confluence.js";
import { registerFigmaTools } from "./tools/figma.js";
import { registerGitLabTools } from "./tools/gitlab.js";
import { registerJiraTools } from "./tools/jira.js";

export function createGitLabClient(runtime: Runtime): GitLabClient {
  const { gitlab } = runtime.config;
  const rest = gitlab.token
    ? new GitLabRestClient(gitlab.host, gitlab.token, runtime.http)
    : undefined;
  const glab = new GlabClient(gitlab.host, gitlab.token, runtime.exec ?? defaultExec);
  return new GitLabClient(rest, glab);
}

export function createServer(config: AppConfig, runtimeOverrides?: Partial<Runtime>): McpServer {
  const runtime = createRuntime(config, runtimeOverrides);
  const server = new McpServer({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });
  registerFigmaTools(server, runtime);
  registerJiraTools(server, runtime);
  registerConfluenceTools(server, runtime);
  registerGitLabTools(server, runtime, createGitLabClient(runtime));
  return server;
}

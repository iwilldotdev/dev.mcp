export const PACKAGE_NAME = "dev.mcp";
export const PACKAGE_VERSION = "1.0.0";

export type FigmaConfig = {
  accessToken: string;
  apiBase: string;
  cacheTtlMs: number;
};

export type AtlassianConfig = {
  email: string;
  apiToken: string;
  site: string;
  baseUrl: string;
};

export type GitLabConfig = {
  host: string;
  token?: string;
};

export type AppConfig = {
  figma?: FigmaConfig;
  atlassian?: AtlassianConfig;
  gitlab: GitLabConfig;
  httpTimeoutMs: number;
  httpMaxRetries: number;
};

export const MISSING = {
  figma:
    "FIGMA_ACCESS_TOKEN is missing. Create a Personal Access Token at https://www.figma.com/settings with file content scope and set the variable in the MCP server env block. Do not use a View/Collab token in place of a Dev/Full seat.",
  atlassian:
    "Atlassian credentials are missing. Set ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN, and ATLASSIAN_SITE (e.g. your-site.atlassian.net).",
  gitlab:
    "GitLab REST failed (401/403/404 or missing token) and glab is not available. Export GITLAB_TOKEN with `api` scope or install the GitLab CLI (`glab`) and run `glab auth login`.",
  gitlabGlabMissing:
    "glab is not on PATH. Install the GitLab CLI (https://gitlab.com/gitlab-org/cli) and run `glab auth login`, or set GITLAB_TOKEN.",
};

function envInt(name: string, fallback: number, source: NodeJS.ProcessEnv): number {
  const raw = source[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function normalizeAtlassianSite(site: string): string {
  return site
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/\/wiki$/i, "");
}

export function normalizeGitLabHost(host: string): string {
  return host.replace(/\/+$/, "");
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const figmaToken = source.FIGMA_ACCESS_TOKEN?.trim();
  const email = source.ATLASSIAN_EMAIL?.trim();
  const apiToken = source.ATLASSIAN_API_TOKEN?.trim();
  const siteRaw = source.ATLASSIAN_SITE?.trim();
  const gitlabHost = normalizeGitLabHost(
    source.GITLAB_HOST?.trim() || "https://gitlab.com",
  );
  const gitlabToken = source.GITLAB_TOKEN?.trim();

  const figma: FigmaConfig | undefined = figmaToken
    ? {
        accessToken: figmaToken,
        apiBase: (source.FIGMA_API_BASE?.trim() || "https://api.figma.com").replace(
          /\/+$/,
          "",
        ),
        cacheTtlMs: envInt("FIGMA_CACHE_TTL_MS", 300_000, source),
      }
    : undefined;

  const atlassian: AtlassianConfig | undefined =
    email && apiToken && siteRaw
      ? {
          email,
          apiToken,
          site: normalizeAtlassianSite(siteRaw),
          baseUrl: `https://${normalizeAtlassianSite(siteRaw)}`,
        }
      : undefined;

  return {
    figma,
    atlassian,
    gitlab: {
      host: gitlabHost,
      token: gitlabToken,
    },
    httpTimeoutMs: envInt("HTTP_TIMEOUT_MS", 30_000, source),
    httpMaxRetries: envInt("HTTP_MAX_RETRIES", 3, source),
  };
}

export function requireFigma(config: AppConfig): FigmaConfig {
  if (!config.figma) throw new Error(MISSING.figma);
  return config.figma;
}

export function requireAtlassian(config: AppConfig): AtlassianConfig {
  if (!config.atlassian) throw new Error(MISSING.atlassian);
  return config.atlassian;
}

# dev.mcp

A [MCP](https://modelcontextprotocol.io/) **stdio** server in TypeScript. One process per developer; credentials live only in environment variables (the server never persists them to disk).

This is not a web app: it is a spec-compliant MCP server that any compatible harness starts as a subprocess (`node dist/index.js`).

Clone into **any folder**. The directory name is up to you; use that folder’s absolute path in harness `args`.

```bash
git clone <repo-url> [dir]
cd [dir]
npm install
npm run build
```

`[dir]` may be omitted (Git uses the repository name) or any relative/absolute path.

Requires **Node 20+**.

## Why this server

It replaces the official Figma, Atlassian (Jira + Confluence), and GitLab MCPs by talking to the REST APIs directly (and to `glab` when the GitLab API fails). Figma, Atlassian, and GitLab use the credentials you put in the harness `env` (a per-person token, or a shared Dev/Full Figma PAT).

### Figma — official MCP vs REST

The official MCP (`https://mcp.figma.com/mcp`) charges extra **daily/monthly** quotas per seat, on top of per-minute limits. REST has **no daily quota** for Dev/Full: only a leaky bucket per minute on Tier 1 (`GET file` / `nodes` / `image`). Starter has no Dev/Full seat.


| Seat / quota              | Starter (basic) | Professional     | Organization     | Enterprise       |
| ------------------------- | --------------- | ---------------- | ---------------- | ---------------- |
| MCP Dev/Full              | —               | 200/day + 10/min | 200/day + 15/min | 600/day + 20/min |
| MCP View/Collab           | 20/month        | 6/month          | 6/month          | 6/month          |
| REST Dev/Full (Tier 1)    | —               | 10/min           | 15/min           | 20/min           |
| REST View/Collab (Tier 1) | 6/month         | 6/month          | 6/month          | 6/month          |


If the team shares **one** PAT from a Figma Dev/Full account, the REST bucket stays shared (every agent counts against the same user). Versus the official MCP, the **ceiling** changes: that seat pays a **daily** quota plus per-minute; REST Dev/Full has **no daily quota**, only the Tier 1 per-minute leaky bucket. In-memory cache and `Retry-After` still help when several tools would reread the same file. View/Collab tokens (~6/month on Tier 1) are not a substitute for a Dev/Full seat.

**REST does not cover (accepted, read-only):** `use_figma`, `generate_figma_design`, `generate_diagram`, `create_new_file`, `upload_assets`. Code Connect write (`add_code_connect_map`) is also out of scope.

If the file lives on a **Starter** plan, Starter limits apply even if another team has a paid seat.

### Atlassian — Rovo vs REST

The Rovo MCP (`mcp.atlassian.com`) does not publish official quota numbers; reports of 429s after a few dozen parallel calls are common. API tokens use classic burst (`Retry-After`). The points-per-hour model (since 2026-03-02) applies to Forge/Connect/OAuth apps, **not** to API tokens.

This server’s scope: **Jira + Confluence** (Rovo tools that have REST). Out of scope: JSM, Bitbucket, Compass, Teamwork Graph, and `searchAtlassian` (Rovo/AI).

### GitLab — official MCP blocked; Guest is not enough

The native MCP (`/api/v4/mcp`) requires the group to have Duo on, beta features, and **Allow MCP server**. REST/GraphQL exist on Free.

Guest on a **private** project: can see issues; **cannot** see code, clone, or create MRs. Reporter is the minimum for repo/MR/CI.

Strategy: REST with `GITLAB_TOKEN` first; on 401/403/404 (permission) or a missing token, fall back to `glab` already authenticated on the machine (the developer’s real role).

Out of this slice (Duo / Premium / no simple REST): `list_duo_sessions`, `semantic_code_search`, `attach_scan_profile`, advanced GraphQL work items.

## Architecture

```
MCP harness (Cursor, Claude, VS Code, Gemini, Zed, Codex, …)
        │  JSON-RPC on stdin/stdout
        ▼
node dist/index.js          ← one process, stdout JSON-RPC only, logs on stderr
        │
        ├─ Figma REST + in-memory cache (GET files/nodes/images/variables)
        ├─ Jira REST + Confluence REST (Basic email:api_token)
        └─ GitLab REST ──401/403/404 or no token──► glab CLI
```

HTTP/SSE is **out of this slice**. The same tool set could later attach to `StreamableHTTPServerTransport` without rewriting handlers.

## Tools

Stable prefixes: `figma_*`, `jira_*`, `confluence_*`, `gitlab_*`.

### Figma


| Tool                       | REST                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `figma_whoami`             | `GET /v1/me`                                                                                              |
| `figma_get_file`           | `GET /v1/files/:key` (`depth` / `ids`)                                                                    |
| `figma_get_metadata`       | `GET /v1/files/:key/nodes` → slim XML (id, name, type, size; attrs de `hyperlink`/protótipo quando presentes) |
| `figma_get_screenshot`     | `GET /v1/images/:key`                                                                                     |
| `figma_get_variable_defs`  | `GET /v1/files/:key/variables/local` (+ published optional)                                               |
| `figma_get_design_context` | orchestrates nodes (layout, `visual`, text, hidden layers, `maskType`, component variants, style names, `hyperlink`/prototype `reactions`) + screenshot URL; `fields` seleciona blocos (`layout`, `visual`, `fills`, `strokes`, `text`, `component`) para encolher o payload; variables are off unless `includeVariables` is true; a node id returns its subtree until `depth` or the node/byte cap, any cut sets `truncated` with `truncation.hint` **and** `truncation.nextChildIds` (refetch those ids), missing ids are listed, the payload carries `lastModified` (freshness check for a persisted pack), and a screenshot failure is a warning that keeps the nodes (implementation context, not official proprietary codegen) |
| `figma_get_file_meta`      | `GET /v1/files/:key` at depth 1 → `{name, lastModified, version}`; cheap freshness check for a persisted Figma pack |
| `figma_get_frames`         | `GET /v1/files/:key` at depth 2 → frame index (`id`, `name`, `type`, `size`, `page`) for the ticket × frame join; one REST call, optional `pageName` filter |
| `figma_download_assets`    | `GET /v1/images` + image fills                                                                            |
| `figma_get_comments`       | `GET /v1/files/:key/comments`                                                                             |


### Jira

`jira_get_issue`, `jira_search_jql`, `jira_get_projects`, `jira_get_issue_types_metadata`, `jira_get_transitions`, `jira_create_issue`, `jira_edit_issue`, `jira_transition_issue`, `jira_add_comment`, `jira_add_worklog`, `jira_lookup_account_id`, `jira_get_remote_issue_links`, `jira_create_remote_issue_link`, `jira_get_issue_link_types`, `jira_create_issue_link`.

### Confluence

`confluence_get_spaces`, `confluence_get_pages_in_space`, `confluence_get_page`, `confluence_get_page_descendants`, `confluence_get_page_footer_comments`, `confluence_get_page_inline_comments`, `confluence_search_cql`, `confluence_create_page`, `confluence_update_page`, `confluence_create_footer_comment`, `confluence_create_inline_comment`.

### GitLab

`gitlab_whoami`, `gitlab_list_projects`, `gitlab_get_issue`, `gitlab_create_issue`, `gitlab_list_merge_requests`, `gitlab_get_merge_request` (optional commits/diffs/notes/pipelines), `gitlab_save_merge_request`, `gitlab_create_merge_request_note`, `gitlab_accept_merge_request`, `gitlab_add_branch`, `gitlab_add_commit`, `gitlab_get_repository_file`, `gitlab_get_commit`, `gitlab_list_pipelines`, `gitlab_get_pipeline`, `gitlab_get_pipeline_jobs`, `gitlab_get_job`, `gitlab_list_project_members`, `gitlab_search`, `gitlab_search_labels`, `gitlab_list_wiki_pages`.

`glab` fallback: `glab api` with the same paths. If `glab` is not on PATH and the API fails, the tool returns instructions to install `glab` or export `GITLAB_TOKEN`.

Providers without credentials stay listed: the tool returns a clear message instead of crashing the process.

## Tokens

There are two places for variables. **They are not equivalent.**

| Where | When to use |
| --- | --- |
| `env` block in the MCP config (`mcp.json`, etc.) | Normal use in Cursor, Claude, VS Code, Gemini, Zed, Codex |
| `.env` in this repository | Only `npm run dev` / `npm start` **inside this folder** |

In the harness, the subprocess almost always starts with cwd in the **project you are editing**, not this server’s folder. That is why this repo’s `.env` **does not load** in Cursor (or other clients). Put secrets in the MCP config `env` (next section). If the same variable exists in both, the harness wins: `.env` does not override it.

Do **not** commit `.env`. Copy [`.env.example`](.env.example) only for local development.

Names (the same in both places):

```
FIGMA_ACCESS_TOKEN=
ATLASSIAN_EMAIL=
ATLASSIAN_API_TOKEN=
ATLASSIAN_SITE=your-site.atlassian.net
GITLAB_HOST=https://gitlab.com
GITLAB_TOKEN=
```

Optional: `HTTP_TIMEOUT_MS` (default 30000), `HTTP_MAX_RETRIES` (3), `FIGMA_CACHE_TTL_MS` (300000).

### Figma

1. In a Figma account with a **Dev/Full** seat (yours, or the team’s shared account), open [Settings → Personal access tokens](https://www.figma.com/settings).
2. Create a token with **file content** scope (files, images, and variables) and use the same `FIGMA_ACCESS_TOKEN` in every harness.
3. Personal View/Collab accounts **do not** replace that PAT: on REST Tier 1 they get ~6 calls/month. The REST per-minute bucket is still shared among whoever uses that token; what you drop is the official MCP daily quota.

### Atlassian (Jira + Confluence)

1. Create an [API token](https://id.atlassian.com/manage-profile/security/api-tokens) for the developer’s account.
2. `ATLASSIAN_EMAIL` = Atlassian account email.
3. `ATLASSIAN_SITE` = site host, e.g. `your-site.atlassian.net` (no `https://`).
4. Auth: HTTP Basic `email:api_token`. No OAuth in this slice.

### GitLab

1. Preferred: [Personal Access Token](https://gitlab.com/-/user_settings/personal_access_tokens) with `api` scope, in `GITLAB_TOKEN`.
2. Alternative: `glab auth login` on the machine (the server calls `glab api` if REST returns 401/403/404 or the token is missing).
3. Guest is **not** enough for code/MRs. Use Reporter or above on private projects.

Default `GITLAB_HOST`: `https://gitlab.com`. Self-managed: `https://gitlab.yourcompany.com`.

## Harness configuration

Token variables go in the `env` block below — not in this repo’s `.env`.

Canonical binary (`/path/to/clone` = absolute path of the folder you cloned into):

```text
command: node
args:    ["/path/to/clone/dist/index.js"]
```

The same binary works for every client. Only the config file/CLI changes.

### Canonical example (`mcp.json` / Claude Desktop)

```json
{
  "mcpServers": {
    "dev.mcp": {
      "command": "node",
      "args": ["/path/to/clone/dist/index.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_…",
        "ATLASSIAN_EMAIL": "you@example.com",
        "ATLASSIAN_API_TOKEN": "…",
        "ATLASSIAN_SITE": "your-site.atlassian.net",
        "GITLAB_HOST": "https://gitlab.com",
        "GITLAB_TOKEN": "glpat-…"
      }
    }
  }
}
```

### Cursor

- Global: `~/.cursor/mcp.json`
- Per repo: `.cursor/mcp.json`
- Or **Settings → MCP → Add server**

Use the canonical JSON above.

### Claude Code

```bash
claude mcp add dev.mcp -- node /path/to/clone/dist/index.js
```

Pass the environment with CLI flags (`--env` / `--env-file`, depending on version). Do not rely on a TTY.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`; Linux: `~/.config/Claude/`) and paste the canonical `mcpServers` block.

### VS Code / GitHub Copilot

- Command Palette → **MCP: Add Server**
- Or `.vscode/mcp.json` in the workspace

VS Code JSON often uses `"servers"` instead of `"mcpServers"`:

```json
{
  "servers": {
    "dev.mcp": {
      "command": "node",
      "args": ["/path/to/clone/dist/index.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_…"
      }
    }
  }
}
```

### Gemini CLI / Gemini Code Assist

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "dev.mcp": {
      "command": "node",
      "args": ["/path/to/clone/dist/index.js"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_…"
      }
    }
  }
}
```

### Zed

`agent: open settings` → **MCP Servers**. Equivalent:

```json
{
  "context_servers": {
    "dev.mcp": {
      "command": {
        "path": "node",
        "args": ["/path/to/clone/dist/index.js"],
        "env": {
          "FIGMA_ACCESS_TOKEN": "figd_…"
        }
      }
    }
  }
}
```

### OpenAI Codex

```bash
codex mcp add dev.mcp -- node /path/to/clone/dist/index.js
```

Set env vars in the Codex profile or on the command, depending on the CLI.

## Companion harness

This server exposes tools. It does not impose gates, evidence, or a development cycle.

[dev.harness](https://github.com/iwilldotdev/dev.harness) is the companion workflow: two flows — Feature (spec-driven) and Bug (reproduce / root-cause-first) — plus the review skills `dev-qa-guided-review` and `dev-mr-guided-review`. Those skills consume **this** server, not the official Figma, Atlassian, or GitLab MCP servers.

Figma REST quota and `dev.mcp` bind are documented above. The harness does not replace this `mcp.json` (or equivalent host) configuration.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm run dev    # stdio; only useful behind an MCP client
```

Tests (Vitest): Retry-After on 429, Figma cache/dedup, no cache on GitLab POST, `403 → glab` fallback.

Rules so other clients keep working:

- **stdout is JSON-RPC only**; logs go to `stderr`
- Standard JSON Schema (Zod → `inputSchema`)
- No Cursor-specific APIs, headers, or prompts
- No dynamic OAuth (env vars) — works in headless harnesses (CI, Claude Code, Codex)
- No dashboard, persisted auth, database, or second HTTP process

## License

[MIT](LICENSE)

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

### GitLab — why REST instead of the official MCP

The official server (`/api/v4/mcp`) is generally available since GitLab 19.5. It needs a fine-grained PAT or OAuth with the `mcp` scope; classic PATs get a 403. dev.mcp uses REST with the same tool names, plus `save_to` and the `glab` fallback.

Guest on a **private** project: can see issues; **cannot** see code, clone, or create MRs. Reporter is the minimum for repo/MR/CI.

Strategy: REST with `GITLAB_TOKEN` first; on 401/403/404 (permission) or a missing token, fall back to `glab` already authenticated on the machine (the developer’s real role).

Out of scope (Duo, Premium/Ultimate, or GraphQL only): `semantic_search`, the Duo agent and session tools, `post_duo_review`, `code_security`, `orbit`, saved views, work item types, group-level work items and epics.

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

Tool names follow the official MCP servers: `<vendor>_<official name in snake_case>`, with the official parameters. The goal is that dev.mcp can replace the official GitLab, Atlassian Rovo and Figma servers. The full mapping, and what is out of scope because REST cannot do it, is in [`docs/official-parity.md`](docs/official-parity.md).

Pre-parity names (used by dev.harness and older dev.factory versions) stay registered as **deprecated aliases** with their old parameters. Set `DEV_MCP_LEGACY_TOOL_NAMES=0` to hide them.

Write tools say so in their description. Large read tools accept `save_to` (see [Saving payloads to disk](#saving-payloads-to-disk)).

### Figma

| Tool | What it does |
|---|---|
| `figma_whoami` | Authenticated Figma user. |
| `figma_get_file` | Document tree (`depth`, `ids`/`nodeId`), with `save_to`. |
| `figma_get_file_meta` | File name, `lastModified` and version (freshness check). |
| `figma_get_frames` | Frame index with page and section paths. |
| `figma_get_metadata` | Slim XML tree (`nodeId`/`nodeIds`, `depth`). |
| `figma_get_design_context` | REST implementation context: layout, `visual`, text, hidden layers, component variants, style names, prototype `reactions`, and a screenshot URL. `fields` picks blocks; truncation returns `truncation.nextChildIds`. **No code generation**, unlike the official tool. |
| `figma_get_screenshot` | Rendered image of a node, returned as image content (`nodeId`/`nodeIds`, `format`, `scale`); `save_to` writes PNGs. **Changed in 1.3.0:** it used to return temporary URLs. |
| `figma_fetch_screenshot` | Extra, identical to `figma_get_screenshot`. |
| `figma_get_image_urls` | Temporary render URLs (the pre-1.3.0 `figma_get_screenshot` output). |
| `figma_get_variable_defs` | Whole-file variables, or with `nodeId` the variables and styles used under that node. Without an Enterprise plan the variables API fails, and the tool still returns styles and bound ids with a warning. |
| `figma_download_assets` | Export URLs and image fills (`defaultFormat`/`defaultScale`); with `save_to` it downloads the files. |
| `figma_get_comments` | File comments, filtered by `resolved`, `author`, `mention` and `page`. |
| `figma_get_figjam` | FigJam nodes as slim XML, sticky/shape text and a screenshot. |

### Jira

Every tool accepts an optional `cloudId`. `cloudId` is checked against the configured site: a hostname must equal `ATLASSIAN_SITE`; a UUID must equal the tenant id read once from `https://<site>/_edge/tenant_info` (cached per process). A mismatch is rejected. If the tenant lookup fails, writes are rejected (`cloudId mismatch-unknown`) and reads continue with a warning. Without `cloudId` nothing changes.

- **Read:** `jira_get_issue`, `jira_search_issues_using_jql`, `jira_list_projects`, `jira_list_project_issue_types_metadata`, `jira_get_issue_type_meta_with_fields`, `jira_list_issue_transitions`, `jira_list_issue_link_types`, `jira_list_issue_remote_issue_links`, `jira_list_issue_comments`, `jira_list_issue_changelogs`, `jira_list_issue_worklogs`, `jira_list_issue_assignable_users`, `jira_get_current_user`, `jira_get_user`, `jira_lookup_account_id`, `jira_list_statuses`, `jira_list_project_components`, `jira_get_project_versions`, `jira_list_boards`, `jira_get_board_config`, `jira_get_board_issue_data`, `jira_list_board_sprints`, `jira_get_board_sprint_data`, `jira_list_filters`, `jira_list_dashboards`, `jira_download_issue_attachment`.
- **Extras:** `jira_normalize_issue` (normalized issue with AC, links and unknowns) and `jira_get_comments` (rich thread with images).
- **Write:** `jira_create_issue` (`issueType`, `assignee`), `jira_edit_issue`, `jira_transition_issue` (optional `sprintId` or `moveToBacklog`), `jira_add_or_edit_issue_comment` (`commentId` edits), `jira_add_or_edit_issue_worklog` (`worklogId` edits), `jira_create_issue_link`, `jira_create_issue_remote_issue_link`, `jira_watch_issue`.
- **Legacy aliases:** `jira_search_jql`, `jira_get_projects`, `jira_get_issue_types_metadata`, `jira_get_transitions`, `jira_get_issue_link_types`, `jira_get_remote_issue_links`, `jira_add_comment`, `jira_add_worklog`, `jira_create_remote_issue_link`.

### Confluence

Every tool accepts an optional `cloudId`, validated as in the Jira section.

| Tool | Notes |
|---|---|
| `confluence_list_spaces`, `confluence_get_space` | Space id or key. |
| `confluence_list_content`, `confluence_get_content` | `contentType`, `detail` (`summary`/`full`), `save_to`. `get_content` returns a `snapshotToken`. |
| `confluence_create_content` (write) | Page or blog post with `body{format,value}`, in `storage` or `atlas_doc_format` (Markdown is rejected). Folder, whiteboard and database with `parent`. |
| `confluence_update_content` (write) | Needs the `snapshotToken` from `get_content`; a stale token is refused as a conflict. |
| `confluence_list_content_versions`, `confluence_get_content_version` | Pages and blog posts. |
| `confluence_list_comments`, `confluence_get_comment` | Footer, inline or all. |
| `confluence_create_comment`, `confluence_update_comment`, `confluence_update_comment_resolution` (write) | Replies via `parentCommentId`. |
| `confluence_search` | CQL, with `cursor`. |
| `confluence_list_attachments`, `confluence_get_attachment`, `confluence_download_attachment` | The download writes the file with `save_to`. |
| `confluence_list_tasks`, `confluence_get_task`, `confluence_complete_task`, `confluence_reopen_task` (write) | |
| `confluence_add_labels_to_content` (write) | |
| `confluence_get_page_descendants` | Extra. |

**Legacy aliases:** `confluence_get_spaces`, `confluence_get_pages_in_space`, `confluence_get_page`, `confluence_get_page_footer_comments`, `confluence_get_page_inline_comments`, `confluence_search_cql`, `confluence_create_page`, `confluence_update_page`, `confluence_create_footer_comment`, `confluence_create_inline_comment`.

### GitLab

Parameters are in snake_case, like the official server. The legacy camelCase spellings are still accepted and marked deprecated. CI and repository tools also accept `id` for the project. List tools page with `first`/`after` and return `next_cursor`; the pre-1.3.0 list tools still return a plain array when no cursor argument is given.

- **Users and projects:** `gitlab_get_user`, `gitlab_get_mcp_server_version`, `gitlab_list_projects`, `gitlab_get_project`, `gitlab_list_groups`, `gitlab_get_group`, `gitlab_list_project_members`, `gitlab_list_todos`, `gitlab_list_user_events`, `gitlab_list_milestones`.
- **Work items:** `gitlab_get_work_item`, `gitlab_list_work_items`, `gitlab_save_work_item`, `gitlab_link_work_items`, `gitlab_save_note`.
- **Merge requests:** `gitlab_list_merge_requests`, `gitlab_get_merge_request` (`include`, `url`), `gitlab_save_merge_request`, `gitlab_accept_merge_request` (`sha`), `gitlab_save_merge_request_review` (`create_note`, `reply_discussion`, `create_diff_note`, `resolve_discussion`, `update_note`, `submit_review`, `approve`, `unapprove`), `gitlab_apply_suggestion`.
- **Repository:** `gitlab_add_branch`, `gitlab_add_commit`, `gitlab_get_repository_file` (line slicing), `gitlab_get_commit` (`include: diff|notes`), `gitlab_list_branches`, `gitlab_list_repository_tree`, `gitlab_list_commits`, `gitlab_list_tags`, `gitlab_list_releases`.
- **CI:** `gitlab_list_pipelines`, `gitlab_get_pipeline` (`include`), `gitlab_get_job` (`include: log|artifacts`), `gitlab_get_artifact_file`, `gitlab_save_pipeline`, `gitlab_save_pipeline_job`, `gitlab_list_pipeline_schedules`.
- **Search and wiki:** `gitlab_search`, `gitlab_search_labels`, `gitlab_list_wiki_pages`, `gitlab_get_wiki_page` (project or group scope).
- **Legacy aliases:** `gitlab_whoami`, `gitlab_get_issue`, `gitlab_create_issue`, `gitlab_create_merge_request_note`, `gitlab_get_pipeline_jobs`.

`glab` fallback: `glab api` with the same paths. If `glab` is not on PATH and the API fails, the tool returns instructions to install `glab` or export `GITLAB_TOKEN`.

Providers without credentials stay listed: the tool returns a clear message instead of crashing the process.

## Saving payloads to disk

These read tools accept an optional `save_to` (absolute path) so an agent can persist a large raw payload without echoing it through the model:

| Tools | `save_to` | Written |
| ----- | --------- | ------- |
| Every read tool whose schema lists `save_to`: most Figma reads, Jira issue/search/comments/changelogs/board reads, `confluence_get_content`, and almost all GitLab reads. The legacy aliases keep the `save_to` they had. | `.json` file | the full payload as pretty UTF-8 JSON (plus `<name>.images/` for Jira images) |
| `figma_get_screenshot`, `figma_fetch_screenshot` | `.png` file, or a directory (existing, or a path ending in `/` or `\`; required for several nodes) | decoded PNG bytes; `<node-id-dashed>.png` per node in a directory |
| `figma_download_assets` | a file, or a directory for several nodes; the extension must match `format` (png, jpg, svg, pdf) | the exported files |
| `jira_download_issue_attachment`, `confluence_download_attachment` | a file, or a directory that receives the server-provided file name | the attachment bytes |

**Binary downloads.** For downloaded files, the file name the server provides is sanitised: only its last segment is kept, `:` is replaced, leading dots and trailing dots or spaces are removed, the length is capped, and device names (`CON`, `NUL`, ...) are refused. The extension must be one of png, jpg, jpeg, gif, webp, svg, pdf, zip, txt, csv, json, md, docx, xlsx or pptx. The target is checked before any network call, and again once the file name is known. Downloads are capped at `DEV_MCP_SAVE_MAX_MB` (default 100). Atlassian credentials are sent only to the configured site: redirects are followed manually, and any other host (for example the media CDN) gets no `Authorization` header.

With `save_to` the tool returns only `{saved_to, bytes, sha256, kind: "json"|"png"|"file", summary}` (`summary` holds a few key fields such as MR iid/state/sha/web_url, issue key/status, or Figma name/lastModified/node ids). Image tools return no image content. Without `save_to` nothing changes. `jira_normalize_issue` and `jira_get_comments` also save their embedded images next to the JSON as `<name>.images/<n>.<ext>` and list them in `summary.images`. `figma_get_screenshot` with `save_to` downloads the render (PNG only).

Safety (this turns a read tool into a file writer):

- The path must be absolute and inside the allowed roots. The default root is **`<os tmpdir>/dev.mcp` only** (created `0700`); it is no longer the home directory.
- Existing files are **not** overwritten unless the call passes `overwrite: true`. Overwrite, path, roots, and extension are all checked before any network call.
- Any dot-prefixed path segment (`.ssh`, `.claude`, `.claude.json`, `.git`, `.vscode`, `.config`, `.aws`, `.gnupg`, `.npmrc`, `.env*`, ...) is refused, even inside an allowed root, except the names in `DEV_MCP_SAVE_ALLOW_DOT` (default `.factory`, so `~/.factory/runs` works when it is a configured root).
- No `..` escape, no symlink/junction escape (the real path of the nearest existing parent must stay inside a root, re-checked right before the write), extension must match the kind (`.json`, `.png`, or the binary allow-list above), no `:` after the drive letter (NTFS alternate streams), and no segment ending in a dot or space.
- Directories are created `0700` and files `0600` on POSIX; temp files are opened exclusively and the final step is an atomic rename. The spill folder is per user (`dev.mcp-spill-<uid>`) and refused if it is a symlink or owned by someone else.
- Several nodes whose ids map to the same file name (`1:2` and `1-2`) are an error. Failures come back as tool errors and nothing is partially written.

| Variable | Meaning |
| -------- | ------- |
| `DEV_MCP_SAVE_ROOTS` | Allowed roots, separated by the OS path delimiter (`;` on Windows, `:` elsewhere). Default when unset: `<os tmpdir>/dev.mcp`. |
| `DEV_MCP_SAVE_ALLOW_DOT` | Dot-prefixed path segments that stay allowed, comma-separated. Default: `.factory`. |
| `DEV_MCP_SPILL_KB` | Optional auto-spill. Integer; unset or `0` disables it. When set and a supported tool is called **without** `save_to` and its payload exceeds this many KB (images: decoded bytes), the payload is saved to `<spill dir>/<tool>-<timestamp>-<shorthash>.<json\|png>` and the tool returns the compact summary plus `spilled: true` and a hint with the path. |
| `DEV_MCP_SPILL_DIR` | Spill folder override (must also be inside the allowed roots). Default: `dev.mcp-spill-<uid>` under the default root (or the first allowed root). |
| `DEV_MCP_SAVE_MAX_MB` | Size cap for downloaded and saved bytes, in MB. Default: `100`. |

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

Optional: `HTTP_TIMEOUT_MS` (default 30000), `HTTP_MAX_RETRIES` (3), `FIGMA_CACHE_TTL_MS` (300000), `DEV_MCP_LEGACY_TOOL_NAMES` (default on; `0` hides the pre-1.3.0 tool names), `DEV_MCP_PARITY_WRITES` (default off; see below).

**`DEV_MCP_PARITY_WRITES`.** dev.factory read-only agents block writes by listing tool names, and those lists only know the pre-1.3.0 names. So the 19 write tools added in 1.3.0 are not registered unless `DEV_MCP_PARITY_WRITES=1`: `gitlab_save_note`, `gitlab_save_work_item`, `gitlab_link_work_items`, `gitlab_save_merge_request_review`, `gitlab_apply_suggestion`, `gitlab_save_pipeline`, `gitlab_save_pipeline_job`, `jira_add_or_edit_issue_comment`, `jira_add_or_edit_issue_worklog`, `jira_create_issue_remote_issue_link`, `jira_watch_issue`, `confluence_create_content`, `confluence_update_content`, `confluence_create_comment`, `confluence_update_comment`, `confluence_update_comment_resolution`, `confluence_complete_task`, `confluence_reopen_task`, `confluence_add_labels_to_content`. Write tools that already existed (`gitlab_save_merge_request`, `gitlab_accept_merge_request`, `gitlab_add_commit`, `jira_create_issue`, `jira_transition_issue`, `confluence_create_page`, the legacy aliases, ...) are always registered. Turn the flag on once your agents block writes by name pattern (for example `*_save_*`, `*_create_*`, `*_add_*`) instead of an old-name list.

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

Tests (Vitest): Retry-After on 429, Figma cache/dedup, no cache on GitLab POST, `403 → glab` fallback, `save_to` and auto-spill (roots, traversal, extension, atomic write), binary downloads (file-name sanitising, size cap, no cross-origin auth), and the official-parity suites `tests/parity-*.test.ts` (REST path, method and body per tool, legacy aliases, `DEV_MCP_LEGACY_TOOL_NAMES=0`).

When a tool is added or renamed, update [`docs/official-parity.md`](docs/official-parity.md) and keep the official name and parameters.

Rules so other clients keep working:

- **stdout is JSON-RPC only**; logs go to `stderr`
- Standard JSON Schema (Zod → `inputSchema`)
- No Cursor-specific APIs, headers, or prompts
- No dynamic OAuth (env vars) — works in headless harnesses (CI, Claude Code, Codex)
- No dashboard, persisted auth, database, or second HTTP process

## License

[MIT](LICENSE)

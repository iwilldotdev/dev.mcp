# Parity with the official MCP servers

Goal: dev.mcp can replace the official GitLab, Atlassian Rovo (Jira and Confluence) and Figma MCP servers in daily work. Each tool has the same name (with a vendor prefix), the same parameters and the same behaviour wherever REST can do it. dev.mcp keeps its extras: Figma REST without the daily MCP quota, `save_to`/spill, the `glab` fallback and `jira_normalize_issue`.

Checked 2026-11-23 against:

- GitLab: <https://docs.gitlab.com/user/model_context_protocol/mcp_server_tools/>
- Atlassian Rovo: <https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/>
- Figma: <https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/>

## Naming rules

1. **Name:** `<vendor>_<official name in snake_case>`. For Rovo, drop the redundant vendor word, so `getJiraIssue` becomes `jira_get_issue` and `searchJiraIssuesUsingJql` becomes `jira_search_issues_using_jql`. GitLab already exposes `gitlab_<name>` when its official server is given the tool-name prefix `gitlab_`.
2. **Parameters:** the official spelling. GitLab uses snake_case (`project_id`, `merge_request_iid`, and `id` on the CI and repository tools); Rovo and Figma use camelCase. Every Rovo tool also takes an optional `cloudId`. dev.mcp serves one configured site, so a `cloudId` for another site is rejected. `cloudId` is checked against the configured site: a hostname must equal `ATLASSIAN_SITE`; a UUID must equal the tenant id read once from `https://<site>/_edge/tenant_info` (cached per process). A mismatch is rejected. If the tenant lookup fails, writes are rejected (`cloudId mismatch-unknown`) and reads continue with a warning. Without `cloudId` nothing changes.
3. **Same name, new parameters:** when a tool keeps its name but its parameters change (for example `gitlab_get_merge_request`), the tool accepts both the official and the legacy spelling. Legacy parameters are described as deprecated. Tests cover both.
4. **New name:** when a tool is renamed, the old name stays as a **legacy alias** registered with `registerLegacyAlias` (`src/tools/register.ts`). The alias keeps the old schema exactly and maps it onto the canonical implementation. Aliases are on by default and switched off with `DEV_MCP_LEGACY_TOOL_NAMES=0`. They stay until dev.factory and dev.harness stop using the old names.
5. **Read tools** that can return large payloads accept `save_to`/`overwrite` (`wrapSaveTool`) and get a compact summary.
6. **Not REST:** a tool the official server has but REST cannot implement (Duo, codegen, Rovo AI, Figma write) is not registered. It is listed under "Out of scope" below.

## Gated write tools (`DEV_MCP_PARITY_WRITES`)

dev.factory read-only agents block writes by listing tool names, and the lists predate 1.3.0. A write tool that did not exist under the same name before 1.3.0 is therefore registered only when `DEV_MCP_PARITY_WRITES=1` (default off), through `registerWriteTool` (`src/tools/register.ts`) or `parityWriteTool` (GitLab). The 19 gated tools:

`gitlab_save_note`, `gitlab_save_work_item`, `gitlab_link_work_items`, `gitlab_save_merge_request_review`, `gitlab_apply_suggestion`, `gitlab_save_pipeline`, `gitlab_save_pipeline_job`, `jira_add_or_edit_issue_comment`, `jira_add_or_edit_issue_worklog`, `jira_create_issue_remote_issue_link`, `jira_watch_issue`, `confluence_create_content`, `confluence_update_content`, `confluence_create_comment`, `confluence_update_comment`, `confluence_update_comment_resolution`, `confluence_complete_task`, `confluence_reopen_task`, `confluence_add_labels_to_content`.

Not gated, because the name already existed and agents already classify it: `gitlab_save_merge_request`, `gitlab_accept_merge_request` (new optional `sha` guard), `gitlab_add_branch`, `gitlab_add_commit`, `gitlab_create_issue`, `gitlab_create_merge_request_note`, `jira_create_issue`, `jira_edit_issue`, `jira_transition_issue` (new optional `sprintId` and `moveToBacklog`, which can move an issue to a sprint or the backlog), `jira_create_issue_link`, `jira_add_comment`, `jira_add_worklog`, `jira_create_remote_issue_link`, `confluence_create_page`, `confluence_update_page`, `confluence_create_footer_comment`, `confluence_create_inline_comment`.

Write requests are retried only on HTTP 429 (never after a 503 or a network error, which could duplicate the write). Reads keep retrying 429 and 503.

## Scope of this release (tranche 1)

### GitLab
Renames, each keeping a legacy alias:

| New name | Legacy alias |
|---|---|
| `gitlab_get_user` (`me`/`username`/`id`) | `gitlab_whoami` |
| `gitlab_save_note` (MR or work item; create, reply, update, resolve) | `gitlab_create_merge_request_note` |
| `gitlab_get_work_item` | `gitlab_get_issue` |
| `gitlab_save_work_item` (create and update) | `gitlab_create_issue` |
| `gitlab_get_pipeline` with `include: jobs\|downstream_pipelines\|bridge_jobs\|artifacts` | `gitlab_get_pipeline_jobs` |

Official parameters on the existing tools:

- `gitlab_get_merge_request` gains `include` with `discussions` and `approvals`, plus `url`.
- `gitlab_list_merge_requests` gains group scope and people filters.
- `gitlab_accept_merge_request` gains `sha`.
- `gitlab_get_job` gains `include: log|artifacts` with byte ranges.
- `gitlab_get_repository_file` gains `offset`/`limit` line slicing.
- `gitlab_get_commit` gains `include: diff|notes`.
- `gitlab_add_commit` gains `start_sha`/`start_project`.
- `gitlab_search` gains group scope and filters.
- `gitlab_search_labels` gains group scope and several terms.
- `gitlab_list_projects` gains `group_id` and `archived`.
- `gitlab_list_wiki_pages` gains group scope.

New tools:

- **Project, group and user:** `get_mcp_server_version`, `get_project`, `get_group`, `list_groups`, `list_todos`, `list_user_events`, `list_milestones`.
- **Work items:** `list_work_items`, `link_work_items`.
- **Merge requests:** `save_merge_request_review` (every method except `post_duo_review`), `apply_suggestion`.
- **Repository:** `list_branches`, `list_repository_tree`, `list_commits`, `list_tags`, `list_releases`.
- **CI:** `get_artifact_file`, `save_pipeline` (create, retry, cancel, update, MR pipeline), `save_pipeline_job` (play), `list_pipeline_schedules`.
- **Wiki:** `get_wiki_page`.

### Jira
Renames, each keeping a legacy alias:

| New name | Legacy alias |
|---|---|
| `jira_search_issues_using_jql` | `jira_search_jql` |
| `jira_list_projects` | `jira_get_projects` |
| `jira_list_project_issue_types_metadata` + `jira_get_issue_type_meta_with_fields` | `jira_get_issue_types_metadata` |
| `jira_list_issue_transitions` | `jira_get_transitions` |
| `jira_list_issue_link_types` | `jira_get_issue_link_types` |
| `jira_list_issue_remote_issue_links` | `jira_get_remote_issue_links` |
| `jira_add_or_edit_issue_comment` | `jira_add_comment` |
| `jira_add_or_edit_issue_worklog` | `jira_add_worklog` |
| `jira_create_issue_remote_issue_link` | `jira_create_remote_issue_link` |

`jira_create_issue` accepts `issueType`/`assignee`. `jira_transition_issue` accepts a sprint or backlog move.

New tools:

- **Issue reads:** `list_issue_comments`, `list_issue_changelogs`, `list_issue_worklogs`, `list_issue_assignable_users`.
- **Users and statuses:** `get_current_user`, `get_user`, `list_statuses`.
- **Projects:** `list_project_components`, `get_project_versions`.
- **Boards and sprints:** `list_boards`, `get_board_config`, `get_board_issue_data`, `list_board_sprints`, `get_board_sprint_data`.
- **Filters and dashboards:** `list_filters`, `list_dashboards`.
- **Attachments and watching:** `download_issue_attachment` (with `save_to`), `watch_issue`.

Extras kept: `jira_normalize_issue` and `jira_get_comments` (rich thread with images).

### Confluence
Renames, each keeping a legacy alias:

| New name | Legacy alias |
|---|---|
| `confluence_get_content` (`contentType`, `detail`; returns `snapshotToken`) | `confluence_get_page` |
| `confluence_list_content` | `confluence_get_pages_in_space` |
| `confluence_list_spaces` | `confluence_get_spaces` |
| `confluence_list_comments` | `confluence_get_page_footer_comments`, `confluence_get_page_inline_comments` |
| `confluence_create_comment` | `confluence_create_footer_comment`, `confluence_create_inline_comment` |
| `confluence_search` | `confluence_search_cql` |
| `confluence_create_content` (`contentType`, `parent`, `body{format,value}`) | `confluence_create_page` |
| `confluence_update_content` (`snapshotToken` encodes the version read) | `confluence_update_page` |

New tools:

- **Spaces:** `get_space`.
- **Comments:** `get_comment`, `update_comment`, `update_comment_resolution`.
- **Versions:** `list_content_versions`, `get_content_version`.
- **Attachments:** `list_attachments`, `get_attachment`, `download_attachment` (with `save_to`).
- **Tasks:** `list_tasks`, `get_task`, `complete_task`, `reopen_task`.
- **Labels:** `add_labels_to_content`.

Extra kept: `confluence_get_page_descendants`.

### Figma

- `figma_get_screenshot` now returns the image itself, like the official tool and like today's `figma_fetch_screenshot`. Temporary render URLs move to the new `figma_get_image_urls`. `figma_fetch_screenshot` stays as an extra with the same behaviour.
- Every node tool accepts the official `nodeId` (singular, `"1:2"` or `"1-2"`) alongside `nodeIds`.
- `figma_get_variable_defs` accepts `nodeId` and returns the variables and styles used under that node. Without it, it returns the whole file, as before.
- `figma_download_assets` gains `defaultFormat`/`defaultScale`, and with `save_to` (a directory) downloads the files instead of returning URLs.
- `figma_get_comments` gains filters (`resolved`, `author`, `mention`, `page`), applied locally.
- New: `figma_get_figjam` (FigJam nodes as slim XML plus a screenshot).
- `figma_get_design_context` keeps its name and REST semantics. It does no code generation; the description says so.

## Out of scope (not REST, or needs a paid add-on)

- **GitLab:** `semantic_search`, the Duo agent and session tools, `post_duo_review`, `code_security`, `orbit`, saved views, `get_work_item_types` (GraphQL only), group-level work items and epics.
- **Jira:** `getJiraWorkflowEditorLink`; the disabled-by-default delete and manage groups (to do later, behind a flag).
- **Confluence:** reactions, star/unstar, public links, export to PDF/Word, live-doc conversion, space instructions, Rovo AI suggestions.
- **Figma:** Code Connect, `use_figma` and every write or generate tool, motion and video, Weave, the `create_design_system_rules` prompt.

## Later tranches

- **GitLab:** `save_project`, `fork_repository`.
- **Jira:**
  - Versions: `get_project_version_related_work`, `manage_project_version(_related_work)`.
  - Sprints and boards: `manage_sprint`, `create_board`.
  - Other: `upload_attachment_to_issue` (needs upload-path rules like `save_to`), entity properties, the delete tools behind a flag.
- **Confluence:**
  - Spaces: `get_personal_space`, `create_space`.
  - Content: `copy_content`, `move_content`, `archive_content`, `restore_content_version`, `set_content_status`, `diff_content_versions`.
  - Other: permissions, templates, `resolve_content_macros`, watch tools, `create_attachment`.
- **Figma:** `get_libraries`, `search_design_system`.
- **Rovo parameter schemas:** capture them with `tools/list` against `https://mcp.atlassian.com/v2/mcp?tools=all` and compare.

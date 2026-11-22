# Agent integrations

CodeGraph works with any agent that can run MCP servers or shell commands. The
repo-local skill is [`.claude/skills/codegraph/SKILL.md`](../.claude/skills/codegraph/SKILL.md);
the auto-index helper is [`scripts/codegraph-auto-index.mjs`](../scripts/codegraph-auto-index.mjs).

| Agent              | MCP config             | Auto-index                               |
| ------------------ | ---------------------- | ---------------------------------------- |
| Claude Code        | `.mcp.json`            | `SessionStart` + `PostToolUse` hooks     |
| Codex              | `~/.codex/config.toml` | `AGENTS.md` instruction + git hooks      |
| Copilot (VS Code)  | `.vscode/mcp.json`     | folder-open task + git hooks             |
| opencode           | `opencode.json`        | plugin on `file.edited` / `session.idle` |
| Any agent / editor | —                      | git hooks in `integrations/git-hooks`    |

Replace `/absolute/path/to/codegraph` with this repository (or an installed CLI).
The database defaults to `.codegraph.sqlite` in the working directory; set
`CODEGRAPH_DB_PATH` to keep one shared database.

## MCP-first indexing

Indexing is static: CodeGraph parses files and never executes the indexed
project's scripts or tests. The cleanest setup is the MCP tool:

1. Call `index_status`; if `stale=true`, call `index_repository` with the
   repository path (`async=true` for large repos), then poll `index_job_status`.
2. Keep `index_repository` in the agent's session-start instructions.

The auto-index helper, plugins and git hooks below are optional conveniences for
clients that cannot call MCP tools from hooks. They only invoke the CodeGraph
CLI; they do not run project code. Skip them if you re-index through MCP.

## 1. Build and verify

```bash
npm install
npm run build
node dist/cli/index.js index /path/to/project
```

## 2. Auto-index helper

```bash
# one run, safe for session-start hooks
node scripts/codegraph-auto-index.mjs --path /path/to/project --quiet

# debounced, safe for post-edit hooks
node scripts/codegraph-auto-index.mjs --path /path/to/project --debounce-ms 1500 --quiet

# use an installed CLI or a shared database
node scripts/codegraph-auto-index.mjs --path . --cli codegraph --db ~/.codegraph/shared.sqlite
```

The helper never blocks a hook: failures exit 0 unless `--strict` is passed. It
uses a lock file in the OS temp directory so overlapping hook runs are skipped.

## 3. Claude Code

Merge `claude-code/.mcp.json` into the project `.mcp.json`, and merge
`claude-code/settings.hooks.json` into `.claude/settings.json`. The skill is
already discoverable at `.claude/skills/codegraph/SKILL.md`.

## 4. Codex

Merge `codex/config.toml` into `~/.codex/config.toml`. Codex has no generic
per-edit hook here, so use the `AGENTS.md` instruction plus the git hooks, or
run `index_repository` from MCP at the start of a task.

## 5. Copilot (VS Code)

Copy `copilot/.vscode/mcp.json` and `copilot/.vscode/tasks.json` into the
project's `.vscode/` directory, and `copilot/copilot-instructions.md` into
`.github/copilot-instructions.md`. The task runs on folder open; enable
"Allow Automatic Tasks" in the workspace.

## 6. opencode

Merge `opencode/opencode.json` into the project `opencode.json`, and copy
`opencode/.opencode/plugin/codegraph-auto-index.mjs` into `.opencode/plugin/`.
Adjust the event names if your opencode version differs.

## 7. Git hooks (universal fallback)

```bash
integrations/git-hooks/install.sh /path/to/project
```

This sets `core.hooksPath=.githooks` and indexes after commit, merge and
checkout. Undo with:

```bash
git -C /path/to/project config --unset core.hooksPath
```

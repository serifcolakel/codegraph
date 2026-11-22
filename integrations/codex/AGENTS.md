# CodeGraph for Codex

When starting work in this repository:

1. Call `index_status` first. If `freshness: stale=true`, call
   `index_repository` with the repository path (use `async=true` for big repos).
2. Prefer `search_graph`, `get_code_snippet`, `trace_path`, `analyze_graph`
   and `query_graph` over grep when an index exists.
3. Cite `file:line` from tool output and do not invent unresolved edges.
4. Before finishing, run `detect_changes` to review the blast radius.

CLI fallback:

```bash
codegraph index .
codegraph freshness <repoId>
codegraph coverage <repoId>
```

Auto-index after git operations with `integrations/git-hooks/install.sh`.

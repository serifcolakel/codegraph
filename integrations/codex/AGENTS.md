# CodeGraph for Codex

When starting work in this repository:

1. Call `index_repository` with `action=status` first. If `freshness:
   stale=true`, call it with `action=index` (use `async=true` for big repos).
2. Prefer `search_graph`, `get_code_snippet`, `trace_path`, `analyze_graph`
   and `query_graph` over grep when an index exists.
3. Cite `file:line` from tool output and do not invent unresolved edges.
4. Before finishing, run `analyze_graph` with `analysis=changes` to review the
   blast radius.

CLI fallback:

```bash
codegraph index .
codegraph freshness <repoId>
codegraph coverage <repoId>
```

Auto-index after git operations with `integrations/git-hooks/install.sh`.

# CodeGraph

This workspace has a CodeGraph MCP server. Prefer its tools over grep when an
index exists:

- `index_status` / `index_repository` to check or refresh the index.
- `search_graph`, `get_code_snippet`, `trace_path`, `find_references`.
- `analyze_graph`, `get_architecture`, `detect_changes`, `query_graph`.

Always cite `file:line`. If the index is stale, run the
`codegraph: auto-index` VS Code task or `codegraph index .`.

Install auto-indexing on git operations with
`integrations/git-hooks/install.sh`.

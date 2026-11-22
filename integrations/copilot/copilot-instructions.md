# CodeGraph

This workspace has a CodeGraph MCP server. Prefer its tools over grep when an
index exists:

- `index_repository` (`action=status|index|job|list|delete`) to manage the index.
- `search_graph`, `get_code_snippet`, `trace_path`, `search_code`.
- `analyze_graph`, `get_architecture`, `query_graph`.

Always cite `file:line`. If the index is stale, run the
`codegraph: auto-index` VS Code task or `codegraph index .`.

Install auto-indexing on git operations with
`integrations/git-hooks/install.sh`.

---
section: Security
---

- **An operator's LSP denial survives traffic to other project roots (closes #2518)** — the per-root LSP config is now a value of the session-root registry instead of a separate 32-entry cache beside a 128-entry registry, so a config can no longer be evicted while its root is still served. Analyzing 33 or more other directories in one process used to drop a live root's resolved config while the registry still reported that root ready, which silently lifted `lsp.disabledServers` for it with nothing left to re-initialize it. Both readiness memos — the MCP server's and the extension's — now ask the registry rather than only their own memo, and a root dropped at the registry's cap records one bounded `lsp-session-root-evicted` degradation.

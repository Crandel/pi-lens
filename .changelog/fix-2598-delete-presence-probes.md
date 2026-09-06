---
section: Changed
---

- **LSP**: `lsp_diagnostics`, `lsp_navigation` and the tsserver sync escape hatch no longer probe the LSP service for methods it always defines. `collectDiagnosticsForFile` and `openFileBestEffort` touched the file only `if (typeof lspService.touchFile === "function")`, and `attemptTsserverSyncDiagnostics` bailed unless `getAdvertisedCommands` was a function; the real `LSPService` defines both unconditionally, so those hedges (and the `openFile` fallbacks behind them) were reachable only from a partial test double. Production behaviour is unchanged — the touch and the advertisement read now happen on the one path a real service ever took, and the `getDiagnostics` fallback still covers a touch that resolves no clients.

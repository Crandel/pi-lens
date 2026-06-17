# LSP capability matrix — affirmative-clean-signal strategy

How pi-lens knows a just-edited file is **clean** (no diagnostics) vs the server
simply **hasn't answered yet** (cold/crashed/silent). pi-lens waits *synchronously*
for a verdict, so — unlike an editor, which renders asynchronously and never needs
to decide — it must have a positive signal. There is no signal for "silence", so we
classify each server and pick a per-server strategy. (Background: #240; mechanism
confirmed against Neovim's LSP client, which sidesteps this entirely by being async.)

Generate/refresh this matrix with `node scripts/characterize-lsp.mjs [--install]`
(mode) and `scripts/probe-clean-signal.mjs` + `PILENS_PUB_DEBUG=1` (clean-behavior).

## The three strategies

| Tier | Signal | Affirmative clean? | Example |
|---|---|---|---|
| **1 — pull** | `textDocument/diagnostic` returns an authoritative report (empty = clean) | YES, deterministic | rust-analyzer |
| **2 — push, re-publishes empty** | `publishDiagnostics([])` **with version** on every scan, incl. clean→clean | YES, via version bump | ast-grep |
| **3 — push, silent on clean** | server publishes nothing when nothing changed | **NO** — budget-wait floor (safe; a timeout is *not* a false clean) | typescript-language-server |

Detection is **cached** at `initialize` (`detectWorkspaceDiagnosticsSupport` →
`state.workspaceDiagnosticsSupport.mode`, upgraded on `client/registerCapability`),
so the tier is free at collection time — no per-edit probe.

## Matrix (measured on the dev box, 2026-06)

`mode` from cached capabilities; `clean-behavior` from the publish-trace probe
(only servers actually probed are marked — TBD otherwise).

| lang | server | mode | clean-behavior | tier |
|---|---|---|---|---|
| json | vscode-json-language-server | pull | — | 1 |
| css | vscode-css-language-server | pull | — | 1 |
| html | vscode-html-language-server | pull | — | 1 |
| rust | rust-analyzer | pull | — | 1 |
| svelte | svelte-language-server | pull | — | 1 |
| deno | deno (alt of typescript) | pull | — | 1 |
| typescript | typescript-language-server | push-only | **silent** (probed) | 3 |
| python | pyright | push-only | TBD | 3? |
| yaml | yaml-language-server | push-only | TBD | ? |
| shell | bash-language-server | push-only | TBD | ? |
| dockerfile | docker-langserver | push-only | TBD | ? |
| toml | taplo | push-only | TBD | ? |
| terraform | terraform-ls | push-only | TBD | ? |
| prisma | @prisma/language-server | push-only | TBD | ? |
| php | intelephense | push-only | TBD | ? |
| go | gopls | push-only | TBD | ? |
| zig | zls | push-only | TBD | ? |
| vue | @vue/language-server | push-only | TBD | ? |
| opengrep | opengrep (aux) | push-only | re-publishes (early-returns ~1.2s) | 2 |
| ast-grep | ast-grep (aux) | push-only | **re-publishes empty+version** (probed) | 2 |

**Pending — fixture exists, not yet characterized here** (server not installed; needs
its specific install mechanism in a provisioned env / CI — dotnet tool, JVM jar, go
install, binary download — and the toolchain on PATH). Toolchains present on the dev
box but the servers themselves aren't installed: ruby, csharp, fsharp, java, kotlin,
elixir, clojure. Genuinely absent toolchains: swift, dart, haskell, gleam, ocaml, nix.
Also `omnisharp` (alternate of csharp) and `lua`/`cpp` (standalone-binary servers, not
yet fetched).

## Key findings
- **Mode ≠ tier.** Push-only further splits into Tier 2 (re-publishes empty — ast-grep,
  opengrep) vs Tier 3 (silent — typescript). That split needs the clean→clean behavior
  probe per server; only ast-grep, opengrep, and typescript are probed so far.
- **Tier 3 is budget-bound by necessity**, not laziness: a silent server's silence is
  ambiguous (clean-unchanged vs still-analyzing), so shortening the wait or reusing
  `lastKnownDiagnostics` would risk a false clean. The wait *is* the safety mechanism.
- **ast-grep (Phase 2 / #239) is Tier 2** — it self-signals clean on every scan, so it
  is not the bottleneck. The cost on a clean with-auxiliary touch is the *silent
  primary* (typescript), a pre-existing Tier-3 cost independent of ast-grep.

## Completing the matrix
The fixtures (`tests/fixtures/tool-smoke/<lang>/`) are durable and cover every
registered server. `mode` is read from the server's advertised capabilities at
`initialize`, so it is **content-independent** — for languages that already had a
tool-layer fixture we point `characterize-lsp.mjs` at the existing (deliberately
dirty) `bad.*` source rather than a colliding clean duplicate; new languages get a
minimal clean source. Either way the mode reported is the same.

The nightly **tool-smoke** workflow now runs `characterize-lsp.mjs --install` (after
the LSP handshake layer) on `ubuntu-latest`, which provisions Java/Ruby/Dart/PHP/Zig/
Elixir/Gleam plus Go/Rust/.NET/Node/Python — so the matrix's `mode` column fills in CI
for those. Toolchains the workflow does **not** yet set up (swift, haskell, ocaml,
nix, lua, cpp, clojure-lsp) still report unavailable until those setup steps are added.

Each row needs both: (1) the cached `mode` (now produced by the nightly), and (2) the
clean→clean publish-behavior probe (`probe-clean-signal.mjs` + `PILENS_PUB_DEBUG=1`) to
assign Tier 2 vs 3 — the second cut is still per-server and manual.

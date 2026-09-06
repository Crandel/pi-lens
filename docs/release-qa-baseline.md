# Release-QA baseline matrix

The feature × modality matrix a release candidate is witnessed against before a
tag is cut. `scripts/release-qa.mjs` reads THIS FILE — the table below is the
runner's row list, not a copy of one — installs the candidate into a scratch
`HOME`, drives each row's entry point against a real `pi`, and writes
`release-qa-report.md` plus one witness file per row under
`release-qa-evidence/`.

Why it exists: #2587. The four shipped skills were suspected of never
registering for four releases because **no check ever asked a real pi what it
loaded**. The unit suite (~10.8k tests) and the nightly smokes (install, compat,
tool, lifecycle, parser) are per-seam; nothing composed them into a release
verdict with counted coverage, so a missing row read as absence rather than
arithmetic.

## Reading the table

- **row id** — the runner's key. Every id here must have a probe in
  `scripts/release-qa.mjs`, and every probe there must appear here; the tie is
  enforced by `tests/scripts/release-qa.test.ts`, so neither list can drift into
  a hand-maintained mirror of the other.
- **entry point** — the command or RPC a **user path** actually takes. Never a
  raw internal function: a row whose entry point is an internal call proves the
  function works, not the product.
- **pass criterion** — the concrete thing the witness must SHOW (a status, a
  count, a named record). "It ran without throwing" is not a criterion.
- **witness** — the artifact captured under `release-qa-evidence/`. A witness
  that merely exists is not a witness; the report quotes the line that shows the
  asserted result.
- **reuse** — the existing script that already produces this witness, or the
  smoke that would have caught this row's regression. `new` means nothing in the
  repo covers it, and the cell says so rather than leaving the gap implicit.

## Modalities

| modality | what it stands for |
| --- | --- |
| `npm-pack` | the published artifact itself — what `npm publish` uploads |
| `npm-install` | a user installing the tarball into a project's `node_modules` |
| `pi-rpc` | pi loading the installed package, driven headless via `pi --mode rpc` |
| `mcp-stdio` | an MCP client speaking JSON-RPC to `dist/mcp/server.js` |
| `git-install` | `pi install git:...` against a pushed ref |

## The matrix

| row id | feature | modality | entry point | pass criterion | witness | reuse |
| --- | --- | --- | --- | --- | --- | --- |
| pack-skills-payload | the four shipped skills and the compiled entry are IN the published artifact | npm-pack | `npm pack --json` on the release candidate | packed file list contains `dist/index.js` and at least 4 `skills/**/SKILL.md` | pack listing JSON | new — `tests/packaging.test.ts` asserts `files[]` NAMES `skills/`, never that the pack carries SKILL.md files |
| install-selftest | the runtime dependency graph and the `pi.skills` manifest resolve AS INSTALLED | npm-install | `node <installed>/scripts/install-selftest.mjs --allow-soft` | process exits 0 and no `[FAIL]` line | selftest stdout | `scripts/install-selftest.mjs` verbatim — install-smoke's `smoke` job |
| skills-registered | a real pi registers the four pi-lens skills from the installed package | pi-rpc | `pi install <installed pkg>` then `pi --mode rpc` plus `{"type":"get_commands"}` | at least 4 commands with `source` `skill`, every `sourceInfo.path` inside the installed package | get_commands response JSON | new probe on the #2589 mechanism — the recurrence is #2587 |
| commands-registered | the extension loads and registers its `lens-*` slash commands | pi-rpc | same RPC session as above | at least 1 command with `source` `extension` named `lens-*`, and zero `extension_error` events | same get_commands response plus the event stream | `scripts/rpc-load-check.mjs` assertion — install-smoke's `pi-load` job, which runs it against the PUBLISHED package only |
| mcp-tools-registered | the MCP mirror advertises the `pilens_*` tool surface | mcp-stdio | `node <installed>/dist/mcp/server.js` then `initialize` plus `tools/list` | every advertised tool name starts `pilens_`, and the set contains analyze, diagnostics, turn_end, lsp_navigation, health | tools/list response JSON | new — no smoke drives the MCP mirror from an install |
| mcp-diagnostics-full | `lens_diagnostics` full mode answers on a fixture repo | mcp-stdio | `tools/call` `pilens_diagnostics` with `mode` `full` and `refreshRunners` `cheap`, POLLED | text carries a `Summary (N files diagnosed this session)` line with N at least 1 | tool result text | new — `tests/clients` covers the handler, nothing covers it through a packaged install |
| mcp-turn-end | the turn-end pipeline runs over the turn's files and returns an advisory | mcp-stdio | `tools/call` `pilens_turn_end` with the fixture file | text carries `Turn-end over N file(s).` with N at least 1 | tool result text | new — `scripts/smoke-availability-lifecycle.mjs` covers lifecycle availability, not the packaged turn-end path |
| mcp-lsp-navigation | LSP navigation answers on a fixture | mcp-stdio | `tools/call` `pilens_lsp_navigation` with operation `documentSymbol` and the fixture path | result is not an error and names the fixture's exported `releaseQaFixtureSymbol` | tool result text | `scripts/smoke-tools.mjs --lsp` is the per-server sibling; this row is the packaged-path variant |
| config-provenance | a project config is LOADED and its provenance is reportable | mcp-stdio | `tools/call` `pilens_effective_config` with the fixture file | result names the fixture's `.pi-lens.json` as a contributing document | tool result text | new — `tests/config/pi-lens-config-schema.test.ts` covers the schema, not the packaged load |
| degradation-visible | a silently-ignored input is RECORDED as a degradation instead of vanishing | mcp-stdio | `tools/call` `pilens_health` with the fixture's project-tier `lsp.enabled` (a global-only setting) loaded | health text carries a `config-ignored` degradation line naming the fixture's `.pi-lens.json` | health tool result text | `clients/degradation-ledger.ts` is the reused machinery; no smoke asserts it end to end |
| git-install-loads | a `git:` install of a pushed ref builds and loads in a real pi | git-install | `pi install git:github.com/apmantza/pi-lens#<ref>` then `get_commands` | at least 1 `lens-*` command and at least 4 skills | get_commands response JSON | `scripts/rpc-load-check.mjs` assertion, re-run against the git layout |

## Outcomes

Every row ends in exactly one of four states, and the four partition the
discovered set — the report asserts the identity
`discovered = pass + fail + untested + skipped` and says ARITHMETIC MISMATCH if
it does not hold.

- **PASS** — the witness shows the pass criterion.
- **FAIL(cause)** — the witness shows something else. The cause is the observed
  value, not a category.
- **UNTESTED(reason)** — no witness was produced. An async row that did not
  reach a terminal state before its polling cap expires **UNTESTED, never PASS**;
  a row with no probe implementation is UNTESTED too, so an unimplemented row is
  arithmetic rather than silence.
- **SKIPPED(reason)** — the row is unreachable in this run by construction (a
  `git:` install with no ref given, for instance). Reachability is decided in
  planning, not discovered mid-run.

If pi cannot boot — `pi --version` fails, the install fails, or the RPC session
never answers — the run is **BLOCKED** and **no ship verdict is issued**. A
blocked run is not a failed run and must never be reported as one.

Ship line, from the outcomes:

| condition | verdict |
| --- | --- |
| pi could not boot | BLOCKED — no verdict |
| any FAIL | do not ship |
| any UNTESTED or SKIPPED | ship with caveats, each named |
| all PASS | ship |

## Deliberately out of scope

- **Anything needing a model turn.** Every row above is model-free by
  construction; `get_commands` and the MCP tool calls never reach a provider. A
  row that needs a real LLM turn cannot be a release gate on an unfunded key,
  and a stubbed turn would be a double that mirrors our own assumption
  (AGENTS.md, external contracts).
- **The `concurrent_session_bind` guard.** Observing it needs a second in-process
  `createAgentSession()`, which needs model config. `docs/subagent-compat.md`
  carries the same TODO; duplicating it here would add a row that can only ever
  be UNTESTED.
- **Per-language tool and LSP coverage.** `scripts/smoke-tools.mjs` sweeps the
  whole registry nightly. This matrix asserts the packaged path answers at all,
  not that every server answers well.

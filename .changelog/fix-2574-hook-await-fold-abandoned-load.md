---
section: Fixed
---

- **Deflake `hook-await-fold-bounds` by settling its abandoned bootstrap loads (closes #2574)** — the file's two `clients/bootstrap.ts` cases released their gate and returned while `buildBootstrapClients`'s seventeen-module `Promise.all` was still resolving, so the shared `afterEach`'s `vi.resetModules()` landed on a live import graph. The next case's `await import("../../clients/observed-mutation.js")` then either deadlocked to the 5s suite ceiling (8/20 runs on an idle box) or proceeded with its own `vi.doMock` never applied, which is the `armed: true, scannedCount: 0` in 70ms that CI reported as #2574 and #2596 — a lost mock registration, not a lost timer race. Both cases now await the abandoned load through `loadBootstrapClients()`, which joins the in-flight single-flight rather than starting a second one; no production code or timing changed.

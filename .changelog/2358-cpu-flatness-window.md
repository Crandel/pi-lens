---
section: Fixed
---

- **The LSP breaker's CPU-liveness verdict reads its own sample window (closes #2358)** — the notify-stall discriminator took the higher of its two process-CPU reads, but the first read is only a baseline: it reports a rate since whatever observation the last caller left behind (the heartbeat sampler reads every recorded LSP child once per tick, and pidusage keeps 60 s of per-pid history). A scanner that drained its burst and then wedged therefore looked "busy" on CPU it had already stopped burning, survived every re-arm, and died at the hard cap recorded as `cap-exceeded`. The verdict now comes from the window read alone, so such a server is torn down on its adaptive budget and recorded as `budget-exceeded-cpu-flat`; a genuinely busy scanner still defers, because its window read is what proved it busy in the first place.

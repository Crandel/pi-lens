---
section: Fixed
---

- **Deflake `hook-await-fold-bounds`'s armed-capture case (closes #2574)** — "records hook-await-exceeded naming the arm when the capture outlives its budget" raced the real `OBSERVED_CAPTURE_BUDGET_MS` (200ms) `setTimeout` inside `bounded()` against the test's never-releasing gate; under load that real race went either way, landing `armed: true` (#2574) or hanging the whole case to the suite's 5s ceiling (#2596). The case now drives `bounded()`'s deadline with `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync`, so the outcome is decided by a virtual clock the test owns instead of real scheduling.

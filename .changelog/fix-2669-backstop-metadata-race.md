---
section: Fixed
---

- **Tests**: `instance-reaper-backstop.test.ts`'s grace-retry test no longer reads its metadata off "the last log row" — the retry it arms on a real timer appends its own row asynchronously, so an assertion running late enough for that timer to fire read the retry's metadata instead of the direct sweep's, failing with `expected undefined to be 5` on loaded CI runners (#2669).

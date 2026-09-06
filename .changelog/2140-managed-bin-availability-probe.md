---
section: Fixed
---

- **The availability probe consults pi-lens's own managed bin dir, not just PATH (closes #2140)** — `createAvailabilityChecker`'s resolver now asks the installer's `findManagedToolBinary` for a release-managed binary (`~/.pi-lens/bin`, where every GitHub/Maven/archive-strategy tool is installed and which every spawn already sees on its PATH) before falling back to the bare command name. Tools pi-lens had installed itself — actionlint, shellcheck, shfmt, helm, ktlint, taplo, tflint, trivy, terragrunt, golangci-lint, hadolint, swiftlint, vale, cue, gleam, ktfmt, spotbugs — no longer latch a false `unavailable` at every session start and then get "recovered" by the install fallback several hundred milliseconds later. A managed binary that exists but cannot run still falls through to a working PATH binary, and the `availability_decision` record now says which directory answered.

---
section: Fixed
---

- **Skills**: the `resources_discover` handler now reports a bounded
  `skills-dir-missing` degradation (extension warning + `pilens_health`) when
  `<packageRoot>/skills` is absent, unreadable, or holds no `SKILL.md` — an
  installed copy missing `skills/`, or the entry file copied out of the
  package tree by a managed extension cache. Previously this registered zero
  skills with no extension error and empty stderr.

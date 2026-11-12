# Read-only framework evidence view

Classification: original local adapter. No upstream implementation is copied or
patched. Upstream path and revision: not applicable.

`scripts/goals-matrix/view.ts` reads explicit schema-2 report files and writes a
non-resumable view with separate input identities, full embedded inventories and
histories, and references for each visible observation and attempt. Selection uses
actual recorded times, never success priority. Full phase errors remain available
in both outputs, and install outcome is separate from overall status.

`archive.ts` validates recorded content against its own inventory and policy. It
reuses cell and phase evidence validation extracted from `model.ts`. Recorded
schema-2 policies may omit build overrides. They are validated as recorded without
inserting that field or changing producer output. Run, resume, and combine retain
their strict current catalog and deadline validators. Schema 1 and view documents
are not executable input.

Regressions belong to `checks/quality-goals-matrix-view.json`. Usage is documented in
[Summarize existing framework evidence](../goals-report-view.md).

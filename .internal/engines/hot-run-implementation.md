# Server hot-run implementation

Status: Approved. Implementation in progress.

Execute the reviewed design in `/work/reports/goals/engines/hot-run/PLAN.md` and its November 8 parent corrections. This branch owns server reload, loader sessions, source snapshots, diagnostics, watcher recovery and focused server regressions. The browser subscription and document update client remain separate work.

The acceptance gate is an imported file edit followed by a new HTTP response in the same process, realm and actual listener, including compile-error recovery. A passing server gate does not establish a browser DOM update.

The implementation starts from main after PR 522. It does not change Engine interfaces, shared-memory work, templates, matrix assertions or deadlines. PR 570's ordinary CommonJS changes remain separately owned.

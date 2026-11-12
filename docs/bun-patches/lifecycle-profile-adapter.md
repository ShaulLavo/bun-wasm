# Lifecycle profiler adapter

Classification: original adapter. No upstream source patch or copied engine implementation.

`scripts/performance/lifecycle-profile*.ts` adapts the local audit's browser-level CDP transport pattern and Gecko raw-table traversal. Sources are `sm-performance-audit/browser/profile-workers.ts`, `sm-performance-audit/tools/profile-boundaries.ts` and `chrome-firefox/next-tracing/{diag,profile-summary}.ts`, retained under `/work/reports/goals/`. These are local experiments, not a revisioned third-party dependency. The maintained boundary implementation comes from PR 630's `scripts/performance/profile.ts`.

The adapter adds short-worker controls and exact browser/engine/host gating before real starter captures. Chrome chunks are joined by process and profile ID because their emitting sampler thread differs from the profiled thread. Worker target markers bind retained samples to worker birth/exit records. Gecko analysis retains unknown addresses and empty stacks, aligns each process time origin, and verifies exited-worker retention at browser shutdown. Its raw mixed stack representation does not establish Chrome's structural boundary classification.

The reader retains cumulative signed Chrome sample timestamps and selects trace-clock command marker bounds before boundary analysis. Older captures without those bounds remain wider scope and cannot certify workload attribution. Worker markers join by their timestamp inside a single profile lifetime, with target lifecycle evidence, rather than by the first reused process/thread ID. Gecko rejects duplicate process-origin/pid/tid/registration identities and intersects samples with known lifetime bounds. Saved-input fixtures exercise both clocks, thread reuse, boundary samples, duplicate identities and unregistration.

Profile shares remain scoped equal-sample observations. Useful Wasm callees inside detours remain useful work, nested detours use unions, stripped symbols remain unknown, and no sample share is converted into whole-job wall time.

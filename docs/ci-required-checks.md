# Required CI checks

`Code quality` is the final aggregate check. It waits for every build and test
job, including all browser matrix legs. The early formatting, lint, type and
source-test job is named `Source quality` and remains its prerequisite.

The aggregate runs even when a dependency fails or is skipped. It requires
source quality and all unconditional jobs to succeed. Native and shared jobs
may be skipped only when source quality's classifier explicitly disabled their
family. Missing results, missing selections, failures, cancellations and
unexpected skips fail the aggregate.

Draft runs fail source quality before expensive setup. Their skipped downstream
checks cannot supply a passing final aggregate. A ready run on the same commit
must finish its real selected jobs before `Code quality` passes.

The branch-protection check names are unchanged. Individual required checks
remain required alongside the final aggregate. The automated update reporter
publishes `Code quality` from the aggregate result, rather than the early job.

When adding a CI job, add it to the aggregate's `needs` and result policy.
`checks/quality-ci-result.json` owns regression coverage that verifies the
complete dependency list, selected skips and failure propagation.

The split Browser guest matrix is selected with the Rust producer. Its aggregate
result must succeed when selected, and may skip only when that producer is
disabled. Both the final aggregate and the required Processes gates depend on
all guest batches. Each batch consumes the same once-built verified site.

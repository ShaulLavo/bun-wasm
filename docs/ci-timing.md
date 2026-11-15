# Correctness timing observations

Correctness tests assert results and use hang caps. The separate `Correctness timing report`
workflow reads observations from successful main-push CI after that workflow completes.
It runs on GitHub-hosted Ubuntu with read-only contents and Actions permissions. It
does not run tests, install project dependencies, compile guests, or join a required gate.

Two fixtures emit one JSON line each with the prefix `BUN_WASM_TIMING_V1 `:

- `diagnostic-controller-progress` measures draining three bytes after a queued controller
  turn releases backpressure. It excludes the intentional five-second stall case.
- `http-stream-cancel` measures the successful loopback HTTP stream, EOF, cancellation
  and follow-up request. It includes an intentional 250 ms stream delay and excludes
  Chromium launch and close. Failed or intentionally stalled fixtures emit no sample.

These are observations of controlled correctness fixtures, not product benchmarks.
The fake-timer test proves handle cancellation, requested delay and callback behavior;
its synthetic time is not a speed measurement.

Schema 1 records the source SHA, workload revision and scope, successful outcome,
elapsed milliseconds, OS, architecture, kernel, CPU model and count, runner environment,
image and image version, Bun runtime and browser version. The reporter accepts only
the expected metric from each of two named Web jobs. It reads at most 300 job metadata
rows and 8 MiB per selected log, retaining only bounded metric lines. A changed job
name or missing sample appears explicitly in the report.

The summary and `ci-timing-report` JSON artifact preserve current raw samples. The
reporter looks for the previous successful report among ten recent reports and reads
one compact artifact. An elapsed difference appears only when every environment field
and the workload match and all environment fields are known. Otherwise the report
labels the sample missing, first observation, or incomparable. A single shared-runner
sample does not establish a causal speed change. Artifacts expire after 30 days.

Every API or signed download gets a ten-second timeout and at most two attempts.
Signed redirects receive no API credentials. Downloads, decompression and log lines
have size bounds; raw logs, credentials and signed URLs never enter the report.
Collection failures appear in the summary. Missing current metrics fail only this
separate reporting workflow, after it writes its summary and JSON, leaving CI unchanged.

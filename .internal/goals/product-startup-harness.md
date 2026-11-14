# Product startup measurement

Status: Approved. Managing decision, November 14, 2026.

`execute` measures startup from the start of navigation to the actual playground
URL through host ready and the existing after-ready observer. The same boundary
applies to Chrome, Firefox, desktop Safari and iPhone Safari on every engine.
The actual navigation retains its existing load semantics. CacheStorage,
service-worker initialization, engine downloads and host initialization triggered
by that navigation stay inside startup. The harness does not prewarm the app.

Each new attempt records `harnessSetup` separately from `phases`. It contains
`startedAt`, `durationMs` and `status`, plus `error` on failure. Browser/driver
creation and the browser's first default-page navigation belong here. Setup has
no product phase limit. An operational 120-second watchdog bounds factory work
and preserves late transport cleanup. A setup failure reports the cell stage
`harness-setup`; it creates no product startup pass or failure. Cleanup still runs.
The campaign's native driver preparation remains outside per-cell attempts.

`startupTimeoutMs` and per-cell `startupTimeouts` are independent of shared phase,
install, build and cleanup limits. `--startup-timeout-ms` overrides only startup
and is forwarded to native controllers. This change copies existing numerical
bounds into the startup policy. These are uncalibrated product-startup defaults,
not new measurements. The parent owns five-sample normal-load calibration and
canonical publication after this change lands.

Retained attempts without `harnessSetup` keep their original startup definition,
including factory time, and their recorded limits. Validators and the read-only
view preserve those bytes. The shared-phase calibration reader excludes startup
when an attempt uses the new boundary; it does not derive startup limits.

Regression coverage lives in the startup quality manifest and existing transport,
native ownership, causal capture and browser deadline checks. No guest build or
native device run is needed for this report/executor boundary change.

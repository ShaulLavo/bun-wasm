# Scoped lifecycle profiles

The lifecycle profiler extends the saved-worker boundary reader in `scripts/performance/profile.ts`. It keeps inclusive detours, useful Wasm callees and structural boundary samples separate. Nested rows overlap; aggregate shares use sample unions.

Capture support is conditional on an executable control in the selected browser and guest engine. A child worker must start and exit inside the capture window and retain identifiable computation samples. Failure leaves attribution unavailable without invalidating baseline timings.

Profiles describe only their recorded workers, phases and sample kinds. Unknown or stripped symbols stay unknown. Shares do not decompose lifecycle wall time or establish a speedup. Firefox crossing shares require particular care because profiling can amplify crossings. Actual workload observer-on/off runs provide sensitivity evidence, with shared-host variation reported separately.

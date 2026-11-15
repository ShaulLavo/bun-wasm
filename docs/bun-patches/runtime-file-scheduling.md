# Runtime file scheduling

Classification: original adapter. There is no copied or adapted upstream implementation.

`scripts/runtime-file-checks.ts` extends the manifest runner with an explicit
two-process runtime option. It keeps unclassified files together, then dispatches
only files whose runtime manifest opts into process isolation. This permits private
native controls to overlap without sharing writable Cargo targets or engine outputs.

JSC JSON reads the launcher and guest and writes a fresh directory per invocation.
Wasm tables owns its source crate, Cargo target, WAT outputs, FIFOs and bridge process
in scratch. Module evaluation reads the ordinary SM archive and headers and builds
its standalone library and control in scratch. Their manifests opt in. Ordinary SM
adapter controls write `target/spidermonkey-controls`; loop controls reuse producer
compile commands whose possible side outputs have not been qualified here. Both
remain in the serial part of the plan.

The existing process supervisor gains `--until-exit` for commands that already own
their hang caps. Its existing descendant ownership, signal statuses and drain are
unchanged. The runtime coordinator forwards cancellation to that supervisor and
removes its temporary directory only after supervision ends. It bounds file
concurrency and Rayon threads to two without altering program profile or native
input paths. Defaults, fixture selection, assertions and exports are preserved.

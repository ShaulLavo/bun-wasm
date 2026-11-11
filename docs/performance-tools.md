# Interpreter replay tools

Unit G keeps diagnostic measurements separate from lifecycle acceptance. The
tools accept explicit artifacts and output roots. They do not build engines or
change product tiers, flags, observers, or deadlines.

Build the Linux counter without the guest toolchain dependencies:

```sh
source env.sh
rustc --edition 2024 -O crates/bunwasm-tools/src/bin/instruction-count.rs -o /work/tmp/instruction-count
/work/tmp/instruction-count /work/tmp/count.json 10 /usr/bin/true
```

The counter supervises the complete inherited process tree, including orphaned
descendants. It counts user-space machine instructions and cycles, excludes
kernel and hypervisor work, and records each PMU's enabled and running times.
Unavailable counters, zero aggregate counts, timeouts, signals, and coverage
below 99 percent fail the capture. Output paths must be new.

The replay and saved Chrome profile commands are documented here as their
implementation lands. The frozen engine fixture lives outside the release
payload. Its adapter provenance is in
[the classified record](bun-patches/performance-replay.md).

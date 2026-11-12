# Command-owned sccache lifetime

The nonfatal errors in `rust-native-failure.log` at lines 6898, 8604 and 8759,
and `shared-proof-failure.log` at lines 3534 and 5631, come from
`scripts/with-build-cache.sh` calling `sccache --stop-server` in its EXIT trap.
The builds completed before these messages. They do not show that caching was
bypassed. The supplied common-core counters include 527 hits and 3 misses;
the native counters include 319 hits and 108 misses.

Before this fix, the private server started lazily and expired after 60 idle
seconds. Long linking or optimization could outlive it and discard its in-memory
counters. Commands without compiler requests never started a server at all.

On the PC with installed sccache 0.19.0, two tiny native C compilations recorded
one miss and one hit. After 65 idle seconds the original wrapper reproduced
the exact connection-refused shutdown message, while still exiting zero.
Running the original wrapper around `true` reproduced the missing-socket error.

The wrapper now starts its private server after installing traps and allows one
hour of idle time, matching the longest CI job bound. EXIT stops it and prints its counters. The socket guard skips
shutdown after startup fails without a socket, and also handles a signal arriving
during startup without relying on a later success flag. Command status, INT/TERM
status, private sockets, shared disk cache and compiler-selection rules stay intact.

The final real-tool proof compiled twice, waited 65 seconds, then compiled again.
Shutdown retained all three requests, two hits and one miss, without stderr.
A separate invocation using the same disk cache had one hit and zero misses.
A no-compiler invocation reported zero requests and shut down cleanly.

Reproduction and small logs are in
`/work/reports/bun-wasm-ci-throughput/sccache/`. From this checkout:

```sh
source env.sh
bun /work/reports/bun-wasm-ci-throughput/sccache/proof.ts after
bun test scripts/with-build-cache.test.ts
bun test scripts/rust-native-cache.test.ts --test-name-pattern 'staticlib argument'
```

The quality-owned lifecycle fixture covers success, command failure, startup
failure, shutdown failure, disabled caching, custom launchers, INT, TERM, a
startup signal, and a process-group timeout alongside another live invocation.
It uses `tmpdir()` and owns its processes and Unix socket fixtures.
The four existing staticlib-bypass controls also pass. Script types, focused
lint, shell syntax, check discovery, portable-temp guards and diff whitespace pass.

The actual host has no remaining test-created sccache processes, sockets,
temporary caches or scratch directories. Only small evidence and the reproducer
are retained for parent review. No heavy Wasm builds ran. Real CI still needs to
confirm behavior in the long producers; this is not a whole-build speedup claim.
As with any EXIT trap, SIGKILL or host loss cannot run cleanup. The one-hour idle
backstop bounds a surviving server after an untrappable exit; normal interruption
and test teardown still stop it immediately.

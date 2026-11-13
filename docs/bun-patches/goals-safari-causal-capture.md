# Goals Safari causal capture

Class **Host feature**, **original test adapter** in
`scripts/goals-matrix/safari-causal-native.ts`, `safari-causal-capture.ts` and
`safari-protocol.ts`. No upstream source is copied.

The adapter reads three fields of macOS `rusage_info_v4` through
`proc_pid_rusage(pid, RUSAGE_INFO_V4, ...)` in `/usr/lib/libproc.dylib`: user time
(offset 16), system time (offset 24) and `ri_proc_start_abstime` (offset 80). The
layout comes from the public `<sys/resource.h>` header in the macOS SDK and the
XNU source (`bsd/sys/resource.h`, apple-oss-distributions/xnu, main as of
2026-11). CPU times are Mach ticks and are converted with `mach_timebase_info`.
The same layout was first used in a report-only preflight script
(`collector-hint-first-unit/shared-existing-preflight/scripts/macos.ts`). This
maintained version drops its footprint, resident, virtual-size and `proc_taskinfo`
reads.

The log adapter parses `/usr/bin/log show --style json` records from launchd
(PID 1). It accepts only a subject of exactly `<service> [<pid>]`, from either the
record's subsystem or a leading `[<service> [<pid>]:]` message prefix. Two
message classes are normalized: `signal service: caller = <name>[<pid>], value = 0x<n>`
and `exited due to <SIGNAL> | sent by <name>[<pid>]` (or `exited with exit code`).
Message text is never retained. The format was taken from a 2026-11-12 desktop
Safari record. Every capture qualifies it again with a task-owned launchd job.

Reasons: identify the owned page's WebContent process without process-growth
heuristics, and record the initiating native event only when a public record
names the exact target, caller and signal. Missing or redacted records leave the
cause unknown.

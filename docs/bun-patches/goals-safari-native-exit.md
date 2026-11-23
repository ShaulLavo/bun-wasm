# Goals Safari native exit observation

Class **Host feature**, **original test adapter**. The `safari-exit-*` modules in
`scripts/goals-matrix/` are original diagnostic code. No upstream implementation
is copied. They integrate the qualified report-local observer and decoder into
the existing opt-in desktop Safari causal capture.

The public ABI and constants come from Apple XNU revision
`f6217f891ac0bb64f3d375211650a4c1ff8ca1ea`:

- `bsd/sys/event.h`, `kevent64_s`, `kevent64`, `EVFILT_PROC`, `EV_RECEIPT`,
  `NOTE_EXIT`, `NOTE_EXITSTATUS`, `NOTE_EXIT_DETAIL` and the public detail bits.
- `bsd/sys/wait.h:130-159`, terminal wait-status bit extraction.
- `bsd/kern/kern_event.c:1098-1154`, attachment and permission checks;
  `1193-1288`, exit population; `1247-1249`, memory classification;
  `1308-1320`, retained process-filter events.
- `bsd/kern/kern_proc.c:4623-4636`, process knote detachment during reap.

The qualified little-endian Darwin ARM64 structure is 48 bytes. The syscall
bridge supplies all seven arguments, unsigned call flags, one output event,
call flag 1 and a zero two-word timespec for nonblocking polls. Negative syscall
returns capture errno immediately, before clocks or decoding. Raw bytes, all
fields, and observer dispatch/receipt clocks survive decoding failures. A failed
registration retains its primary receipt and any separate close error. Every
descriptor receives one close attempt, including when close fails.

The normal-exit qualification observed one owned same-user launchd nonchild
exiting 23 with three subscriptions. Combined status/detail delivered raw data
5888. The observed macOS 26.4 kernel was `xnu-12377.101.15`; the public source pin
does not establish an exact running-kernel source match. Safari registration was
qualified separately, without a delivered Safari exit. The maintained bridge
has deterministic injected coverage, with no new native delivery claim.

Reasons: retain a process-bound event after rusage disappears or the numeric PID
is reused, and retain it through transport, driver and application teardown.
Attachment requires the existing unique page association plus matching births
immediately before and after registration. The owner attaches once and never
rebinds. It does not wait for target death before cleanup, and closes after a
finite final drain. Optional capture failure cannot replace the original thrown
operation value. Cleanup failures and observer failures remain separate evidence.

Registration is not atomic with the birth checks; zombies can retain their birth,
and an exit before binding can be missed. Missing status/detail stays null.
Receipt clocks are not kernel exit timestamps. A cleanup-phase receipt does not
identify cleanup as the cause. Signal 9 names no killer. The memory bit reports
the kernel classification, not an allocation, byte owner or threshold; its absence
does not exclude WebKit policy or allocation failure. Nonchild signals, Safari
exit delivery and a native positive memory bit remain unqualified.

The optional native wrapper also registers a synchronous local snapshot reader
with the existing exit owner. `native.ts` reads the existing `native-safari.ts`
launch shape. These original host additions copy no upstream code or ABI. First-invalid,
wrapper-signal cancellation, and before/after bounded teardown settlement record
the already retained driver child PID, exit code and signal. Desktop Safari starts
through LaunchServices and has no child handle, so its entry records the launch
attribution instead: request time, then the refused or owned PID with its kernel
birth. The retained instance handle is not part of the snapshot.
Available cached driver root and application start identities are copied into
each record. The driver spawn bound is rounded to seconds; cached process start
times are distinct from the WebContent kernel birth. No process lookup, native observer, browser request or log query is
added. Record sequence and UTC/monotonic observation clocks correlate snapshots
with the existing protocol facts and birth-bound WebContent target. The capture
remains under the enclosing run's existing source provenance.

Null child exit code and signal mean no child exit was observed. They do not
prove liveness, driver endpoint health or Safari session health. Child-handle
state is distinct from the WebContent subscription. Reads are sequential, not
an atomic process snapshot or a kernel exit clock. Cancellation covers only the
native wrapper's existing signal; the reason retains its type and Error name,
without message or arbitrary payload. It identifies no external actor and
cannot exclude an interruption outside that signal. An after-teardown snapshot
marks the bounded step's settlement, including timeout or an unjoined result;
the adjacent cleanup-settled record determines whether teardown completed.
Reader failure degrades evidence without changing the operation's thrown value
or independent cleanup attempts. The listener and reader detach after wrapper
teardown. Ordinary runs without the exit owner retain their existing path.

Linux controls combine the maintained local WebDriver endpoint, real owned
children, injected subscription syscalls and the real JSONL writer. They cover
null replies, cancellation before invalidity and during teardown, an already
observed child exit, partial setup, cleanup failure and hangs, delayed or failed
writes, late observations and listener removal. They establish wrapper ordering
and retained local state, with no new Safari or Darwin delivery qualification.

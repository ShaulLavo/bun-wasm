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

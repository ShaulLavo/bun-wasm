# Native shell process identity

Class **Original adapter**. The `runtime_proc.getpid` import in
`crates/bunwasm-host/src/slots.rs` connects the native launcher to Bash 0.0.111,
pinned at `e362a4752b505606cc009be59ccfa7a90e4b8cf5`. No upstream implementation
is copied.

The import returns the calling process's existing runtime directory identity,
including root identity 0 and allocated child identities. It checks cancellation
before returning. It does not return the operating-system launcher's PID.

Bash uses this existing process import for PID expansion and self-signals.
Self INT and TERM retain signaled outcomes 2 and 15. Ordinary exits 130 and 143
remain exited outcomes. The process ABI is unchanged.

`runtime_proc_getpid_uses_the_calling_process_identity` in
`crates/bunwasm-host/src/slots/tests.rs` checks root and child identities,
repeated reads, and cancellation. The package-continuation rollback preserves
this later Bash change while removing the separate private handoff import.

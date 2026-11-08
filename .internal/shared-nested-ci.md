# Shared-group native check delivery

Status: Approved, J11 milestone 1. This gate adds no engine or browser rollout.

The existing Rust job builds the native launcher once. It publishes that executable
and its source revision as a short-lived workflow artifact. The existing shared
sysroot job consumes this launcher after the Rust job succeeds. It remains the
single producer and proof owner for the shared-pic sysroot.

That shared job builds one ordinary transpiler-enabled shared-group core and one
QuickJS shared-group side with the existing producers. Each distinct profile keeps
its own cache and output directory. It validates and composes the pair, then runs
native checks selected by feature-owned `profile: shared-group` metadata.
No workflow command names a semantic fixture directly.

Ordinary native metadata omits the profile and continues to mean split. Its
selection, fixture commands and producer stay unchanged. Closed-schema tests cover
profile selection, bad profile values and unrelated owners. A shared consumer
requires the real matching group pair and launcher. Missing files, unsupported
capability, a failed assertion or a mismatched workflow source fails the job.
Nothing turns those outcomes into a passing skip.

The producer-to-consumer chain is:

`Rust job -> native launcher artifact -> shared PIC job -> one group core/side -> shared native fixture checks`.

Existing libc proofs, Rust tests, unshared fixtures and independent source review
remain blocking. C67 measurements retain their original labels. Runtime fixes,
not report freshness, justify subsequent builds.

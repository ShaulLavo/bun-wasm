# Process no-deprecation warning suppression

Class **Original adapter correction**. `crates/bunwasm-runtime/src/js/process.ts` already exposes `process.noDeprecation`, but `emitWarning` ignored it. The factory now returns before warning listeners or stderr delivery when the selected warning name is `DeprecationWarning` and the property is true.

This is direct property semantics, not a new feature flag and not a claim about native Bun worker behavior. Native Bun 1.4.4's worker-flag divergence remains a separate upstream report. Other warning types, listener delivery, error identity, codes, stderr formatting, and re-enabling are unchanged.

`scripts/process-no-deprecation.test.ts` evaluates the real factory and compares it with the native Bun runtime: a hidden deprecation warning is suppressed, an `OtherWarning` remains, and a later deprecation warning is emitted after the property is cleared. The oracle removes its listener and restores the original property, including deleting it when originally absent. Separately recorded Node 26.12.1 command evidence in `native-node-corrected.log` confirms the same contract; that Node command is not part of the Bun test's execution. `checks/runtime-process-no-deprecation.json` selects the regression under the runtime owner.

The process AST receipt in `scripts/runtime-process.test.ts` admits only this guard line while preserving the original hash and all executable token-position checks. No worker parser, bootstrap, engine, mailbox, provider, build, or workflow change is included.

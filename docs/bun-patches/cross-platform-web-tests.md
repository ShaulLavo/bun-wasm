### Cross-platform web tests

Class **Host feature**, **original adapters**; no upstream implementation is copied
or adapted. `web/tests/{subprocess,playground,browser-net}.mjs` and
`tests/install/run.mjs` use the host temporary directory or `BUN_WASM_TEST_TMP`.
`scripts/test-web.sh` honors that override or `TMPDIR`, installs scratch teardown
before allocation, and waits for its fixture server to exit. Its original
`scripts/run-with-timeout.mts` adapter records process identities and kills only
owned descendants on normal exit, deadline and interruption rather than requiring
GNU timeout on macOS. The original `scripts/linux-subreaper.mts` adapter calls
Linux `prctl` through Bun FFI so orphaned descendants retain kernel-enforced
ownership even when polling and environment markers miss their launcher. Node
entry execs through Bun and back to Node at the same PID. No upstream source is
copied. The [deadline contract](../browser-deadlines.md) describes the controls.
Browser network teardown uses owned ChildProcess handles, not Linux-only `/proc`
paths. Test assertions are unchanged.
The original `env.sh` host-cache adapter exports `PLAYWRIGHT_BROWSERS_PATH` only
when it is unset and the cache directory named in `env.sh` exists. It never downloads
browsers; hosts without that directory retain Playwright's native cache lookup,
and explicit overrides (including `0` and empty) are preserved. The isolated
`web/tests/toolchain-env.test.ts` probes cover the default and those overrides.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Deadline descendant ownership](#cross-platform-web-tests) | Host feature | Original PID/birth deadline supervision and Linux child-subreaper adapter preserve detached descendants across launcher death. |
| [Cross-platform web test adapters](#cross-platform-web-tests) | Host feature | Original scratch, child-process cleanup, command-deadline and existing-browser-cache adapters run the same assertions on Linux and macOS. |

[Parent context](http-framing.md).

[Ledger scope and pinned revisions](scope.md).

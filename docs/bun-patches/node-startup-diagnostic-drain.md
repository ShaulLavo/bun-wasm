## Node startup diagnostic drain

Class **Host feature**. `web/scripts/node-spawn.ts` is an original Node broker
adapter consuming Waffle's public `waffle/browser/diagnostic` export at
`0a9fe12bf73cce81047999d0499543dfe0d9e513` (0.0.46, MIT), implemented upstream in
`browser/diagnostic.ts`. The former local adaptation of that file from
`a0a0f8794cde02410a11be38771b31cdbd3af89a` is deleted; no diagnostic implementation
is copied or adapted locally. Positive writes reset the five-second no-progress
bound, EAGAIN yields instead of blocking, and errors identify the unwritten span.
Thrown writer exceptions normalize to WASI EIO; negative write results retain
their errno. The Node broker returns the shared drain to the supervisor's
exactly-once startup sink and honors its active predicate, so disposal cancels
delivery before descriptor release. Native stdio `tryWrite` performs one
immediate write rather than calling the blocking preview1 helper. Tests cover
partial writes, delayed progress, competing error/exit notices, disposal during a
blocked diagnostic, writer exceptions and the exported stall deadline. Waffle's
post-entry browser diagnostic delivery is included in this pin.

This pin includes Waffle's transactional inherited-binding rollback, which is
now enabled in the shared unit/browser control, and its exactly-once startup
sink ownership and cancellation. The core allowance changed from 7,168 to
7,680 B gzip without removing code. The cbb138b5 core measured 7,454 B; a0a0f87
measures 7,516 B (23,106 B minified). The deliberate upstream additions are
inherited fd3 support, startup observation and transactional
rollback; these primitives remain measured. The diagnostic service remains
lazy. The 0.0.44 follow-up consumes the shared public drain and removes the Node
adaptation; historical measurements above identify their original pins.

At `b7dded1e` the core remains 23,106 B minified / 7,516 B gzip, below the
unchanged 7,680 B gate. The web split graph is 1,146,609 B minified / 353,616 B
gzip; its light initial graph is 1,272,421 B / 390,095 B. Sandbox totals are
1,198,366 B / 374,690 B, with initial graph 1,324,156 B / 411,160 B. These
same-source gzip-level-9 measurements include all tagged process/startup
primitives and the upstream post-entry diagnostic additions; no budget was
raised and the process supervisor remains lazy.

The 0.0.46 consumer follow-up pins every Waffle dependency and lockfile to
Waffle commit `0a9fe12bf73cce81047999d0499543dfe0d9e513`. That upstream change fixes
job-completion collection racing with tagged-cell retirement, including the
sealed-but-not-retired losing-waiter interval. Tagged retired capabilities still
report ESRCH; an already collected wait reports ECHILD. Bun's failure-only Wasm
fixture keeps recording the exact wait return and untouched result bytes, but
the temporary Firefox nested-child exception is removed: this failure is fatal
in every browser, with no retry. The real inherited-fd libc controls remain
explicit expected failures until the separate patched-sysroot follow-up. Waffle's
intrinsic and source-quality changes from the preceding release are also included; no upstream source
is copied into this consumer.



## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Node startup diagnostic drain](#node-startup-diagnostic-drain) | Host feature | Use Waffle's public cancellable, bounded asynchronous diagnostic drain for the Node process host's immediate stderr writes. |

[Ledger scope and pinned revisions](scope.md).

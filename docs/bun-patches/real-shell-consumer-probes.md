## Real shell consumer probes

`tests/shell-consumer/` is an original consumer of the public Bun, bash-web and Waffle packages.
The lookup, files/cwd/env, EPIPE, inherited-stdin and Ctrl+C probe commands follow
`bash-web/tests/external-commands.spec.ts`, `tests/pipelines.acceptance.spec.ts` and
`tests/runtime-shell.spec.ts` at `c92bd41da9ccc3fdc48b4d11a20288ce9969e2d5`.
The filesystem probe retains the Bun-created copy, nested `nested/new` write/read, exit 9,
deletion check and Bun-write/shell-append/Bun-read round trip with `sourceappended` bytes.
The small guest snippets and expected markers retain those contracts. The additional ticker,
binary byte checker, network preview and borrowed-consumer lifetime probes are original.
No shell interpreter, process manager or Waffle implementation is copied or patched.
`web/tests/browser-shell-consumer.ts` and `shell-consumer-install.ts` are original build,
receipt, execution and teardown tooling. The installed package builds its own shell assets.
`message-listener-probe.ts` is an original dispatch-based observer of the preview handler.
Its negative control removes the wrong callback and requires teardown to reject the still-live handler.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Real shell consumer probes](#real-shell-consumer-probes) | Host feature | Original installed-package composition and contract probes adapted from bash-web acceptance commands, without copying a shell implementation. |

[Ledger scope and pinned revisions](scope.md).

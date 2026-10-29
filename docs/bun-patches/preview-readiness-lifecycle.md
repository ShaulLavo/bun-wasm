## Preview readiness navigation lifetime

`scripts/app-matrix/product-browser.ts` is original bun-wasm harness code over
Playwright 1.64.1 and Chromium's public DevTools protocol. No upstream
implementation is copied or patched.

A Playwright navigation deadline does not cancel its Chromium navigation. A late
commit can follow a successful `Target.closeTarget` response without either page
session detaching. Before returning a probe, cancel its load with
`Page.stopLoading`, then await the renderer command `Runtime.getIsolateId`.
Chromium queues renderer commands until pending navigation finishes. This does
not execute page scripts or re-enable them.

During a frame commit, `Page.stopLoading` can reject with `Not attached to an
active page`. Only that exact protocol state proceeds to the renderer barrier.
Other cancellation errors remain failures. A stop command alone and an
about:blank navigation both failed real-browser controls.

The caller passes its existing cleanup budget explicitly. One bounded operation
covers cancellation and renderer completion. A settlement rejection or expiry
throws `HarnessCleanupError`, retaining the polling rejection as its cause and
the settlement error in its failure list. An omitted cause differs from a thrown
`undefined`; falsy polling rejections retain their original value. The matrix
records settlement failures as cleanup failures and reaches owned teardown
without navigating the application. On expiry an abort signal also prevents a
late cancellation reply from starting a renderer command. Already pending CDP
work ends when owned teardown closes its target.

The source paths inspected at Chromium `156.0.8078.4` are
`content/browser/devtools/protocol/{target,page}_handler.cc`,
`content/browser/devtools/{render_frame_devtools_agent_host,devtools_session}.cc`,
`content/browser/web_contents/web_contents_impl.cc`, and
`content/browser/renderer_host/render_frame_host_impl.cc`. These are evidence for
the adapter's lifecycle contract, not adapted implementations.

The real Chromium regressions require stalled-header cancellation before helper
return, exercise deadline/commit collisions with two other pages open, and retain
the existing 2,000 ms probe-close budget. Elapsed readiness assertions start after
page creation, at the same point as their shared deadline.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Preview readiness navigation lifetime](#preview-readiness-navigation-lifetime) | Host feature | Original harness adapter settles probe navigation before target close. |

[Ledger scope and pinned revisions](scope.md).

The error regressions await the operation before asserting the captured Error.
Bun 1.4.4's rejection matcher delays real CDP continuations: three renderer
commands take 2,731 ms inside `.rejects.toThrow` and 1.09 ms with ordinary await in
the paired control. The existing upstream report 31 records the same matcher
problem with MessageChannel. Deadline timing starts after target creation; the
same elapsed limits and all 32 collision cases remain enforced.

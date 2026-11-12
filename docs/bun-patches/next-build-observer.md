# Next build observer

Classification: original adapter. No upstream implementation is copied or patched.

This opt-in goals-matrix tool observes the stock Next build through the maintained foreground driver. It reads only supported memory/process metadata and a fixed set of public build files through a forked Waffle filesystem client. The build command, template, engine policies and whole-phase deadline remain unchanged.

Next 15.5.6 owns the diagnostic and trace formats (`dist/build/index.js`, `dist/build/collect-build-traces.js`, `dist/trace/report/to-json.js`). Completed trace batches and complete server manifests are evidence of progress; absent events, partial files and stale dev artifacts are not evidence of a stall. One observation cannot separate CPU work from filesystem waits.

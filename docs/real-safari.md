# Real Safari browser gates

Playwright WebKit is not the real-Safari milestone gate. Reserve the owner's Mac
through the machine-fleet workflow before starting `/usr/bin/safaridriver`.
Do not change the owner's Safari automation preferences or use their browser profile.

Build the fixtures on Linux from the checkout under test:

```sh
source env.sh
bun web/tests/browser-safari.ts --build /work/tmp/bun-wasm-safari-<run>
```

Copy that directory to a unique `~/tmp/` directory on the reserved Mac. Run its
standalone runner with the Mac's Bun installation:

```sh
BUN_WASM_RUNTIME_PROC_PUBLISHED_DEFAULT=1 SAFARI_OUTPUT="$PWD/results.json" \
  ~/.bun/bin/bun runner.mjs --run "$PWD"
```

This runs the artifact-free process and runtime_proc fixtures, actual Bun's
published immutable guest, and IndexedDB/OPFS reload tests. The storage test holds
a file open in another worker while unlinking and committing it, then reads the
old bytes through that handle. Reload checks bytes, inode, mtime and path changes.
The runner isolates each case's storage with a separate loopback origin and removes
that origin's databases and OPFS files before closing the session and listeners.

For a freshly built browser guest, omit the published-default opt-in and set
`BUN_WASM_RUNTIME_PROC_ARTIFACT` to its absolute path. `SAFARI_CASE` selects a case
prefix, such as `artifact-free-process`, `runtime-proc/`, `current-bun/` or
`persistence/`. Unknown or empty selections fail before Safari starts; selecting
`engine-interruption` requires `SAFARI_GUEST_DIR`. The final report also rejects
missing selected rows. A failing row makes the runner exit nonzero.

The existing `browser-engine-interruption.ts safari` gate covers CPU-bound WASM,
QuickJS, JSC and browser JS with real workers. Supply current-main guests through
`BUN_WASM_INTERRUPTION_DIST`; `ENGINE_INTERRUPTION_BROWSER_BUNDLE` can select its
prebuilt browser fixture directory. See that runner for the entrypoints to bundle.

Set `SAFARI_GUEST_DIR` to a directory containing those three guest filenames to
include that same engine fixture in `runner.mjs`. Select only that gate with
`SAFARI_CASE=engine-interruption`. Its report keeps completed cases and the
currently running case if a timeout prevents completion.

For the actual playground's terminal, build `web/` with those same guests and run
the generated `shell-runner.mjs` with the built playground directory as its argument. It sends one WebDriver Control+C key
chord per engine, requires status 130 and the prompt, then runs another command.
`SAFARI_OUTPUT` records its results too.

Retrieve reports before removing every copied directory and guest from the Mac.
Verify the task's safaridriver and loopback listeners are gone, then release the
reservation. Keep reusable Linux guests only at the coordinator's requested path.

For the installed real bash-web consumer, build its existing fixture with
`bundleConsumer` from `web/tests/shell-consumer-install.ts`. Copy
`safari-observers.js` from the Safari fixture build into that output and load it
before `main.js`. Serve the selected receipt-verified guest as `bun-guest.wasm`.
Run `SAFARI_SHELL_CONSUMER=1 SAFARI_OUTPUT=consumer.json ~/.bun/bin/bun shell-runner.mjs <consumer-output>`.
This preserves all eight original consumer cases and adds real-Safari admission,
shared-preview delivery, and physical worker/listener cleanup assertions. The
consumer interrupt case calls the terminal bridge. Run the playground mode
separately for the trusted WebDriver keyboard chord.

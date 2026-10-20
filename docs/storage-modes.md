# Browser storage modes

The playground and sandbox accept `?mode=fast`, `?mode=safe` or `?mode=memory`.
Omitting the parameter selects `fast`. In the sandbox, combine it with the existing
`template` parameter, for example `?template=vanilla&mode=memory`.

- `fast` preserves the current IndexedDB workspace. A completed `flush()` checkpoints
  data and metadata; changes after the last completed checkpoint can be lost.
- `memory` keeps an isolated, nonpersistent workspace. Reloading discards its contents.
- `safe` is a named Waffle mode that is not implemented at the pinned revision. Startup
  fails with `UNSUPPORTED_VFS`. Invalid mode names fail the same way.

Neither page falls back to another mode or store. Missing storage capabilities also fail
with a visible typed error, including before filesystem construction finishes. The page
shows a Reload action rather than silently starting an empty workspace.

Existing names stay unchanged: `bun-wasm-workspace` for the playground and
`bun-wasm-sandbox-${template}` for the sandbox. The old `storage=opfs` selector is no
longer a product setting. Physical backend overrides exist only in conformance fixtures.

## Focused verification

After installing the pinned dependencies and building both pages:

```sh
source env.sh
(cd web && bun build.ts)
(cd sandbox && bun build.ts)
bun web/tests/browser-startup-mode.ts chromium webkit
```

The browser check uses the actual pages and filesystem workers. It verifies visible typed
errors, unsupported worker capabilities, unchanged workspace names, checkpoint persistence
and memory loss on reload. It creates no deployment and closes its browsers and listener.

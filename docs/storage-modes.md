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
with a visible typed error, including before filesystem construction finishes.
Unsupported startup modes offer Reload. Storage failures keep pending editor text
in the page and offer Retry. A terminal filesystem startup failure can reload only
before an editor document, text or pending save exists.

Existing names stay unchanged: `bun-wasm-workspace` for the playground and
`bun-wasm-sandbox-${template}` for the sandbox. The old `storage=opfs` selector is no
longer a product setting. Physical backend overrides exist only in conformance fixtures.

## Sandbox install retention

In `fast` mode, the sandbox keeps active workspaces and one eligible idle install.
It preserves an older idle project's user tree before removing its installed
packages. Opening that template again restores the tree and reinstalls packages.
Hidden or frozen tabs still count as active owners.

Preservation keeps dotfiles, unknown build and dist paths, binary bytes, empty
directories, files outside the app directory, and intentional template-file
deletions. It excludes only exact regenerable roots, including the app's
`node_modules`, its Bun install cache, initialization markers, and catalog-owned
framework outputs. An edited package manifest cannot add exclusions.

The limits are 8 MiB of retained file payload, 10,000 retained entries and five
seconds for source copying. Paths and metadata need additional storage. Restored
files use mode 0600, directories use 0700, and modification times are fresh.
Links, sockets, hardlinks, nondefault modes, incomplete seeds and failed or
over-budget reads refuse eviction and keep the original install. Busy or
unpreservable workspaces can exceed the one-idle target.

When a write runs out of space, the sandbox reclaims other eligible idle installs
and retries the failed install or checkpoint once. It waits for the post-install
checkpoint before starting the dev server. If saving still fails, keep the page
open and copy unsaved text. Browser quota estimates do not guarantee that a
project fits, especially in private windows.

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

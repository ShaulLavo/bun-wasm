# Troubleshooting

Each entry gives the symptom, the cause, and the fix. Limits that no fix removes are in [Limits](limits.md).

## Network APIs say "not supported", or `Bun.serve` prints no preview link

The page is not cross-origin isolated. Without it the wasm engines have no shared memory for the network bridge, and the `browser` engine falls back to the worker's own `fetch` with no servers.

Serve the page with both headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`bun run preview` in `web/` and `sandbox/` sends them already. `ISOLATE=0 bun run preview` in `web/` turns them off. In the browser console, `crossOriginIsolated` must be `true`.

## `fetch` fails with "Failed to fetch" or "Load failed"

`fetch` runs as the page's own `fetch`, so the browser applies CORS. The target server must send `Access-Control-Allow-Origin`. To read custom response headers it must also send `Access-Control-Expose-Headers`. Chromium reports "Failed to fetch". Safari reports "Load failed".

## `ERR_CIRCULAR_IMPORT`

The `browser` engine links modules through a module store. A service worker is that store in the browser. Without one, an import cycle has no URL to link against and throws. Load the page over HTTPS or from `localhost`, where a service worker can register and take control, then reload.

## The browser blocks module loading

The `browser` engine creates a `blob:` URL for each acyclic module. If the page sets a Content-Security-Policy, its `script-src` must allow `blob:`, next to the Wasm and eval permissions the policy already grants.

## `wasmtime run dist/bun.wasm` fails to instantiate

`bun.wasm` imports the `runtime_proc` process functions, which plain Wasmtime does not provide. Run it through the launcher, which does:

```sh
"$CARGO_TARGET_DIR/release/bun-wasm" --wasm "$PWD/dist/bun.wasm" --dir "$PWD::/" --env PWD=/ -- run /index.ts
```

## Startup fails with `UNSUPPORTED_VFS`

The URL has `?mode=safe`, or a mode name that does not exist. Use `?mode=fast` or `?mode=memory`. `safe` is not implemented and the pages never fall back to another mode. See [Browser storage modes](storage-modes.md).

## "This workspace was opened in another tab" or "Waiting for this workspace to close in another tab"

A workspace has one owner tab. In the default `fast` mode the newest tab takes the workspace, and the older tab stops with a Reload button, and its unsaved changes are not kept. The page shows "Waiting for this workspace to close in another tab" instead when a storage backend refuses to take ownership. It then opens the workspace on its own when the other tab closes.

## `error: bun upgrade is not supported in bun-wasm`

The command exists in native Bun and not here. [Compatibility](compatibility.md#bun-commands) lists every unsupported command.

## `2>&1`, `|` or `head` reach the program as arguments

The playground terminal runs a small shell, not bash. It supports `;`, `&&`, `>` and `>>` and the builtins `ls cat echo cd pwd mkdir rm mv touch edit clear history help`. It has no pipes and no `2>&1` ([Playground](playground.md#how-it-works)).

## The engine picker says QuickJS or JSC is missing

The playground build gzips each wasm it finds in `dist/` and succeeds without the others. That engine then reports its guest as missing. Build it with the script in the [engine table](playground.md#engines), or set its override variable (`BUN_WASM`, `JSC_WASM`, `BUN_BROWSER_WASM`) when you run `bun run build` in `web/`.

## `installBunAdapters` rejects

| Error | Cause | Fix |
| --- | --- | --- |
| `BunWasmExecutableConflictError`, code `BUN_WASM_EXECUTABLE_CONFLICT` | A different file or directory already exists at `/bin/bun` or `/bin/node`. The installer never overwrites it. | Remove the file, or pass `executables` with other absolute paths. |
| `bun-wasm adapters are already installed on this Runtime` | A second install on the same `Runtime`. | Call `dispose()` on the first installation. |
| `workerUrl is required` | The option is missing. | Pass the URL a bundler emitted for `bun-wasm/worker`. |
| `<engine> requires its matching guest module or asset descriptor` | `engine` is `quickjs` or `jsc` without a `module` or `asset`. | Supply the matching guest. The default browser descriptor does not fit them. |

## The page requests a path named `bun-wasm/worker`

`new Worker(new URL("bun-wasm/worker", import.meta.url))` is bundler input, not a browser URL. If the bundler does not transform it, the browser requests that literal path. With Vite, import `bun-wasm/worker?worker&url` and pass the result as `workerUrl`. See [Embed bun-wasm in a page](guides/embed-in-a-page.md).

## A deep recursion ends the program with a wasm trap

A host stack overflow traps, and no `catch` runs. Safari gives workers a 512 KiB stack, so it hits this first. [Stack overflow in wasm](stack-limits.md) has the guarded and unguarded paths per engine.

## `bun install` fails with `memory allocation of N bytes failed`

The guest is capped at 512 MiB. Some packages need more during install, for example Prisma 6.17.1. No flag raises the cap ([Limits](limits.md#memory)).

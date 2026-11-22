# Process credentials and argument checks

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/process_args.ts`, `umask` and `cpuUsage` | Adapted upstream implementation | Bun `src/jsc/bindings/BunProcess.cpp` (`Process_functionUmask`, `Process_functionCpuUsage`) at `9510e74152073d850a18758ca41114d8f214ffa6`, SHA-256 `5a18bfbddeb9b6ff38b83fc55b0857acd963c953432b38649860775ef80205f0` |
| `process_ids.ts` | Adapted upstream implementation | The same file: `maybe_uid_by_name`, `maybe_gid_by_name`, `Process_functionsetuid`, `seteuid`, `setgid`, `setegid`, `setgroups` and `Process_functioninitgroups` |
| `process.ts`, the `binding` and `uv_errors.ts` `errname` latches | Adapted upstream implementation | `Process_functionBinding` (DEP0111) in the same file, and `src/jsc/bindings/ProcessBindingUV.cpp` `jsErrname` (DEP0119), SHA-256 `5b50687fd2298fe715fe6b384818a27dce1729f9e032ec7c8c98e42d9145c454` |
| `process.ts` `_rawDebug` | Adapted upstream implementation | Bun `src/js/builtins/ProcessObjectInternals.ts` `rawDebug`, SHA-256 `1c3ac5faffcd22b82185a237105f75c70f781635123dd4455b92ae944b1c7115` |
| `process.ts` loading `process_args` and `process_ids` on first use, the writable `mainModule`, the stdio accessor guard, `crates/bunwasm-cli` keeping `--bun` and run-mode `-e` or `-p` in `execArgv` | Original adapter | None |

`process.umask` remembers its mask in the guest, because the guest has no host umask to change; Bun's validation applies: a string is an octal string, anything else must be a uint32, and the previous mask is returned. `process.cpuUsage(previous)` follows Bun: `previous` must be an object, its `user` and `system` must be numbers from 0 to 2^53 - 1, and the result is the difference.

The guest keeps `uid`, `euid`, `gid`, `egid` and the group list itself and runs as root, so every setter succeeds. A name resolves through the guest's `/etc/passwd` and `/etc/group` (root only when the files cannot be read), and an unknown one throws `ERR_UNKNOWN_CREDENTIAL` as Bun does. `initgroups` resolves the group first, passes a string user through, and resolves a numeric user through passwd.

DEP0111 (`process.binding`) and DEP0119 (`process.binding('uv').errname`) warn once per thread under `--pending-deprecation`; each worker guest has its own module state, which is the per-thread latch. `process.mainModule` is an accessor whose setter leaves an ordinary writable property, which matches Bun's data property. The stdio accessors throw a `TypeError` once the global `process` is not an object, instead of returning a stream built on it.

`tests/fixtures/process-credentials-arguments` and `tests/fixtures/process-exec-argv-flags` pin these on QuickJS, JavaScriptCore and the browser engine.

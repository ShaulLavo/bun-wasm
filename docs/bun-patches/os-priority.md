# os.getPriority and os.setPriority

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/os_priority.ts` | Adapted upstream implementation | Bun `src/runtime/node/node_os.rs` (`get_priority`, `set_priority1`, `set_priority2`) at `9510e74152073d850a18758ca41114d8f214ffa6`, SHA-256 `90dd19b9f74551f53ffa0484193da1d1fe514e0f92a91166dda5a2085f9fcbde`, and `src/runtime/node/node_os.bind.ts` (the `setPriority` argument variants and the -20 to 19 range), SHA-256 `70fa82fef11a7d207d2285573338e24b850e0cd6a28287c12e576aca8539adb6` |
| `builtins.js`, the `osModule` wiring, `userInfo()` reading its ids from the guest's credentials and `shell` falling back to `"unknown"` | Original adapter | None |

The guest has one process and no scheduler. It keeps its own nice value, which pid `0` and its own pid read and write, and reports `ESRCH` for every other pid as a pid that does not exist would. The error has Bun's shape: name `SystemError`, code `ERR_SYSTEM_ERROR`, the message `A system error occurred: uv_os_getpriority returned ESRCH (no such process)`, `errno` -3, `syscall`, and an `info` object. `setPriority(priority)` is the one-argument form for pid `0`.

`tests/fixtures/process-credentials-arguments` covers the errors and the read-back.

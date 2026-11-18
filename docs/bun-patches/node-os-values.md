# node:os value functions

Class: Adapted implementation.

`crates/bunwasm-runtime/src/js/node_os_values.ts` gives the `node:os` functions that
return a single value (`arch`, `availableParallelism`, `endianness`, `freemem`,
`homedir`, `hostname`, `machine`, `platform`, `release`, `tmpdir`, `totalmem`,
`type`, `uptime`, `version`) the shape Node's `lib/os.js` defines and native Bun
1.4.4 shows: each is an ordinary named function, so `os.arch.toString()` prints
`function ...`, and each has a `Symbol.toPrimitive` that returns its current value,
so `` `${os.arch}` `` and `os.arch + ""` give the architecture. `osModule` in
`builtins.js` passes its export object through it. The functions' values are
unchanged; only how they print and convert changes. The `node-os-to-primitive`
fixture compares the shape and conversions with native Bun.

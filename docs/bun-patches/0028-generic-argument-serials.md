## 0028 generic argument serials on 32-bit targets

File `0028-sema-keep-generic-argument-serials-64-bit-on-32-bit-.patch`. Class
**Upstream bug**. Upstream `src/sema/check/expr.rs` and `src/sema/check/call.rs`
at Bun revision `a7733435cf40429e3b35c36072769df2052b80f1`.

When the type checker instantiates a generic function passed as an argument, it
gives the renamed type parameters a serial that identifies the argument:
`((file.0 as usize) << 32) | e.0 as usize`. `unique_type_params` stores that
number in the clones' mapper, so two arguments never share clones.

On a 32-bit target `usize` has 32 bits. The shift by 32 overflows: rustc warns
(`arithmetic_overflow`), a debug build panics, and a release build shifts by
zero, so the serial becomes `file | expression`. Two different arguments can
then get the same serial and share type parameters whose constraints belong to
only one of them. Native Bun ships no 32-bit build, so it cannot reach this.

The patch builds the serial as `u64` (`u64::from(file.0) << 32 | u64::from(e.0)`)
and widens the `serial` parameter of `unique_type_params` to `u64`. The value
is identical on 64-bit targets. `renamed_type_param`, whose other caller passes a
small count, keeps its `usize` parameter. The serial is only ever turned into a
number literal (`serial as f64`), which is exact for these values on both widths.

`dist/bun-tools.wasm` (`bun lint`, `bun fmt`) is the only guest that links
`bun_sema`.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0028](#0028-generic-argument-serials-on-32-bit-targets) | Upstream bug | Keep the per-argument serial of renamed type parameters 64-bit on 32-bit targets. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).

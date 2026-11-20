# `process.env` setter, `loadEnvFile` and `TZ`

Class **Port**. No Bun source is copied. `process.env` follows Node's `EnvSetter`, `EnvDefiner`
and `RealEnvStore` as Bun implements them at revision
`9510e74152073d850a18758ca41114d8f214ffa6`:

| Upstream | Behaviour reproduced | Where |
| --- | --- | --- |
| `src/jsc/bindings/JSEnvironmentVariableMap.cpp` `JSEnvironmentVariableMap::put` | An assignment with a symbol name throws a `TypeError`, an empty name is ignored (nodejs/node#32920), and the value becomes a string. A write to an object that only inherits from `process.env` is that object's own data property, with the value as given, and changes nothing about the process | `crates/bunwasm-runtime/src/js/process.ts` `setEnv` and the proxy's `set` trap |
| `JSEnvironmentVariableMap::defineOwnProperty` | An accessor descriptor, or a data descriptor that lacks a value or is not configurable, writable and enumerable, throws `ERR_INVALID_OBJECT_DEFINE_PROPERTY`; a complete one goes through the setter like an assignment | `process.ts` proxy `defineProperty` trap |
| `src/js/builtins/ProcessObjectInternals.ts` `loadEnvFile` | `process.loadEnvFile(path = ".env")` reads the file, parses it with `util.parseEnv`'s parser, and sets only the variables that read `undefined`, so an existing empty value wins | `process.ts` `loadEnvFile` |
| `JSEnvironmentVariableMap.cpp` `applyTZFromString`, `shouldApplyTZSideEffect`, `resetDateCachesAfterTimeZoneChange`, the TZ branch of `deleteProperty` | Every `TZ` write on the main thread makes the zone WTF's time zone override (names of 32 characters or more, and invalid zones, are ignored), and a delete clears the override; the VM's date cache and every live `Date`'s cached local time start over. Writes in a worker, and another thread's updates to a shared environment, change no zone | `crates/bunwasm-jsc/cpp/helpers.cpp` `bunjsc_set_time_zone`; `crates/bunwasm-engine-jsc/src/vm.rs` `set_time_zone`; the `setTimeZone` native in `crates/bunwasm-engine-quickjs/src/value_natives.rs`; `process.ts` `timeZoneChanged`; `worker_threads.ts` marks updates from peers |

## Engines

`TZ` takes effect only on JSC, whose `Date` and `Intl` use ICU and WTF's override exactly as in
Bun. QuickJS computes local time with wasi-libc's `localtime_r`, which knows only UTC, and its
`Intl` is the FormatJS polyfill: `Date` stays in UTC whatever `TZ` says. The Browser engine runs
on its host's `Date`, whose zone a page cannot change. Both engines report no settable zone
(`Engine::set_time_zone` returns `None`), so `TZ` writes only change the variable there.

## Differences from native Bun 1.4.4

- Bun emits DEP0104 for non-string values under `--pending-deprecation`; bun-wasm has no such
  option.
- Bun writes the proxy variables (`HTTP_PROXY` and the like) back to its native environment for
  `fetch()`'s proxy resolution; bun-wasm's `fetch` does not resolve proxies from the environment.

## Tests

The native fixtures `process-env-setter` (all three engines) and `process-env-tz` (JSC) hold
native Bun's output. `scripts/fixtures/process-controls.ts` checks the setter rules against the
runtime source.

[Ledger scope and pinned revisions](scope.md).

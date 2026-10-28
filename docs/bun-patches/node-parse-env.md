# Node dotenv parser adapter

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/parse_env.rs` | Port | Adapt Bun's native `parse_env` binding to engine-independent plain values. |
| `src/js/util.ts`, `src/js/assert_util_types.d.ts`, native registration and module/dependency declarations | Host feature | Original string validation, public export, typed boundary and registration. |
| `scripts/runtime-parse-env.test.ts`, `tests/fixtures/util-parse-env/`, check registrations | Host feature | Original source controls and published-import regression fixture. |
| `scripts/runtime-util-equivalence.ts` | Host feature | Original AST gate also restores the separately tested parser addition before checking the historical hash. |

## Upstream and local changes

Bun revision `9510e74152073d850a18758ca41114d8f214ffa6`,
`src/runtime/node/node_util_binding.rs::parse_env`, calls
`src/dotenv/env_loader.rs::Loader::load_from_string::<true, false>`.
`src/js/node/util.ts` exposes that binding as `parseEnv`.

The Rust adapter retains that parser call and map-to-object conversion. It replaces
JSC arguments and values with `Args`, `NativeError` and `Val`, and converts the
owned UTF-8 keys and values into engine-neutral strings. The existing pinned
parser is reused unchanged, with later definitions overwriting earlier ones and
variable expansion disabled. It reads no files and does not modify process.env.
No package-specific code, fallback parser, engine branch or new host ABI is added.

The public TypeScript adapter rejects nonstrings with `ERR_INVALID_ARG_TYPE`.
Browser ESM wrappers already enumerate the generic builtin's own exports, so the
normal `node:util` export fixes named imports for every engine.

## Controls and oracle limits

The fixture uses Vite 8.3.5's exact published utility import. The corpus covers
comments, exports, duplicate keys, empty values, quotes, multiline values,
Unicode, literal variable references and prototype-like keys. Source tests check
validation before delegation; Rust tests execute the real parser and registration.

Node v26.12.1 and Bun v1.4.4 agree on the corpus's own key/value entries. Node
returns a null-prototype object while Bun returns an ordinary object. Bun also
expands double-quoted `\\r`, while this Node version leaves it literal. This
adapter preserves the pinned Bun parser and ordinary-object representation.
These differences are not fixes to upstream parsing and are not Nuxt acceptance.

# Assert CallTracker

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/assert.ts`, CallTracker classes and behavior | Adapted upstream implementation | Bun `src/js/internal/assert/calltracker.ts` at `9510e74152073d850a18758ca41114d8f214ffa6`, SHA-256 `e8cfa744a3ddc243319d545f4c1d63f4bc612f651ee87223c5e96305e7d5a997` |
| Lazy `assert.CallTracker` getter and setter | Adapted upstream implementation | Bun `src/js/node/assert.ts` at the same revision, SHA-256 `58e99be2cab752f2e062e87ac3f164c84ac1cb595e683f7c94affb8829184b7c` |
| Existing assertion details and `util().deprecate` integration | Original adapter | Existing c0cd implementation |

The adaptation retains Bun's tracked function Proxy, frozen call records, reset/report/verify behavior, expected-count validation, lazy DEP0173 getter, and per-check `AssertionError.details`. Null is not accepted as a noop: only `undefined` selects the no-op, preserving upstream's property-access failure. One lazy descriptor is defined on `assert` and copied to `assert.strict`, so constructor identity is shared while setters remain independent. Local validators, inspection, error constructors, and TypeScript declarations replace internal primordials. The getter uses the existing `util().deprecate` adapter. No new loader registration, engine API, or native binding is introduced.

`scripts/assert-calltracker.test.ts` evaluates the real production factories and compares tracking, arguments and receiver identity, frozen records, verify/reset, validation, multiple failures, and process-exit behavior with native Bun 1.4.4. Node 26.12.1 was measured and does not expose this deprecated API, so it is not used as a positive oracle. `checks/runtime-assert-calltracker.json` selects the regression under the runtime owner.

This is a generic API compatibility unit, not a wholesale PR129 rebase and not an application acceptance result.

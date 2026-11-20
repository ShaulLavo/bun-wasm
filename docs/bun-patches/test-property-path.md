# toHaveProperty paths

Class: Original adapter.

`toHaveProperty` in `crates/bunwasm-runtime/src/js/bun_test.js` resolves its
path the way `JSC__JSValue__getIfPropertyExistsFromPath` in Bun's
`src/jsc/bindings/bindings.cpp` does, called from
`src/runtime/test_runner/expect/toHaveProperty.rs`, at revision
`9510e74152073d850a18758ca41114d8f214ffa6`, checked against native Bun 1.4.4.
No upstream code is copied.

As in Jest, a string path does not validate dot or bracket notation. Brackets
are skipped. A `.` at the start or end of the path, or two in a row, looks up
the empty-string key. A path made only of separators finds nothing unless it
ends in `.`. Each step converts the current value to an object, so a string has
`length`, inherited keys count, and stepping through null or undefined throws a
TypeError, as JSC's `toObject` does. The empty path looks up the empty-string
key. An array path names each key and accepts only strings and numbers. A path
that is neither a string nor an array throws `Expected path must be a string or
an array`, and a null or undefined received value has no properties.

`.each` label variables (`$a.b`) keep their own lookup, which never throws. The
`test-to-have-property-path` fixture covers these rules on every engine.

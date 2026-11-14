# Custom matcher registration and results

Class: Original adapter.

`crates/bunwasm-runtime/src/js/test_extensions.ts` implements extension
registration, symmetric matcher results and matcher context for our `bun:test`
runner. It is original code, with behavior checked against Bun's
`test/js/bun/test/expect-extend.test.js` at revision
`9510e74152073d850a18758ca41114d8f214ffa6` and native Bun 1.4.4.

Registration visits string properties through the supplied object's prototype
chain, including non-enumerable class methods. It skips inherited constructors
and built-in object/function prototypes, and keeps the nearest property when
names are shadowed. Invalid matcher values fail during registration.
Primitive collections fail at registration. Function collections retain their
enumerable matcher entries without treating built-in function metadata as matchers.
Array collections register their enumerable entries, excluding length metadata
and built-in prototype methods.

Symmetric results use the existing promise-settlement adapter before validation.
An object must have a defined `pass` property, whose truthiness determines the
result. Invalid results include their inspected value in the diagnostic. Failure
messages are evaluated lazily and converted to strings, preserving conversion
errors. The color helpers use the existing colorless inspector.
Result fields use property reads without Proxy existence checks. The pass value
is read once, and the message is read only for a failing result.

The native oracle does not register a uniquely named inherited class method.
The pinned upstream class test reuses the preceding prototype test's matcher
name, hiding this difference. Our fixture uses separate names and requires
class registration explicitly. Async asymmetric equality remains outside this
adapter; its recursive equality path is synchronous.

The build's existing TypeScript erasure flow embeds this factory. No generated
JavaScript is checked in.

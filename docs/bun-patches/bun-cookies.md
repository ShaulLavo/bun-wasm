### Bun cookies

`crates/bunwasm-runtime/src/js/cookie.ts`. Class **Port**. Upstream `src/jsc/bindings/{Cookie,CookieMap}.{cpp,h}` and `src/jsc/bindings/webcore/{JSCookie,JSCookieMap}.cpp` at the Bun pin.

Translate cookie parsing, attribute validation, serialization, CookieMap behavior, and binding coercions into JavaScript. Replace native objects with WeakMap-backed state, use local string/date operations, and route inspection through Bun.inspect. These changes preserve the API without JSC host classes. This is a translated port even though it shares little literal source text with C++. The strict TypeScript conversion adds WeakMap state, cookie option and iterator contracts without changing the emitted runtime syntax. Its comparison revision is `9510e74152073d850a18758ca41114d8f214ffa6`.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/cookie.ts`](#bun-cookies) | Port | Translate Bun's cookie parsing, validation, and binding behavior. |

[Parent context](bun-patch-series.md).

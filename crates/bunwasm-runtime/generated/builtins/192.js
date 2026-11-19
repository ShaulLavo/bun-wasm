// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/thirdparty/isomorphic-fetch.ts.
(function (intrinsics) {
"use strict";
var $, bunFetch = Bun.fetch, fetch = (...args) => bunFetch(...args);
fetch.default = fetch;
fetch.fetch = fetch;
$ = fetch;
return $;
})

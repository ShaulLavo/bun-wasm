// Generated from Bun a7733435cf40429e3b35c36072769df2052b80f1, src/js/thirdparty/isomorphic-fetch.ts.
(function (intrinsics) {
"use strict";
var $, bunFetch = Bun.fetch, fetch = (...args) => bunFetch(...args);
fetch.default = fetch;
fetch.fetch = fetch;
$ = fetch;
return $;
})

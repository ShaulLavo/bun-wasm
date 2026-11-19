// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/thirdparty/vercel_fetch.js.
(function (intrinsics) {
"use strict";
var $;
$ = (wrapper = Bun.fetch) => {
    async function vercelFetch(url, opts = {}) {
        if (opts.body && typeof opts.body === "object" && (!("buffer" in opts.body) || typeof opts.body.buffer !== "object" || !(opts.body.buffer instanceof intrinsics.ArrayBuffer))) {
            if (opts.body = JSON.stringify(opts.body), !opts.headers)
                opts.headers = new Headers;
            opts.headers.set("Content-Type", "application/json");
        }
        try {
            return await wrapper(url, opts);
        }
        catch (error) {
            throw error.url = url, error.opts = opts, error;
        }
    }
    return vercelFetch.default = vercelFetch, vercelFetch;
};
return $;
})

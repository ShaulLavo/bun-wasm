// Generated from Bun a7733435cf40429e3b35c36072769df2052b80f1, src/js/thirdparty/vercel_fetch.js.
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

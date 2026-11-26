// Generated from Bun a7733435cf40429e3b35c36072769df2052b80f1, src/js/thirdparty/node-fetch.ts.
(function (intrinsics) {
"use strict";
var $, bindings = intrinsics.lazy(160), WebResponse = bindings[0], WebRequest = bindings[1], Blob = bindings[2], WebHeaders = bindings[3], FormData = bindings[4], File = bindings[5], nativeFetch = Bun.fetch, JSONParse = JSON.parse;
class Headers extends WebHeaders {
    raw() {
        let obj = this.toJSON();
        for (let key in obj) {
            let val = obj[key];
            if (!intrinsics.isJSArray(val))
                obj[key] = [val];
        }
        return obj;
    }
    sort() {
        intrinsics.throwTypeError("Expected this to be instanceof URLSearchParams");
    }
}
var kHeaders = Symbol("kHeaders"), kBody = Symbol("kBody"), kFetched = Symbol("kFetched"), HeadersPrototype = Headers.prototype;
function closeEmptyBody(controller) {
    controller.close();
}
function readableFromOldStyleStream(source) {
    let { PassThrough } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 180) || intrinsics.createInternalModuleById(180), passthrough = new PassThrough;
    return source.on("error", (err) => {
        if (!passthrough.writableEnded)
            passthrough.destroy(err);
    }), source.pipe(passthrough), passthrough;
}
class Response extends WebResponse {
    [kBody];
    [kHeaders];
    [kFetched];
    constructor(body, init) {
        let { Readable, Stream } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 180) || intrinsics.createInternalModuleById(180);
        if (body && typeof body === "object" && (body instanceof Stream || body instanceof Readable))
            body = Readable.toWeb(body instanceof Readable ? body : readableFromOldStyleStream(body));
        super(body, init);
    }
    get body() {
        let body = this[kBody];
        if (!body) {
            var web = super.body;
            if (!web) {
                if (!this[kFetched])
                    return null;
                web = new intrinsics.ReadableStream({ start: closeEmptyBody });
            }
            body = this[kBody] = new (intrinsics.getInternalField(intrinsics.internalModuleRegistry, 128) || intrinsics.createInternalModuleById(128))._ReadableFromWeb({ responseBody: !0 }, web);
        }
        return body;
    }
    get headers() {
        return this[kHeaders] ??= Object.setPrototypeOf(super.headers, HeadersPrototype);
    }
    clone() {
        let cloned = Object.setPrototypeOf(super.clone(), ResponsePrototype);
        if (this[kBody] = intrinsics.undefined, this[kFetched])
            cloned[kFetched] = !0;
        return cloned;
    }
    async json() {
        return JSONParse(await super.text());
    }
    async buffer() {
        return new intrinsics.Buffer(await super.arrayBuffer());
    }
    get type() {
        if (!super.ok)
            return "error";
        return "default";
    }
}
var ResponsePrototype = Response.prototype, kUrl = Symbol("kUrl"), ObjectHasOwn = Object.hasOwn;
function tlsFromAgent(agent, url) {
    if (intrinsics.isCallable(agent)) {
        let href = intrinsics.isObject(url) ? url.href ?? url.url : url;
        if (typeof href !== "string" || !URL.canParse(href))
            return intrinsics.undefined;
        agent = intrinsics.uncurry(agent, "call")(intrinsics.undefined, new URL(href));
    }
    if (!intrinsics.isObject(agent) || !ObjectHasOwn(agent, "options") || !intrinsics.isObject(agent.options))
        return intrinsics.undefined;
    return (intrinsics.getInternalField(intrinsics.internalModuleRegistry, 117) || intrinsics.createInternalModuleById(117)).nodeClientTlsToNative({ __proto__: null, ...agent.options });
}
class Request extends WebRequest {
    [kUrl];
    constructor(input, init) {
        if (typeof input === "string" && !URL.canParse(input)) {
            super(new URL(input, "http://localhost/"), init);
            this[kUrl] = input;
        }
        else
            super(input, init);
    }
    get url() {
        return this[kUrl] ?? super.url;
    }
}
async function fetch(url, init) {
    let initBody = init?.body;
    if (initBody && typeof initBody === "object" && !initBody[Symbol.asyncIterator]) {
        let { Readable, Stream } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 180) || intrinsics.createInternalModuleById(180);
        if (initBody instanceof Stream || initBody instanceof Readable) {
            let readable = initBody instanceof Readable ? initBody : readableFromOldStyleStream(initBody);
            init = { ...init, body: Readable.toWeb(readable) };
        }
    }
    if (init && ObjectHasOwn(init, "agent") && init.agent && init.tls === intrinsics.undefined) {
        let tls = tlsFromAgent(init.agent, url);
        if (tls !== intrinsics.undefined)
            init = { ...init, tls };
    }
    let response = await intrinsics.uncurry(nativeFetch, "call")(intrinsics.undefined, url, init);
    return Object.setPrototypeOf(response, ResponsePrototype), response[kFetched] = !0, response;
}
class AbortError extends DOMException {
    constructor(message) {
        super(message, "AbortError");
    }
}
class FetchBaseError extends Error {
    type;
    constructor(message, type) {
        super(message);
        this.type = type;
    }
}
class FetchError extends FetchBaseError {
    constructor(message, type, systemError) {
        super(message, type);
        this.code = systemError?.code;
    }
}
function blobFrom(path, options) {
    return intrinsics.Promise[intrinsics.privateName("resolve")](Bun.file(path, options));
}
function blobFromSync(path, options) {
    return Bun.file(path, options);
}
var fileFrom = blobFrom, fileFromSync = blobFromSync;
function isRedirect(code) {
    return code === 301 || code === 302 || code === 303 || code === 307 || code === 308;
}
$ = Object.assign(fetch, {
    AbortError,
    Blob,
    FetchBaseError,
    FetchError,
    File,
    FormData,
    Headers,
    Request,
    Response,
    blobFrom,
    blobFromSync,
    fileFrom,
    fileFromSync,
    isRedirect,
    fetch,
    default: fetch
});
return $;
})

// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/thirdparty/undici.js.
(function (intrinsics) {
"use strict";
var $, EventEmitter = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 153) || intrinsics.createInternalModuleById(153), { _ReadableFromWeb: ReadableFromWeb } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 123) || intrinsics.createInternalModuleById(123), ObjectCreate = Object.create, kEmptyObject = ObjectCreate(null), fetch = Bun.fetch, bindings = intrinsics.lazy(135), Response = bindings[0], Request = bindings[1], Headers = bindings[2], FormData = bindings[3], File = bindings[4], URL = bindings[5], AbortSignal = bindings[6], URLSearchParams = bindings[7], WebSocket = bindings[8], CloseEvent = bindings[9], ErrorEvent = bindings[10], MessageEvent = bindings[11];
class FileReader extends EventTarget {
    constructor() {
        super();
    }
    static EMPTY = 0;
    static LOADING = 1;
    static DONE = 2;
}
function notImplemented() {
    throw Error("This function is not yet implemented in Bun");
}
function closeEmptyBody(controller) {
    controller.close();
}
class BodyReadable extends ReadableFromWeb {
    #response;
    #bodyUsed;
    constructor(response, options = {}) {
        super({ ...options, responseBody: !0 }, response.body ?? new intrinsics.ReadableStream({ start: closeEmptyBody }));
        this.#response = response, this.#bodyUsed = response.bodyUsed;
    }
    get bodyUsed() {
        return this.#bodyUsed;
    }
    #consume() {
        if (this.#bodyUsed)
            intrinsics.throwTypeError("unusable");
        this.#bodyUsed = !0;
    }
    async arrayBuffer() {
        return this.#consume(), await this.#response.arrayBuffer();
    }
    async blob() {
        return this.#consume(), await this.#response.blob();
    }
    async formData() {
        return this.#consume(), await this.#response.formData();
    }
    async json() {
        return this.#consume(), await this.#response.json();
    }
    async text() {
        return this.#consume(), await this.#response.text();
    }
}
async function request(url, options = {
    method: "GET",
    signal: null,
    headers: null,
    query: null,
    reset: !1,
    throwOnError: !1,
    body: null
}) {
    let { method = "GET", headers: inputHeaders, query, signal, reset = !1, throwOnError = !1, body: inputBody, maxRedirections } = options;
    if (typeof url === "string") {
        if (query)
            url = new URL(url);
    }
    else if (typeof url === "object" && url !== null) {
        if (!(url instanceof URL))
            throw Error("not implemented");
    }
    else
        intrinsics.throwTypeError("url must be a string, URL, or UrlObject");
    if (typeof url === "string" && query)
        url = new URL(url);
    if (typeof url === "object" && url !== null && query) {
        if (query)
            url.search = new URLSearchParams(query).toString();
    }
    if (method = method && typeof method === "string" ? method.toUpperCase() : null, inputBody && (method === "GET" || method === "HEAD"))
        throw Error("Body not allowed for GET or HEAD requests");
    if (maxRedirections != null && (!Number.isInteger(maxRedirections) || maxRedirections < 0))
        throw Error("maxRedirections must be a positive number");
    if (signal && !(signal instanceof AbortSignal))
        throw Error("signal must be an instance of AbortSignal");
    let followRedirects = maxRedirections != null && maxRedirections > 0, resp = await fetch(url, {
        signal,
        mode: "cors",
        method,
        headers: inputHeaders || kEmptyObject,
        body: inputBody,
        redirect: followRedirects ? "follow" : "manual",
        maxRedirects: followRedirects ? maxRedirections : intrinsics.undefined,
        keepalive: !reset
    }), { status: statusCode, headers, trailers } = resp;
    if (throwOnError && statusCode >= 400 && statusCode < 600)
        throw Error(`Request failed with status code ${statusCode}`);
    let body = new BodyReadable(resp);
    return { statusCode, headers: headers.toJSON(), body, trailers, opaque: kEmptyObject, context: kEmptyObject };
}
function stream() {
    notImplemented();
}
function pipeline() {
    notImplemented();
}
function connect() {
    notImplemented();
}
function upgrade() {
    notImplemented();
}
class MockClient {
    constructor() { }
}
class MockPool {
    constructor() { }
}
class MockAgent {
    constructor() { }
}
function mockErrors() { }
class Dispatcher extends EventEmitter {
}
class Agent extends Dispatcher {
}
class Pool extends Dispatcher {
    request() { }
}
class BalancedPool extends Dispatcher {
}
class Client extends Dispatcher {
    request() { }
}
class DispatcherBase extends EventEmitter {
}
class ProxyAgent extends DispatcherBase {
    constructor() {
        super();
    }
}
class EnvHttpProxyAgent extends DispatcherBase {
    constructor() {
        super();
    }
}
class RetryAgent extends Dispatcher {
    constructor() {
        super();
    }
}
class RetryHandler {
    constructor() { }
}
class DecoratorHandler {
    constructor() { }
}
class RedirectHandler {
    constructor() { }
}
function createRedirectInterceptor() {
    return new RedirectHandler;
}
var interceptors = {
    redirect: () => { },
    retry: () => { },
    dump: () => { }
};
class UndiciError extends Error {
}
class AbortError extends UndiciError {
}
class HTTPParserError extends Error {
}
class HeadersTimeoutError extends UndiciError {
}
class HeadersOverflowError extends UndiciError {
}
class BodyTimeoutError extends UndiciError {
}
class RequestContentLengthMismatchError extends UndiciError {
}
class ConnectTimeoutError extends UndiciError {
}
class ResponseStatusCodeError extends UndiciError {
}
class InvalidArgumentError extends UndiciError {
}
class InvalidReturnValueError extends UndiciError {
}
class RequestAbortedError extends AbortError {
}
class ClientDestroyedError extends UndiciError {
}
class ClientClosedError extends UndiciError {
}
class InformationalError extends UndiciError {
}
class SocketError extends UndiciError {
}
class NotSupportedError extends UndiciError {
}
class ResponseContentLengthMismatchError extends UndiciError {
}
class BalancedPoolMissingUpstreamError extends UndiciError {
}
class ResponseExceededMaxSizeError extends UndiciError {
}
class RequestRetryError extends UndiciError {
}
class SecureProxyConnectionError extends UndiciError {
}
var errors = {
    AbortError,
    HTTPParserError,
    UndiciError,
    HeadersTimeoutError,
    HeadersOverflowError,
    BodyTimeoutError,
    RequestContentLengthMismatchError,
    ConnectTimeoutError,
    ResponseStatusCodeError,
    InvalidArgumentError,
    InvalidReturnValueError,
    RequestAbortedError,
    ClientDestroyedError,
    ClientClosedError,
    InformationalError,
    SocketError,
    NotSupportedError,
    ResponseContentLengthMismatchError,
    BalancedPoolMissingUpstreamError,
    ResponseExceededMaxSizeError,
    RequestRetryError,
    SecureProxyConnectionError
}, util = {
    parseHeaders: () => {
        notImplemented();
    },
    headerNameToString: () => {
        notImplemented();
    }
};
class EventSource extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor() {
        super();
    }
}
function deleteCookie() {
    notImplemented();
}
function getCookies() {
    notImplemented();
}
function getSetCookies() {
    notImplemented();
}
function setCookie() {
    notImplemented();
}
function parseMIMEType() {
    notImplemented();
}
function serializeAMimeType() {
    notImplemented();
}
var globalDispatcher;
function setGlobalDispatcher(dispatcher) {
    globalDispatcher = dispatcher;
}
function getGlobalDispatcher() {
    return globalDispatcher ??= new Dispatcher;
}
function setGlobalOrigin() { }
function getGlobalOrigin() { }
var caches = {};
function buildConnector(_options = {}) {
    return function connect(_options) {
        notImplemented();
    };
}
var moduleExports = {
    Agent,
    BalancedPool,
    buildConnector,
    caches,
    Client,
    CloseEvent,
    connect,
    createRedirectInterceptor,
    DecoratorHandler,
    deleteCookie,
    Dispatcher,
    EnvHttpProxyAgent,
    ErrorEvent,
    errors,
    EventSource,
    fetch,
    File,
    FileReader,
    FormData,
    getCookies,
    getGlobalDispatcher,
    getGlobalOrigin,
    getSetCookies,
    Headers,
    interceptors,
    MessageEvent,
    MockAgent,
    MockClient,
    mockErrors,
    MockPool,
    parseMIMEType,
    pipeline,
    Pool,
    ProxyAgent,
    RedirectHandler,
    Request,
    request,
    Response,
    RetryAgent,
    RetryHandler,
    serializeAMimeType,
    setCookie,
    setGlobalDispatcher,
    setGlobalOrigin,
    stream,
    upgrade,
    util,
    WebSocket
};
moduleExports.default = moduleExports;
$ = moduleExports;
return $;
})

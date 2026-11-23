// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/internal/streams/iter/utils.ts.
(function (intrinsics) {
"use strict";
var $, { isUint8Array } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 205) || intrinsics.createInternalModuleById(205), { validateOneOf } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 122) || intrinsics.createInternalModuleById(122), ObjectGetPrototypeOf = Object.getPrototypeOf, BufferPrototype = intrinsics.Buffer.prototype, kBufferPoolBypassThreshold = intrinsics.Buffer.poolSize >>> 1, isError, kResolvedPromise = intrinsics.Promise.resolve(), encoder = new TextEncoder, kPushDefaultHWM = 4, kMultiConsumerDefaultHWM = 16;
function clampHWM(value) {
    return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, value));
}
function onSignalAbort(signal, handler) {
    if (signal.aborted)
        handler();
    else
        signal.addEventListener("abort", handler, { __proto__: null, once: !0 });
}
function getMinCursor(consumers, fallback) {
    let minCursor = fallback, minCursorConsumers = 0;
    for (let consumer of consumers) {
        let cursor = consumer.cursor;
        if (cursor < minCursor)
            minCursor = cursor, minCursorConsumers = 1;
        else if (cursor === minCursor)
            minCursorConsumers++;
    }
    return { __proto__: null, minCursor, minCursorConsumers };
}
function toUint8Array(chunk) {
    if (typeof chunk === "string")
        return encoder.encode(chunk);
    if (!isUint8Array(chunk))
        throw intrinsics.makeErrorWithCode(112, "chunk", ["string", "Uint8Array"], chunk);
    return chunk;
}
function allUint8Array(chunks) {
    for (let i = 0; i < chunks.length; i++)
        if (typeof chunks[i] === "string")
            return !1;
    return !0;
}
function concatBytes(chunks) {
    if (chunks.length === 0)
        return new intrinsics.Uint8Array(0);
    if (chunks.length === 1) {
        let chunk = chunks[0];
        if (chunk.byteOffset === 0) {
            if (!(chunk.byteLength < kBufferPoolBypassThreshold && ObjectGetPrototypeOf(chunk) === BufferPrototype) && chunk.byteLength === chunk.buffer.byteLength)
                return chunk;
        }
        return new intrinsics.Uint8Array(chunk);
    }
    let totalByteLength = 0;
    for (let i = 0; i < chunks.length; i++)
        totalByteLength += chunks[i].byteLength;
    let concatenated = new intrinsics.Uint8Array(totalByteLength), offset = 0;
    for (let i = 0; i < chunks.length; i++)
        concatenated.set(chunks[i], offset), offset += chunks[i].byteLength;
    return concatenated;
}
function convertChunks(chunks) {
    if (allUint8Array(chunks))
        return chunks.slice();
    let len = chunks.length, result = new intrinsics.Array(len);
    for (let i = 0; i < len; i++)
        result[i] = toUint8Array(chunks[i]);
    return result;
}
function wrapError(error) {
    return isError ??= (intrinsics.getInternalField(intrinsics.internalModuleRegistry, 185) || intrinsics.createInternalModuleById(185)).isError, isError(error) ? error : intrinsics.makeErrorWithCode(148, intrinsics.String(error));
}
function hasProtocol(value, symbol) {
    return value !== null && typeof value === "object" && symbol in value && typeof value[symbol] === "function";
}
function isPullOptions(value) {
    return value !== null && typeof value === "object" && !("transform" in value) && !("write" in value);
}
function isTransformObject(value) {
    return typeof value?.transform === "function";
}
function isTransform(value) {
    return typeof value === "function" || isTransformObject(value);
}
function parsePullArgs(args) {
    if (args.length === 0)
        return { __proto__: null, transforms: [], options: intrinsics.undefined };
    let transforms, options, last = args[args.length - 1];
    if (isPullOptions(last))
        transforms = args.slice(0, -1), options = last;
    else
        transforms = args, options = intrinsics.undefined;
    for (let i = 0; i < transforms.length; i++)
        if (!isTransform(transforms[i]))
            throw intrinsics.makeErrorWithCode(112, `transforms[${i}]`, ["Function", "Object with transform()"], transforms[i]);
    return { __proto__: null, transforms, options };
}
function validateBackpressure(value) {
    validateOneOf(value, "options.backpressure", ["strict", "block", "drop-oldest", "drop-newest"]);
}
$ = {
    kMultiConsumerDefaultHWM,
    kPushDefaultHWM,
    kResolvedPromise,
    clampHWM,
    concatBytes,
    convertChunks,
    getMinCursor,
    hasProtocol,
    isPullOptions,
    isTransform,
    isTransformObject,
    onSignalAbort,
    parsePullArgs,
    toUint8Array,
    validateBackpressure,
    wrapError
};
return $;
})

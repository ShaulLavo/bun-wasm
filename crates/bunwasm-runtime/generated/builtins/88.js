// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/internal/streams/iter/consumers.ts.
(function (intrinsics) {
"use strict";
var $, { validateAbortSignal, validateFunction, validateInteger, validateObject } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 122) || intrinsics.createInternalModuleById(122), { from, fromSync, isAsyncIterable, isSyncIterable } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 90) || intrinsics.createInternalModuleById(90), { concatBytes } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 97) || intrinsics.createInternalModuleById(97), { drainableProtocol, toAsyncStreamable, toStreamable } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 96) || intrinsics.createInternalModuleById(96), { isAnyArrayBuffer, isSharedArrayBuffer } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 205) || intrinsics.createInternalModuleById(205), SymbolAsyncIterator = Symbol.asyncIterator;
function isMergeOptions(value) {
    return value !== null && typeof value === "object" && !intrinsics.ArrayBuffer.isView(value) && typeof value[toStreamable] !== "function" && typeof value[toAsyncStreamable] !== "function" && !isAsyncIterable(value) && !isSyncIterable(value) && !isAnyArrayBuffer(value);
}
function collectSync(source, limit) {
    let normalized = fromSync(source), chunks = [], totalBytes = 0;
    for (let batch of normalized)
        for (let i = 0; i < batch.length; i++) {
            let chunk = batch[i];
            if (limit !== intrinsics.undefined) {
                if (totalBytes += chunk.byteLength, totalBytes > limit)
                    throw intrinsics.makeErrorWithCode(149, "totalBytes", `<= ${limit}`, totalBytes);
            }
            chunks.push(chunk);
        }
    return chunks;
}
async function collectAsync(source, signal, limit) {
    signal?.throwIfAborted();
    let normalized = from(source), chunks = [];
    if (!signal && limit === intrinsics.undefined) {
        for await (let batch of normalized)
            for (let i = 0; i < batch.length; i++)
                chunks.push(batch[i]);
        return chunks;
    }
    let totalBytes = 0;
    for await (let batch of normalized) {
        signal?.throwIfAborted();
        for (let i = 0; i < batch.length; i++) {
            let chunk = batch[i];
            if (limit !== intrinsics.undefined) {
                if (totalBytes += chunk.byteLength, totalBytes > limit)
                    throw intrinsics.makeErrorWithCode(149, "totalBytes", `<= ${limit}`, totalBytes);
            }
            chunks.push(chunk);
        }
    }
    return chunks;
}
function toArrayBuffer(data) {
    let { byteOffset, byteLength, buffer } = data;
    if (isSharedArrayBuffer(buffer)) {
        if (byteOffset === 0 && byteLength === buffer.byteLength)
            return buffer;
        return buffer.slice(byteOffset, byteOffset + byteLength);
    }
    if (byteOffset === 0 && byteLength === buffer.byteLength)
        return buffer;
    return buffer.slice(byteOffset, byteOffset + byteLength);
}
function validateBaseConsumerOptions(options) {
    validateObject(options, "options");
    let limit = options.limit;
    if (limit !== intrinsics.undefined)
        validateInteger(limit, "options.limit", 0);
    let encoding = options.encoding;
    if (encoding !== intrinsics.undefined) {
        if (typeof encoding !== "string")
            throw intrinsics.makeErrorWithCode(112, "options.encoding", "string", encoding);
        try {
            new TextDecoder(encoding);
        }
        catch {
            throw intrinsics.makeErrorWithCode(114, "options.encoding", encoding);
        }
    }
}
function validateConsumerOptions(options) {
    validateBaseConsumerOptions(options);
    let { signal } = options;
    if (signal !== intrinsics.undefined)
        validateAbortSignal(signal, "options.signal");
}
function validateSyncConsumerOptions(options) {
    validateBaseConsumerOptions(options);
}
var kNullPrototype = { __proto__: null };
function bytesSync(source, options = kNullPrototype) {
    return validateSyncConsumerOptions(options), concatBytes(collectSync(source, options.limit));
}
function textSync(source, options = kNullPrototype) {
    validateSyncConsumerOptions(options);
    let data = concatBytes(collectSync(source, options.limit));
    return new TextDecoder(options.encoding ?? "utf-8", {
        __proto__: null,
        fatal: !0
    }).decode(data);
}
function arrayBufferSync(source, options = kNullPrototype) {
    return validateSyncConsumerOptions(options), toArrayBuffer(concatBytes(collectSync(source, options.limit)));
}
function arraySync(source, options = kNullPrototype) {
    return validateSyncConsumerOptions(options), collectSync(source, options.limit);
}
async function bytes(source, options = kNullPrototype) {
    validateConsumerOptions(options);
    let chunks = await collectAsync(source, options.signal, options.limit);
    return concatBytes(chunks);
}
async function text(source, options = kNullPrototype) {
    validateConsumerOptions(options);
    let chunks = await collectAsync(source, options.signal, options.limit), data = concatBytes(chunks);
    return new TextDecoder(options.encoding ?? "utf-8", {
        __proto__: null,
        fatal: !0
    }).decode(data);
}
async function arrayBuffer(source, options = kNullPrototype) {
    validateConsumerOptions(options);
    let chunks = await collectAsync(source, options.signal, options.limit);
    return toArrayBuffer(concatBytes(chunks));
}
async function array(source, options = kNullPrototype) {
    return validateConsumerOptions(options), collectAsync(source, options.signal, options.limit);
}
function tap(callback) {
    return validateFunction(callback, "callback"), async (chunks, options) => (await callback(chunks, options), chunks);
}
function tapSync(callback) {
    return validateFunction(callback, "callback"), (chunks) => (callback(chunks), chunks);
}
function ondrain(drainable) {
    if (drainable === null || drainable === intrinsics.undefined || typeof drainable !== "object")
        return null;
    if (!(drainableProtocol in drainable) || typeof drainable[drainableProtocol] !== "function")
        return null;
    return drainable[drainableProtocol]();
}
function merge(...args) {
    let sources, options, argc = args.length;
    if (argc > 0 && isMergeOptions(args[argc - 1]))
        options = args[argc - 1], sources = args.slice(0, -1);
    else
        sources = args;
    if (options?.signal !== intrinsics.undefined)
        validateAbortSignal(options.signal, "options.signal");
    let normalized = sources.map((source) => from(source));
    return {
        __proto__: null,
        async *[SymbolAsyncIterator]() {
            let signal = options?.signal;
            if (signal?.throwIfAborted(), normalized.length === 0)
                return;
            if (normalized.length === 1) {
                for await (let batch of normalized[0])
                    signal?.throwIfAborted(), yield batch;
                return;
            }
            let ready = [], activeCount = normalized.length, waitResolve = null, onSettled = (iterator, result) => {
                if (result.done)
                    activeCount--;
                else
                    ready.push(result.value), iterator.next().then((r) => onSettled(iterator, r), (err) => {
                        if (ready.push({ __proto__: null, error: err }), waitResolve)
                            waitResolve(), waitResolve = null;
                    });
                if (waitResolve)
                    waitResolve(), waitResolve = null;
            }, iterators = [];
            for (let i = 0; i < normalized.length; i++) {
                let iterator = normalized[i][SymbolAsyncIterator]();
                iterators.push(iterator), iterator.next().then((r) => onSettled(iterator, r), (err) => {
                    if (ready.push({ __proto__: null, error: err }), waitResolve)
                        waitResolve(), waitResolve = null;
                });
            }
            try {
                while (activeCount > 0 || ready.length > 0) {
                    signal?.throwIfAborted();
                    while (ready.length > 0) {
                        let item = ready.shift();
                        if (item?.error)
                            throw item.error;
                        yield item;
                    }
                    if (activeCount > 0)
                        await new intrinsics.Promise((resolve) => {
                            waitResolve = resolve;
                        });
                }
            }
            finally {
                await intrinsics.Promise.all(iterators.map(async (iterator) => {
                    if (iterator.return)
                        try {
                            await iterator.return();
                        }
                        catch { }
                }));
            }
        }
    };
}
$ = {
    array,
    arrayBuffer,
    arrayBufferSync,
    arraySync,
    bytes,
    bytesSync,
    merge,
    ondrain,
    tap,
    tapSync,
    text,
    textSync
};
return $;
})

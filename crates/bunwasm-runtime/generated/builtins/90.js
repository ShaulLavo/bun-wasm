// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/internal/streams/iter/from.ts.
(function (intrinsics) {
"use strict";
var $, { isAnyArrayBuffer, isPromise, isTypedArray, isUint8Array } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 205) || intrinsics.createInternalModuleById(205), { kValidatedSource, toStreamable, toAsyncStreamable } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 96) || intrinsics.createInternalModuleById(96), { hasProtocol, toUint8Array } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 97) || intrinsics.createInternalModuleById(97), FROM_BATCH_SIZE = 128;
function isPrimitiveChunk(value) {
    return typeof value === "string" || isAnyArrayBuffer(value) || intrinsics.ArrayBuffer.isView(value);
}
function isSyncIterable(value) {
    return typeof value !== "string" && typeof value?.[Symbol.iterator] === "function";
}
function isAsyncIterable(value) {
    return typeof value?.[Symbol.asyncIterator] === "function";
}
function primitiveToUint8Array(chunk) {
    if (typeof chunk === "string")
        return toUint8Array(chunk);
    if (isAnyArrayBuffer(chunk))
        return new intrinsics.Uint8Array(chunk);
    if (isUint8Array(chunk))
        return chunk;
    return arrayBufferViewToUint8Array(chunk);
}
function arrayBufferViewToUint8Array(chunk) {
    if (isTypedArray(chunk))
        return new intrinsics.Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return new intrinsics.Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}
function* normalizeSyncValue(value) {
    if (isPrimitiveChunk(value)) {
        yield primitiveToUint8Array(value);
        return;
    }
    if (hasProtocol(value, toStreamable)) {
        let result = value[toStreamable]();
        yield* normalizeSyncValue(result);
        return;
    }
    if (intrinsics.Array.isArray(value)) {
        for (let i = 0; i < value.length; i++)
            yield* normalizeSyncValue(value[i]);
        return;
    }
    if (isSyncIterable(value)) {
        for (let item of value)
            yield* normalizeSyncValue(item);
        return;
    }
    throw intrinsics.makeErrorWithCode(112, "value", ["string", "ArrayBuffer", "ArrayBufferView", "Iterable", "toStreamable"], value);
}
function isUint8ArrayBatch(value) {
    if (!intrinsics.Array.isArray(value))
        return !1;
    let len = value.length;
    if (len === 0)
        return !0;
    if (len === 1)
        return isUint8Array(value[0]);
    if (!isUint8Array(value[0]) || !isUint8Array(value[len - 1]))
        return !1;
    if (len === 2)
        return !0;
    for (let i = 1; i < len - 1; i++)
        if (!isUint8Array(value[i]))
            return !1;
    return !0;
}
function* yieldBoundedBatch(batch) {
    if (batch.length === 0)
        return;
    if (batch.length <= FROM_BATCH_SIZE) {
        yield batch;
        return;
    }
    for (let i = 0; i < batch.length; i += FROM_BATCH_SIZE)
        yield batch.slice(i, i + FROM_BATCH_SIZE);
}
function* normalizeSyncSource(source) {
    let batch = [];
    for (let value of source) {
        if (isUint8ArrayBatch(value)) {
            if (batch.length > 0)
                yield batch, batch = [];
            yield* yieldBoundedBatch(value);
            continue;
        }
        if (isUint8Array(value)) {
            if (batch.push(value), batch.length === FROM_BATCH_SIZE)
                yield batch, batch = [];
            continue;
        }
        if (batch.length > 0)
            yield batch, batch = [];
        let valueBatch = [];
        for (let chunk of normalizeSyncValue(value))
            if (valueBatch.push(chunk), valueBatch.length === FROM_BATCH_SIZE)
                yield valueBatch, valueBatch = [];
        if (valueBatch.length > 0)
            yield valueBatch;
    }
    if (batch.length > 0)
        yield batch;
}
async function* normalizeAsyncValue(value) {
    if (isPromise(value)) {
        let resolved = await value;
        yield* normalizeAsyncValue(resolved);
        return;
    }
    if (isPrimitiveChunk(value)) {
        yield primitiveToUint8Array(value);
        return;
    }
    if (hasProtocol(value, toAsyncStreamable)) {
        let result = value[toAsyncStreamable]();
        if (isPromise(result))
            yield* normalizeAsyncValue(await result);
        else
            yield* normalizeAsyncValue(result);
        return;
    }
    if (hasProtocol(value, toStreamable)) {
        let result = value[toStreamable]();
        yield* normalizeAsyncValue(result);
        return;
    }
    if (intrinsics.Array.isArray(value)) {
        for (let i = 0; i < value.length; i++)
            yield* normalizeAsyncValue(value[i]);
        return;
    }
    if (isAsyncIterable(value)) {
        for await (let item of value)
            yield* normalizeAsyncValue(item);
        return;
    }
    if (isSyncIterable(value)) {
        for (let item of value)
            yield* normalizeAsyncValue(item);
        return;
    }
    throw intrinsics.makeErrorWithCode(112, "value", ["string", "ArrayBuffer", "ArrayBufferView", "Iterable", "AsyncIterable", "toStreamable", "toAsyncStreamable"], value);
}
async function* normalizeAsyncSource(source) {
    if (isAsyncIterable(source)) {
        for await (let value of source) {
            if (isUint8ArrayBatch(value)) {
                if (value.length > 0)
                    yield value;
                continue;
            }
            if (isUint8Array(value)) {
                yield [value];
                continue;
            }
            let batch = [];
            for await (let chunk of normalizeAsyncValue(value))
                batch.push(chunk);
            if (batch.length > 0)
                yield batch;
        }
        return;
    }
    if (isSyncIterable(source)) {
        let batch = [];
        for (let value of source) {
            if (isUint8ArrayBatch(value)) {
                if (batch.length > 0)
                    yield batch, batch = [];
                yield* yieldBoundedBatch(value);
                continue;
            }
            if (isUint8Array(value)) {
                if (batch.push(value), batch.length === FROM_BATCH_SIZE)
                    yield batch, batch = [];
                continue;
            }
            if (batch.length > 0)
                yield batch, batch = [];
            let asyncBatch = [];
            for await (let chunk of normalizeAsyncValue(value))
                if (asyncBatch.push(chunk), asyncBatch.length === FROM_BATCH_SIZE)
                    yield asyncBatch, asyncBatch = [];
            if (asyncBatch.length > 0)
                yield asyncBatch;
        }
        if (batch.length > 0)
            yield batch;
        return;
    }
    throw intrinsics.makeErrorWithCode(112, "source", ["Iterable", "AsyncIterable"], source);
}
function fromSync(input) {
    if (input == null)
        throw intrinsics.makeErrorWithCode(112, "input", "a non-null value", input);
    if (isPrimitiveChunk(input)) {
        let chunk = primitiveToUint8Array(input);
        return {
            __proto__: null,
            *[Symbol.iterator]() {
                yield [chunk];
            }
        };
    }
    if (intrinsics.Array.isArray(input)) {
        if (input.length === 0)
            return {
                __proto__: null,
                *[Symbol.iterator]() { }
            };
        if (isUint8Array(input[0])) {
            if (input.every(isUint8Array)) {
                let batch = input;
                return {
                    __proto__: null,
                    *[Symbol.iterator]() {
                        if (batch.length <= FROM_BATCH_SIZE)
                            yield batch;
                        else
                            for (let i = 0; i < batch.length; i += FROM_BATCH_SIZE)
                                yield batch.slice(i, i + FROM_BATCH_SIZE);
                    }
                };
            }
        }
    }
    if (typeof input[toStreamable] === "function")
        return fromSync(input[toStreamable]());
    if (isAsyncIterable(input))
        throw intrinsics.makeErrorWithCode(112, "input", "a synchronous input (not AsyncIterable)", input);
    if (typeof input === "object" && input !== null && typeof input.then === "function")
        throw intrinsics.makeErrorWithCode(112, "input", "a synchronous input (not Promise)", input);
    if (!isSyncIterable(input))
        throw intrinsics.makeErrorWithCode(112, "input", ["string", "ArrayBuffer", "ArrayBufferView", "Iterable", "toStreamable"], input);
    return {
        __proto__: null,
        *[Symbol.iterator]() {
            yield* normalizeSyncSource(input);
        }
    };
}
function from(input) {
    if (input == null)
        throw intrinsics.makeErrorWithCode(112, "input", "a non-null value", input);
    if (input[kValidatedSource])
        return input;
    if (isPrimitiveChunk(input)) {
        let chunk = primitiveToUint8Array(input);
        return {
            __proto__: null,
            async *[Symbol.asyncIterator]() {
                yield [chunk];
            }
        };
    }
    if (intrinsics.Array.isArray(input)) {
        if (input.length === 0)
            return {
                __proto__: null,
                async *[Symbol.asyncIterator]() { }
            };
        if (isUint8Array(input[0])) {
            if (input.every(isUint8Array)) {
                let batch = input;
                return {
                    __proto__: null,
                    async *[Symbol.asyncIterator]() {
                        if (batch.length <= FROM_BATCH_SIZE)
                            yield batch;
                        else
                            for (let i = 0; i < batch.length; i += FROM_BATCH_SIZE)
                                yield batch.slice(i, i + FROM_BATCH_SIZE);
                    }
                };
            }
        }
    }
    if (typeof input[toAsyncStreamable] === "function") {
        let result = input[toAsyncStreamable]();
        if (result?.[kValidatedSource])
            return result;
        return {
            __proto__: null,
            async *[Symbol.asyncIterator]() {
                let resolved = await result;
                if (resolved?.[kValidatedSource]) {
                    yield* resolved[Symbol.asyncIterator]();
                    return;
                }
                yield* from(resolved)[Symbol.asyncIterator]();
            }
        };
    }
    if (typeof input[toStreamable] === "function")
        return from(input[toStreamable]());
    if (!isSyncIterable(input) && !isAsyncIterable(input))
        throw intrinsics.makeErrorWithCode(112, "input", ["string", "ArrayBuffer", "ArrayBufferView", "Iterable", "AsyncIterable", "toStreamable", "toAsyncStreamable"], input);
    return normalizeAsyncSource(input);
}
$ = {
    arrayBufferViewToUint8Array,
    from,
    fromSync,
    isAsyncIterable,
    isPrimitiveChunk,
    isSyncIterable,
    isUint8ArrayBatch,
    normalizeAsyncValue
};
return $;
})

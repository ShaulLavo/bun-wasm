// Generated from Bun a7733435cf40429e3b35c36072769df2052b80f1, src/js/internal/streams/iter/pull.ts.
(function (intrinsics) {
"use strict";
var $, { validateAbortSignal } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 127) || intrinsics.createInternalModuleById(127), { isAnyArrayBuffer, isPromise, isUint8Array } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 208) || intrinsics.createInternalModuleById(208), { arrayBufferViewToUint8Array, from, fromSync, isSyncIterable, isAsyncIterable, isPrimitiveChunk, isUint8ArrayBatch, normalizeAsyncValue } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 95) || intrinsics.createInternalModuleById(95), { isPullOptions, isTransform, isTransformObject, parsePullArgs, toUint8Array, wrapError } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 102) || intrinsics.createInternalModuleById(102), { drainableProtocol, kSyncWriteAcceptedOnFalse, kValidatedSource, kValidatedTransform, toAsyncStreamable, toStreamable } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 101) || intrinsics.createInternalModuleById(101);
function hasMethod(value, name) {
    return typeof value?.[name] === "function";
}
function parsePipeToArgs(args, requiredMethod) {
    if (args.length === 0)
        throw intrinsics.makeErrorWithCode(113, "args", args, "pipeTo requires a writer argument");
    let options, writerIndex = args.length - 1, last = args[args.length - 1];
    if (isPullOptions(last) && !hasMethod(last, requiredMethod))
        options = last, writerIndex = args.length - 2;
    if (writerIndex < 0)
        throw intrinsics.makeErrorWithCode(113, "args", args, "pipeTo requires a writer argument");
    let writer = args[writerIndex];
    if (!hasMethod(writer, requiredMethod))
        throw intrinsics.makeErrorWithCode(112, "writer", `object with a ${requiredMethod} method`, writer);
    let transforms = args.slice(0, writerIndex);
    for (let i = 0; i < transforms.length; i++)
        if (!isTransform(transforms[i]))
            throw intrinsics.makeErrorWithCode(112, `transforms[${i}]`, ["Function", "Object with transform()"], transforms[i]);
    return {
        __proto__: null,
        transforms,
        writer,
        options
    };
}
function canUseSyncIterablePipeToFastPath(source, transforms, signal) {
    if (signal !== intrinsics.undefined || transforms.length !== 0 || isPrimitiveChunk(source) || intrinsics.Array.isArray(source) || source?.[kValidatedSource] || !isSyncIterable(source) || isAsyncIterable(source))
        return !1;
    return typeof source[toAsyncStreamable] !== "function" && typeof source[toStreamable] !== "function";
}
function* flattenTransformYieldSync(value) {
    if (isUint8Array(value)) {
        yield value;
        return;
    }
    if (typeof value === "string") {
        yield toUint8Array(value);
        return;
    }
    if (isAnyArrayBuffer(value)) {
        yield new intrinsics.Uint8Array(value);
        return;
    }
    if (intrinsics.ArrayBuffer.isView(value)) {
        yield arrayBufferViewToUint8Array(value);
        return;
    }
    if (isSyncIterable(value)) {
        for (let item of value)
            yield* flattenTransformYieldSync(item);
        return;
    }
    throw intrinsics.makeErrorWithCode(112, "value", ["Uint8Array", "string", "ArrayBuffer", "ArrayBufferView", "Iterable"], value);
}
async function* flattenTransformYieldAsync(value) {
    if (isUint8Array(value)) {
        yield value;
        return;
    }
    if (typeof value === "string") {
        yield toUint8Array(value);
        return;
    }
    if (isAnyArrayBuffer(value)) {
        yield new intrinsics.Uint8Array(value);
        return;
    }
    if (intrinsics.ArrayBuffer.isView(value)) {
        yield arrayBufferViewToUint8Array(value);
        return;
    }
    if (isAsyncIterable(value)) {
        for await (let item of value)
            yield* flattenTransformYieldAsync(item);
        return;
    }
    if (isSyncIterable(value)) {
        for (let item of value)
            yield* flattenTransformYieldSync(item);
        return;
    }
    throw intrinsics.makeErrorWithCode(112, "value", ["Uint8Array", "string", "ArrayBuffer", "ArrayBufferView", "Iterable", "AsyncIterable"], value);
}
function* processTransformResultSync(result) {
    if (result === null)
        return;
    if (isUint8Array(result)) {
        yield [result];
        return;
    }
    if (typeof result === "string") {
        yield [toUint8Array(result)];
        return;
    }
    if (isAnyArrayBuffer(result)) {
        yield [new intrinsics.Uint8Array(result)];
        return;
    }
    if (intrinsics.ArrayBuffer.isView(result)) {
        yield [arrayBufferViewToUint8Array(result)];
        return;
    }
    if (isUint8ArrayBatch(result)) {
        if (result.length > 0)
            yield result;
        return;
    }
    if (isSyncIterable(result)) {
        let batch = [];
        for (let item of result)
            for (let chunk of flattenTransformYieldSync(item))
                batch.push(chunk);
        if (batch.length > 0)
            yield batch;
        return;
    }
    throw intrinsics.makeErrorWithCode(112, "result", ["null", "Uint8Array", "string", "ArrayBuffer", "ArrayBufferView", "Array", "Iterable"], result);
}
function appendTransformResultSync(target, result) {
    for (let batch of processTransformResultSync(result))
        target.push(batch);
}
async function* processTransformResultAsync(result) {
    if (isPromise(result)) {
        let resolved = await result;
        yield* processTransformResultAsync(resolved);
        return;
    }
    if (result === null)
        return;
    if (isUint8Array(result)) {
        yield [result];
        return;
    }
    if (typeof result === "string") {
        yield [toUint8Array(result)];
        return;
    }
    if (isAnyArrayBuffer(result)) {
        yield [new intrinsics.Uint8Array(result)];
        return;
    }
    if (intrinsics.ArrayBuffer.isView(result)) {
        yield [arrayBufferViewToUint8Array(result)];
        return;
    }
    if (isUint8ArrayBatch(result)) {
        if (result.length > 0)
            yield result;
        return;
    }
    if (isAsyncIterable(result)) {
        let batch = [];
        for await (let item of result) {
            if (isUint8Array(item)) {
                batch.push(item);
                continue;
            }
            for await (let chunk of flattenTransformYieldAsync(item))
                batch.push(chunk);
        }
        if (batch.length > 0)
            yield batch;
        return;
    }
    if (isSyncIterable(result)) {
        let batch = [];
        for (let item of result) {
            if (isUint8Array(item)) {
                batch.push(item);
                continue;
            }
            for (let chunk of flattenTransformYieldSync(item))
                batch.push(chunk);
        }
        if (batch.length > 0)
            yield batch;
        return;
    }
    throw intrinsics.makeErrorWithCode(112, "result", ["null", "Uint8Array", "string", "ArrayBuffer", "ArrayBufferView", "Array", "Iterable", "AsyncIterable", "Promise"], result);
}
async function appendTransformResultAsync(target, result) {
    for await (let batch of processTransformResultAsync(result))
        target.push(batch);
}
function* applyFusedStatelessSyncTransforms(source, run) {
    for (let chunks of source) {
        let current = chunks;
        for (let i = 0; i < run.length; i++) {
            let result = run[i](current);
            if (result === null) {
                current = null;
                break;
            }
            current = result;
        }
        if (current === null)
            continue;
        if (isUint8ArrayBatch(current)) {
            if (current.length > 0)
                yield current;
        }
        else if (isUint8Array(current))
            yield [current];
        else if (typeof current === "string")
            yield [toUint8Array(current)];
        else if (isAnyArrayBuffer(current))
            yield [new intrinsics.Uint8Array(current)];
        else if (intrinsics.ArrayBuffer.isView(current))
            yield [arrayBufferViewToUint8Array(current)];
        else
            yield* processTransformResultSync(current);
    }
    let pending = [];
    for (let i = 0; i < run.length; i++) {
        let next = [];
        for (let j = 0; j < pending.length; j++)
            appendTransformResultSync(next, run[i](pending[j]));
        appendTransformResultSync(next, run[i](null)), pending = next;
    }
    for (let i = 0; i < pending.length; i++)
        yield pending[i];
}
function* withFlushSync(source) {
    yield* source, yield null;
}
function* applyStatefulSyncTransform(source, transform) {
    let output = transform(withFlushSync(source));
    for (let item of output) {
        let batch = [];
        for (let chunk of flattenTransformYieldSync(item))
            batch.push(chunk);
        if (batch.length > 0)
            yield batch;
    }
}
function* createSyncPipeline(source, transforms) {
    let current = source, statelessRun = [];
    for (let i = 0; i < transforms.length; i++) {
        let transform = transforms[i];
        if (isTransformObject(transform)) {
            if (statelessRun.length > 0)
                current = applyFusedStatelessSyncTransforms(current, statelessRun), statelessRun = [];
            current = applyStatefulSyncTransform(current, transform.transform);
        }
        else
            statelessRun.push(transform);
    }
    if (statelessRun.length > 0)
        current = applyFusedStatelessSyncTransforms(current, statelessRun);
    yield* current;
}
async function* applyFusedStatelessAsyncTransforms(source, run, signal) {
    for await (let chunks of source) {
        let current = chunks;
        for (let i = 0; i < run.length; i++) {
            let result = run[i](current, { __proto__: null, signal });
            if (result === null) {
                current = null;
                break;
            }
            if (isPromise(result)) {
                let resolved = await result;
                if (resolved === null) {
                    current = null;
                    break;
                }
                current = resolved;
            }
            else
                current = result;
        }
        if (current === null)
            continue;
        if (isUint8ArrayBatch(current)) {
            if (current.length > 0)
                yield current;
        }
        else if (isUint8Array(current))
            yield [current];
        else if (typeof current === "string")
            yield [toUint8Array(current)];
        else if (isAnyArrayBuffer(current))
            yield [new intrinsics.Uint8Array(current)];
        else if (intrinsics.ArrayBuffer.isView(current))
            yield [arrayBufferViewToUint8Array(current)];
        else
            yield* processTransformResultAsync(current);
    }
    let pending = [];
    for (let i = 0; i < run.length; i++) {
        let next = [];
        for (let j = 0; j < pending.length; j++)
            await appendTransformResultAsync(next, run[i](pending[j], { __proto__: null, signal }));
        await appendTransformResultAsync(next, run[i](null, { __proto__: null, signal })), pending = next;
    }
    for (let i = 0; i < pending.length; i++)
        yield pending[i];
}
async function* withFlushAsync(source) {
    yield* source, yield null;
}
async function* applyStatefulAsyncTransform(source, transform, options) {
    let output = transform(withFlushAsync(source), options);
    for await (let item of output) {
        if (isUint8ArrayBatch(item)) {
            if (item.length > 0)
                yield item;
            continue;
        }
        if (isUint8Array(item)) {
            yield [item];
            continue;
        }
        let batch = [];
        for await (let chunk of flattenTransformYieldAsync(item))
            batch.push(chunk);
        if (batch.length > 0)
            yield batch;
    }
}
async function* applyValidatedStatefulAsyncTransform(source, transform, options) {
    let output = transform(source, options);
    for await (let batch of output)
        if (batch.length > 0)
            yield batch;
    options.signal?.throwIfAborted();
}
async function* createAsyncPipeline(source, transforms, signal) {
    signal?.throwIfAborted();
    let normalized = source;
    if (transforms.length === 0) {
        for await (let batch of normalized)
            signal?.throwIfAborted(), yield batch;
        return;
    }
    let controller = new AbortController, abortHandler;
    if (signal)
        abortHandler = () => {
            controller.abort(signal.reason ?? intrinsics.makeAbortError());
        }, signal.addEventListener("abort", abortHandler, {
            __proto__: null,
            once: !0
        });
    let current = normalized, transformSignal = controller.signal, statelessRun = [];
    for (let i = 0; i < transforms.length; i++) {
        let transform = transforms[i];
        if (isTransformObject(transform)) {
            if (statelessRun.length > 0)
                current = applyFusedStatelessAsyncTransforms(current, statelessRun, transformSignal), statelessRun = [];
            let opts = { __proto__: null, signal: transformSignal };
            if (transform[kValidatedTransform])
                current = applyValidatedStatefulAsyncTransform(current, transform.transform, opts);
            else
                current = applyStatefulAsyncTransform(current, transform.transform, opts);
        }
        else
            statelessRun.push(transform);
    }
    if (statelessRun.length > 0)
        current = applyFusedStatelessAsyncTransforms(current, statelessRun, transformSignal);
    let completed = !1;
    try {
        for await (let batch of current)
            controller.signal.throwIfAborted(), yield batch;
        completed = !0;
    }
    catch (error) {
        if (!controller.signal.aborted)
            controller.abort(wrapError(error));
        throw error;
    }
    finally {
        if (!completed && !controller.signal.aborted)
            controller.abort(intrinsics.makeAbortError());
        if (signal && abortHandler)
            signal.removeEventListener("abort", abortHandler);
    }
}
function pullSync(source, ...transforms) {
    for (let i = 0; i < transforms.length; i++)
        if (!isTransform(transforms[i]))
            throw intrinsics.makeErrorWithCode(112, `transforms[${i}]`, ["Function", "Object with transform()"], transforms[i]);
    return {
        __proto__: null,
        *[Symbol.iterator]() {
            yield* createSyncPipeline(fromSync(source), transforms);
        }
    };
}
function pull(source, ...args) {
    let { transforms, options } = parsePullArgs(args), signal = options?.signal;
    if (signal !== intrinsics.undefined) {
        if (validateAbortSignal(signal, "options.signal"), signal.aborted)
            return {
                __proto__: null,
                async *[Symbol.asyncIterator]() {
                    throw signal.reason;
                }
            };
    }
    return {
        __proto__: null,
        async *[Symbol.asyncIterator]() {
            yield* createAsyncPipeline(from(source), transforms, signal);
        }
    };
}
function pipeToSync(source, ...args) {
    let { transforms, writer, options } = parsePipeToArgs(args, "writeSync");
    if (isTransformObject(writer))
        transforms.push(writer);
    let normalized = fromSync(source), pipeline = transforms.length > 0 ? createSyncPipeline(normalized, transforms) : normalized, totalBytes = 0, hasWritevSync = typeof writer.writevSync === "function", hasEndSync = typeof writer.endSync === "function";
    try {
        for (let batch of pipeline) {
            let batchLength;
            if (hasWritevSync && (batchLength = batch.length) > 1) {
                writer.writevSync(batch);
                for (let i = 0; i < batchLength; i++)
                    totalBytes += batch[i].byteLength;
            }
            else
                for (let i = 0; i < (batchLength ??= batch.length); i++) {
                    let chunk = batch[i];
                    writer.writeSync(chunk), totalBytes += chunk.byteLength;
                }
        }
        if (!options?.preventClose) {
            if (!hasEndSync || writer.endSync() < 0)
                writer.end?.();
        }
    }
    catch (error) {
        if (!options?.preventFail)
            writer.fail?.(wrapError(error));
        throw error;
    }
    return totalBytes;
}
async function pipeTo(source, ...args) {
    let { transforms, writer, options } = parsePipeToArgs(args, "write");
    if (options?.signal !== intrinsics.undefined)
        validateAbortSignal(options.signal, "options.signal");
    if (isTransformObject(writer))
        transforms.push(writer);
    let signal = options?.signal;
    signal?.throwIfAborted();
    let hasWriteSync = typeof writer.writeSync === "function", useSyncIterableFastPath = hasWriteSync && canUseSyncIterablePipeToFastPath(source, transforms, signal), normalized = useSyncIterableFastPath ? intrinsics.undefined : from(source), totalBytes = 0, hasWritev = typeof writer.writev === "function", hasWritevSync = typeof writer.writevSync === "function", hasEndSync = typeof writer.endSync === "function", syncFalseCanBeAccepted = writer[kSyncWriteAcceptedOnFalse] === !0;
    function syncFalseWasAccepted() {
        return syncFalseCanBeAccepted && writer.desiredSize === 0;
    }
    function waitForSyncBackpressure() {
        return intrinsics.uncurry(writer[drainableProtocol], "call")(writer);
    }
    async function writeBatchAfterAcceptedBackpressure(batch, startIndex) {
        await waitForSyncBackpressure(), await writeBatchAsyncFallback(batch, startIndex);
    }
    async function writeBatchAsyncFallback(batch, startIndex) {
        for (let i = startIndex; i < batch.length; i++) {
            let chunk = batch[i];
            if (hasWriteSync && writer.writeSync(chunk))
                ;
            else if (syncFalseWasAccepted()) {
                totalBytes += chunk.byteLength, await waitForSyncBackpressure();
                continue;
            }
            else {
                let result = writer.write(chunk, signal ? { __proto__: null, signal } : intrinsics.undefined);
                if (result !== intrinsics.undefined)
                    await result;
            }
            totalBytes += chunk.byteLength;
        }
    }
    function writeBatch(batch) {
        let batchLength;
        if (hasWritev && (batchLength = batch.length) > 1) {
            if (!hasWritevSync || !writer.writevSync(batch)) {
                if (hasWritevSync && syncFalseWasAccepted()) {
                    for (let i = 0; i < batchLength; i++)
                        totalBytes += batch[i].byteLength;
                    return waitForSyncBackpressure();
                }
                let opts = signal ? { __proto__: null, signal } : intrinsics.undefined;
                return writer.writev(batch, opts).then(() => {
                    for (let i = 0; i < batch.length; i++)
                        totalBytes += batch[i].byteLength;
                });
            }
            for (let i = 0; i < batch.length; i++)
                totalBytes += batch[i].byteLength;
            return;
        }
        for (let i = 0; i < batch.length; i++) {
            let chunk = batch[i];
            if (!hasWriteSync || !writer.writeSync(chunk)) {
                if (hasWriteSync && syncFalseWasAccepted())
                    return totalBytes += chunk.byteLength, writeBatchAfterAcceptedBackpressure(batch, i + 1);
                return writeBatchAsyncFallback(batch, i);
            }
            totalBytes += chunk.byteLength;
        }
    }
    try {
        if (useSyncIterableFastPath)
            for (let value of source) {
                if (isUint8ArrayBatch(value)) {
                    if (value.length > 0) {
                        let p = writeBatch(value);
                        if (p)
                            await p;
                    }
                    continue;
                }
                if (isUint8Array(value)) {
                    let p = writeBatch([value]);
                    if (p)
                        await p;
                    continue;
                }
                let batch = await intrinsics.Array.fromAsync(normalizeAsyncValue(value));
                if (batch.length > 0) {
                    let p = writeBatch(batch);
                    if (p)
                        await p;
                }
            }
        else if (transforms.length === 0)
            if (signal)
                for await (let batch of normalized) {
                    signal.throwIfAborted();
                    let p = writeBatch(batch);
                    if (p)
                        await p;
                }
            else
                for await (let batch of normalized) {
                    let p = writeBatch(batch);
                    if (p)
                        await p;
                }
        else {
            let pipeline = createAsyncPipeline(normalized, transforms, signal);
            if (signal)
                for await (let batch of pipeline) {
                    signal.throwIfAborted();
                    let p = writeBatch(batch);
                    if (p)
                        await p;
                }
            else
                for await (let batch of pipeline) {
                    let p = writeBatch(batch);
                    if (p)
                        await p;
                }
        }
        if (!options?.preventClose) {
            if (!hasEndSync || writer.endSync() < 0)
                await writer.end?.(signal ? { __proto__: null, signal } : intrinsics.undefined);
        }
    }
    catch (error) {
        if (!options?.preventFail)
            writer.fail?.(wrapError(error));
        throw error;
    }
    return totalBytes;
}
$ = {
    pipeTo,
    pipeToSync,
    pull,
    pullSync
};
return $;
})

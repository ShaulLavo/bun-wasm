// Generated from Bun a7733435cf40429e3b35c36072769df2052b80f1, src/js/internal/streams/iter/classic.ts.
(function (intrinsics) {
"use strict";
var $, { aggregateTwoErrors } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 21) || intrinsics.createInternalModuleById(21), { validateInteger, validateObject } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 127) || intrinsics.createInternalModuleById(127), eos = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 88) || intrinsics.createInternalModuleById(88), { addAbortSignal: addAbortSignalNoValidate } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 82) || intrinsics.createInternalModuleById(82), { toAsyncStreamable: kToAsyncStreamable, kValidatedSource, kSyncWriteAccepted, drainableProtocol } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 101) || intrinsics.createInternalModuleById(101), { validateBackpressure, toUint8Array } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 102) || intrinsics.createInternalModuleById(102), destroyImpl = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 84) || intrinsics.createInternalModuleById(84), { asyncIterator: SymbolAsyncIterator, iterator: SymbolIterator, asyncDispose: SymbolAsyncDispose, dispose: SymbolDispose } = Symbol, PromiseWithResolvers = intrinsics.Promise.withResolvers.bind(intrinsics.Promise), Readable, Writable;
function lazyReadable() {
    if (Readable === intrinsics.undefined)
        Readable = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 109) || intrinsics.createInternalModuleById(109);
    return Readable;
}
function lazyWritable() {
    if (Writable === intrinsics.undefined)
        Writable = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 113) || intrinsics.createInternalModuleById(113);
    return Writable;
}
var fromReadableCache = new WeakMap, MAX_DRAIN_BATCH = 128, { normalizeAsyncValue } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 95) || intrinsics.createInternalModuleById(95), { isUint8Array } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 208) || intrinsics.createInternalModuleById(208);
async function normalizeBatch(raw) {
    let batch = [];
    for (let i = 0; i < raw.length; i++) {
        let value = raw[i];
        if (isUint8Array(value))
            batch.push(value);
        else
            for await (let normalized of normalizeAsyncValue(value))
                batch.push(normalized);
    }
    return batch.length > 0 ? batch : null;
}
var nop = () => { };
async function* createBatchedAsyncIterator(stream, normalize) {
    let callback = nop;
    function next(resolve) {
        if (this === stream)
            callback(), callback = nop;
        else
            callback = resolve;
    }
    stream.on("readable", next);
    let error, cleanup = eos(stream, { writable: !1 }, (err) => {
        error = err ? aggregateTwoErrors(error, err) : null, callback(), callback = nop;
    });
    try {
        while (!0) {
            let chunk = stream.destroyed ? null : stream.read();
            if (chunk !== null) {
                let batch = [chunk];
                while (batch.length < MAX_DRAIN_BATCH && stream._readableState?.length > 0) {
                    let c = stream.read();
                    if (c === null)
                        break;
                    batch.push(c);
                }
                if (normalize !== null) {
                    let result = await normalize(batch);
                    if (result !== null)
                        yield result;
                }
                else
                    yield batch;
            }
            else if (error)
                throw error;
            else if (error === null)
                return;
            else
                await new intrinsics.Promise(next);
        }
    }
    catch (err) {
        throw error = aggregateTwoErrors(error, err), error;
    }
    finally {
        if (error === intrinsics.undefined || stream._readableState?.autoDestroy)
            destroyImpl.destroyer(stream, null);
        else
            stream.off("readable", next), cleanup();
    }
}
function fromReadable(readable) {
    if (readable == null || typeof readable !== "object")
        throw intrinsics.makeErrorWithCode(112, "readable", "Readable", readable);
    let cached = fromReadableCache.get(readable);
    if (cached !== intrinsics.undefined)
        return cached;
    if (typeof readable[kToAsyncStreamable] === "function") {
        let result = readable[kToAsyncStreamable]();
        return fromReadableCache.set(readable, result), result;
    }
    if (typeof readable.read !== "function" || typeof readable.on !== "function")
        throw intrinsics.makeErrorWithCode(112, "readable", "Readable", readable);
    let state = readable._readableState, normalize = state && (state.objectMode || state.encoding) ? normalizeBatch : null, iter = createBatchedAsyncIterator(readable, normalize);
    return iter[kValidatedSource] = !0, iter.stream = readable, fromReadableCache.set(readable, iter), iter;
}
var kNullPrototype = { __proto__: null };
function toReadable(source, options = kNullPrototype) {
    if (typeof source?.[SymbolAsyncIterator] !== "function")
        throw intrinsics.makeErrorWithCode(112, "source", "AsyncIterable", source);
    validateObject(options, "options");
    let { highWaterMark = 65536, signal } = options;
    validateInteger(highWaterMark, "options.highWaterMark", 0);
    let ReadableCtor = lazyReadable(), iterator = source[SymbolAsyncIterator](), backpressure, pumping = !1, done = !1, readable = new ReadableCtor({
        __proto__: null,
        highWaterMark,
        read() {
            if (backpressure) {
                let { resolve } = backpressure;
                backpressure = null, resolve();
            }
            else if (!pumping && !done)
                pumping = !0, pump();
        },
        destroy(err, cb) {
            if (done = !0, backpressure)
                backpressure.resolve(), backpressure = null;
            if (typeof iterator.return === "function")
                iterator.return().then(() => cb(err), (e) => cb(e || err));
            else
                cb(err);
        }
    });
    if (signal)
        addAbortSignalNoValidate(signal, readable);
    async function pump() {
        try {
            while (!done) {
                let { value: batch, done: iterDone } = await iterator.next();
                if (iterDone) {
                    done = !0, readable.push(null);
                    return;
                }
                for (let i = 0; i < batch.length; i++)
                    if (!readable.push(batch[i])) {
                        if (backpressure = PromiseWithResolvers(), await backpressure.promise, done)
                            return;
                    }
            }
        }
        catch (err) {
            done = !0, readable.destroy(err);
        }
    }
    return readable;
}
function toReadableSync(source, options = kNullPrototype) {
    if (typeof source?.[SymbolIterator] !== "function")
        throw intrinsics.makeErrorWithCode(112, "source", "Iterable", source);
    validateObject(options, "options");
    let { highWaterMark = 65536 } = options;
    validateInteger(highWaterMark, "options.highWaterMark", 0);
    let ReadableCtor = lazyReadable(), iterator = source[SymbolIterator](), hasBatch = !1, batch, batchIndex = 0;
    return new ReadableCtor({
        __proto__: null,
        highWaterMark,
        read() {
            for (;;) {
                if (hasBatch) {
                    while (batchIndex < batch.length)
                        if (!this.push(batch[batchIndex++]))
                            return;
                    batch = intrinsics.undefined, hasBatch = !1, batchIndex = 0;
                }
                let result = iterator.next(), { done } = result;
                if (done) {
                    this.push(null);
                    return;
                }
                batch = result.value, hasBatch = !0;
            }
        },
        destroy(err, cb) {
            if (batch = intrinsics.undefined, hasBatch = !1, typeof iterator.return === "function")
                iterator.return();
            cb(err);
        }
    });
}
var fromWritableCache = new WeakMap;
function fromWritable(writable, options = kNullPrototype) {
    if (writable == null || typeof writable.write !== "function" || typeof writable.on !== "function")
        throw intrinsics.makeErrorWithCode(112, "writable", "Writable", writable);
    validateObject(options, "options");
    let { backpressure = "strict" } = options;
    if (validateBackpressure(backpressure), writable.writableObjectMode)
        throw intrinsics.makeErrorWithCode(129, "Cannot create a stream/iter Writer from an object-mode Writable");
    if (backpressure === "drop-oldest")
        throw intrinsics.makeErrorWithCode(113, "options.backpressure", backpressure, "drop-oldest is not supported for classic stream.Writable");
    let cachedByBackpressure = fromWritableCache.get(writable);
    if (cachedByBackpressure !== intrinsics.undefined) {
        let cached = cachedByBackpressure.get(backpressure);
        if (cached !== intrinsics.undefined)
            return cached;
    }
    else
        cachedByBackpressure = new Map, fromWritableCache.set(writable, cachedByBackpressure);
    let hwm = writable.writableHighWaterMark ?? 16384, totalBytes = 0, waiters = [], listenersInstalled = !1, onDrain, onError;
    function installListeners() {
        if (listenersInstalled)
            return;
        listenersInstalled = !0, onDrain = () => {
            let pending = waiters;
            waiters = [];
            for (let i = 0; i < pending.length; i++)
                pending[i].resolve();
        }, onError = (err) => {
            let pending = waiters;
            waiters = [];
            for (let i = 0; i < pending.length; i++)
                pending[i].reject(err);
        }, writable.on("drain", onDrain), writable.on("error", onError);
    }
    function cleanup(err) {
        let pending = waiters;
        waiters = [];
        for (let i = 0; i < pending.length; i++)
            pending[i].reject(err ?? intrinsics.makeAbortError());
        if (!listenersInstalled)
            return;
        listenersInstalled = !1, writable.removeListener("drain", onDrain), writable.removeListener("error", onError);
    }
    function waitForDrain() {
        let { promise, resolve, reject } = PromiseWithResolvers();
        return waiters.push({ __proto__: null, resolve, reject }), installListeners(), promise;
    }
    function isWritable() {
        return !(writable.destroyed ?? !1) && !(writable.writableFinished ?? !1) && !(writable.writableEnded ?? !1);
    }
    function isFull() {
        return (writable.writableLength ?? 0) >= hwm;
    }
    function writeChunks(chunks) {
        let ok = !0;
        for (let i = 0; i < chunks.length; i++) {
            let bytes = toUint8Array(chunks[i]);
            totalBytes += bytes.byteLength, ok = writable.write(bytes);
        }
        return ok;
    }
    let writer = {
        __proto__: null,
        get desiredSize() {
            if (!isWritable())
                return null;
            return Math.max(0, hwm - (writable.writableLength ?? 0));
        },
        writeSync(_chunk) {
            return !1;
        },
        writevSync(_chunks) {
            return !1;
        },
        write(chunk) {
            if (!isWritable())
                return intrinsics.Promise.reject(intrinsics.makeErrorWithCode(222));
            let bytes;
            try {
                bytes = toUint8Array(chunk);
            }
            catch (err) {
                return intrinsics.Promise.reject(err);
            }
            if (backpressure === "strict" && isFull())
                return intrinsics.Promise.reject(intrinsics.makeErrorWithCode(131, "Backpressure violation: buffer is full. Await each write() call to respect backpressure."));
            if (backpressure === "drop-newest" && isFull())
                return totalBytes += bytes.byteLength, intrinsics.Promise.resolve();
            if (totalBytes += bytes.byteLength, writable.write(bytes))
                return intrinsics.Promise.resolve();
            if (backpressure === "block")
                return waitForDrain();
            return intrinsics.Promise.resolve();
        },
        writev(chunks) {
            if (!intrinsics.Array.isArray(chunks))
                throw intrinsics.makeErrorWithCode(112, "chunks", "Array", chunks);
            if (!isWritable())
                return intrinsics.Promise.reject(intrinsics.makeErrorWithCode(222));
            if (backpressure === "strict" && isFull())
                return intrinsics.Promise.reject(intrinsics.makeErrorWithCode(131, "Backpressure violation: buffer is full. Await each write() call to respect backpressure."));
            if (backpressure === "drop-newest" && isFull()) {
                for (let i = 0; i < chunks.length; i++)
                    totalBytes += toUint8Array(chunks[i]).byteLength;
                return intrinsics.Promise.resolve();
            }
            let ok = !0;
            if (typeof writable.cork === "function" && typeof writable.uncork === "function") {
                writable.cork();
                try {
                    ok = writeChunks(chunks);
                }
                finally {
                    writable.uncork();
                }
            }
            else
                ok = writeChunks(chunks);
            if (ok)
                return intrinsics.Promise.resolve();
            if (backpressure === "block")
                return waitForDrain();
            return intrinsics.Promise.resolve();
        },
        endSync() {
            return -1;
        },
        end() {
            if ((writable.writableFinished ?? !1) || (writable.destroyed ?? !1))
                return cleanup(), intrinsics.Promise.resolve(totalBytes);
            let { promise, resolve, reject } = PromiseWithResolvers();
            if (!(writable.writableEnded ?? !1))
                writable.end();
            return eos(writable, { writable: !0, readable: !1 }, (err) => {
                if (cleanup(err), err)
                    reject(err);
                else
                    resolve(totalBytes);
            }), promise;
        },
        fail(reason) {
            if (cleanup(reason), typeof writable.destroy === "function")
                writable.destroy(reason);
        },
        [SymbolAsyncDispose]() {
            if (isWritable()) {
                if (cleanup(), typeof writable.destroy === "function")
                    writable.destroy();
            }
            return intrinsics.Promise.resolve();
        },
        [SymbolDispose]() {
            if (isWritable()) {
                if (cleanup(), typeof writable.destroy === "function")
                    writable.destroy();
            }
        }
    };
    return writer[drainableProtocol] = function () {
        if (!isWritable())
            return null;
        if ((writable.writableLength ?? 0) < hwm)
            return intrinsics.Promise.resolve(!0);
        let { promise, resolve } = PromiseWithResolvers();
        return waiters.push({
            __proto__: null,
            resolve() {
                resolve(!0);
            },
            reject() {
                resolve(!1);
            }
        }), installListeners(), promise;
    }, cachedByBackpressure.set(backpressure, writer), writer;
}
function toWritable(writer) {
    if (typeof writer?.write !== "function")
        throw intrinsics.makeErrorWithCode(112, "writer", "Writer", writer);
    let WritableCtor = lazyWritable(), hasWriteSync = typeof writer.writeSync === "function", hasWritev = typeof writer.writev === "function", hasWritevSync = hasWritev && typeof writer.writevSync === "function", hasEnd = typeof writer.end === "function", hasEndSync = hasEnd && typeof writer.endSync === "function", hasFail = typeof writer.fail === "function", hasSyncWriteAccepted = typeof writer[kSyncWriteAccepted] === "function";
    function syncWriteAccepted() {
        return hasSyncWriteAccepted && writer[kSyncWriteAccepted]();
    }
    function finishAfterSyncBackpressure(cb) {
        let ondrain;
        try {
            if (typeof writer[drainableProtocol] === "function")
                ondrain = writer[drainableProtocol]();
        }
        catch (err) {
            cb(err);
            return;
        }
        if (ondrain !== null && ondrain !== intrinsics.undefined) {
            ondrain.then((drained) => {
                if (drained === !1) {
                    cb(intrinsics.makeErrorWithCode(130, "Stream closed by consumer"));
                    return;
                }
                cb();
            }, cb);
            return;
        }
        queueMicrotask(cb);
    }
    function _write(chunk, encoding, cb) {
        let bytes = typeof chunk === "string" ? intrinsics.Buffer.from(chunk, encoding) : chunk;
        if (hasWriteSync)
            try {
                if (writer.writeSync(bytes)) {
                    queueMicrotask(cb);
                    return;
                }
                if (syncWriteAccepted()) {
                    finishAfterSyncBackpressure(cb);
                    return;
                }
            }
            catch { }
        try {
            writer.write(bytes).then(() => cb(), cb);
        }
        catch (err) {
            cb(err);
        }
    }
    function _writev(entries, cb) {
        let chunks = [];
        for (let i = 0; i < entries.length; i++) {
            let { chunk, encoding } = entries[i];
            chunks[i] = typeof chunk === "string" ? intrinsics.Buffer.from(chunk, encoding) : chunk;
        }
        if (hasWritevSync)
            try {
                if (writer.writevSync(chunks)) {
                    queueMicrotask(cb);
                    return;
                }
                if (syncWriteAccepted()) {
                    finishAfterSyncBackpressure(cb);
                    return;
                }
            }
            catch { }
        try {
            writer.writev(chunks).then(() => cb(), cb);
        }
        catch (err) {
            cb(err);
        }
    }
    function _final(cb) {
        if (!hasEnd) {
            queueMicrotask(cb);
            return;
        }
        if (hasEndSync)
            try {
                if (writer.endSync() >= 0) {
                    queueMicrotask(cb);
                    return;
                }
            }
            catch { }
        try {
            writer.end().then(() => cb(), cb);
        }
        catch (err) {
            cb(err);
        }
    }
    function _destroy(err, cb) {
        if (err && hasFail)
            writer.fail(err);
        cb();
    }
    let writableOptions = {
        __proto__: null,
        highWaterMark: Number.MAX_SAFE_INTEGER,
        write: _write,
        final: _final,
        destroy: _destroy
    };
    if (hasWritev)
        writableOptions.writev = _writev;
    return new WritableCtor(writableOptions);
}
$ = {
    createBatchedAsyncIterator,
    normalizeBatch,
    fromReadable,
    fromWritable,
    toReadable,
    toReadableSync,
    toWritable
};
return $;
})

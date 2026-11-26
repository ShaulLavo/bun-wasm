// Generated from Bun a7733435cf40429e3b35c36072769df2052b80f1, src/js/internal/streams/iter/broadcast.ts.
(function (intrinsics) {
"use strict";
var $, { validateAbortSignal, validateInteger, validateObject } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 127) || intrinsics.createInternalModuleById(127), { broadcastProtocol, drainableProtocol } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 101) || intrinsics.createInternalModuleById(101), { isAsyncIterable, isSyncIterable } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 95) || intrinsics.createInternalModuleById(95), { pull: pullWithTransforms } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 96) || intrinsics.createInternalModuleById(96), { kMultiConsumerDefaultHWM, kResolvedPromise, clampHWM, convertChunks, getMinCursor, hasProtocol, onSignalAbort, parsePullArgs, wrapError, toUint8Array, validateBackpressure } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 102) || intrinsics.createInternalModuleById(102), { RingBuffer } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 98) || intrinsics.createInternalModuleById(98), PromiseWithResolvers = intrinsics.Promise.withResolvers.bind(intrinsics.Promise), { asyncDispose: SymbolAsyncDispose, asyncIterator: SymbolAsyncIterator, dispose: SymbolDispose } = Symbol, kCancelWriter = Symbol("kCancelWriter"), kWrite = Symbol("kWrite"), kEnd = Symbol("kEnd"), kAbort = Symbol("kAbort"), kGetDesiredSize = Symbol("kGetDesiredSize"), kCanWrite = Symbol("kCanWrite"), kOnBufferDrained = Symbol("kOnBufferDrained");
class BroadcastImpl {
    #buffer = new RingBuffer;
    #bufferStart = 0;
    #consumers = new Set;
    #waiters = [];
    #ended = !1;
    #error = null;
    #cancelled = !1;
    #options;
    #writer = null;
    #cachedMinCursor = 0;
    #cachedMinCursorConsumers = 0;
    constructor(options) {
        this.#options = options, this[kOnBufferDrained] = null;
    }
    setWriter(writer) {
        this.#writer = writer;
    }
    get backpressurePolicy() {
        return this.#options.backpressure;
    }
    get highWaterMark() {
        return this.#options.highWaterMark;
    }
    get consumerCount() {
        return this.#consumers.size;
    }
    get bufferSize() {
        return this.#buffer.length;
    }
    push(...args) {
        let { transforms, options } = parsePullArgs(args), rawConsumer = this.#createRawConsumer();
        if (transforms.length > 0) {
            let pullArgs = [...transforms];
            if (options?.signal)
                pullArgs.push({ __proto__: null, signal: options.signal });
            return pullWithTransforms(rawConsumer, ...pullArgs);
        }
        return rawConsumer;
    }
    #createRawConsumer() {
        let state = {
            __proto__: null,
            cursor: this.#bufferStart,
            resolve: null,
            reject: null,
            detached: !1
        };
        if (this.#consumers.add(state), this.#consumers.size === 1)
            this.#cachedMinCursor = state.cursor, this.#cachedMinCursorConsumers = 1;
        else if (state.cursor === this.#cachedMinCursor)
            this.#cachedMinCursorConsumers++;
        else
            this.#recomputeMinCursor();
        let self = this, kDone = intrinsics.Promise.resolve({ __proto__: null, done: !0, value: intrinsics.undefined });
        function detach() {
            if (state.detached = !0, state.resolve = null, state.reject = null, self.#deleteConsumer(state))
                self.#tryTrimBuffer();
        }
        return {
            __proto__: null,
            [SymbolAsyncIterator]() {
                return {
                    __proto__: null,
                    next() {
                        if (state.detached) {
                            if (self.#error)
                                return intrinsics.Promise.reject(self.#error);
                            return kDone;
                        }
                        let bufferIndex = state.cursor - self.#bufferStart;
                        if (bufferIndex < self.#buffer.length) {
                            let chunk = self.#buffer.get(bufferIndex), cursor = state.cursor;
                            if (state.cursor++, cursor === self.#cachedMinCursor && --self.#cachedMinCursorConsumers === 0)
                                self.#tryTrimBuffer();
                            return intrinsics.Promise.resolve({ __proto__: null, done: !1, value: chunk });
                        }
                        if (self.#error)
                            return state.detached = !0, self.#deleteConsumer(state), intrinsics.Promise.reject(self.#error);
                        if (self.#ended || self.#cancelled)
                            return detach(), kDone;
                        let { promise, resolve, reject } = PromiseWithResolvers();
                        return state.resolve = resolve, state.reject = reject, self.#waiters.push(state), promise;
                    },
                    return() {
                        return detach(), kDone;
                    },
                    throw() {
                        return detach(), kDone;
                    }
                };
            }
        };
    }
    cancel(reason) {
        if (this.#cancelled)
            return;
        if (this.#cancelled = !0, this.#ended = !0, reason !== intrinsics.undefined)
            this.#error = reason;
        this.#writer?.[kCancelWriter]();
        for (let consumer of this.#consumers) {
            if (consumer.resolve) {
                if (reason !== intrinsics.undefined)
                    consumer.reject?.(reason);
                else
                    consumer.resolve({ __proto__: null, done: !0, value: intrinsics.undefined });
                consumer.resolve = null, consumer.reject = null;
            }
            consumer.detached = !0;
        }
        this.#consumers.clear(), this.#cachedMinCursorConsumers = 0;
    }
    [SymbolDispose]() {
        this.cancel();
    }
    [kWrite](chunk) {
        if (this.#ended || this.#cancelled)
            return !1;
        if (this.#buffer.length >= this.#options.highWaterMark)
            switch (this.#options.backpressure) {
                case "strict":
                case "block":
                    return !1;
                case "drop-oldest":
                    this.#buffer.shift(), this.#bufferStart++;
                    for (let consumer of this.#consumers)
                        if (consumer.cursor < this.#bufferStart)
                            this.#deleteConsumerFromMin(consumer), consumer.cursor = this.#bufferStart;
                    this.#recomputeMinCursor();
                    break;
                case "drop-newest":
                    return !0;
            }
        return this.#buffer.push(chunk), this.#notifyConsumers(), !0;
    }
    [kEnd]() {
        if (this.#ended)
            return;
        this.#ended = !0;
        for (let consumer of this.#consumers)
            if (consumer.resolve) {
                let bufferIndex = consumer.cursor - this.#bufferStart;
                if (bufferIndex < this.#buffer.length) {
                    let chunk = this.#buffer.get(bufferIndex), cursor = consumer.cursor;
                    if (consumer.cursor++, cursor === this.#cachedMinCursor && --this.#cachedMinCursorConsumers === 0)
                        this.#tryTrimBuffer();
                    consumer.resolve({ __proto__: null, done: !1, value: chunk });
                }
                else
                    consumer.resolve({ __proto__: null, done: !0, value: intrinsics.undefined });
                consumer.resolve = null, consumer.reject = null;
            }
    }
    [kAbort](reason) {
        if (this.#ended || this.#error)
            return;
        this.#error = reason, this.#ended = !0;
        for (let consumer of this.#consumers) {
            if (consumer.reject)
                consumer.reject(reason), consumer.resolve = null, consumer.reject = null;
            consumer.detached = !0;
        }
        this.#consumers.clear(), this.#cachedMinCursorConsumers = 0;
    }
    [kGetDesiredSize]() {
        if (this.#ended || this.#cancelled)
            return null;
        return Math.max(0, this.#options.highWaterMark - this.#buffer.length);
    }
    [kCanWrite]() {
        if (this.#ended || this.#cancelled)
            return !1;
        if ((this.#options.backpressure === "strict" || this.#options.backpressure === "block") && this.#buffer.length >= this.#options.highWaterMark)
            return !1;
        return !0;
    }
    #recomputeMinCursor() {
        let { minCursor, minCursorConsumers } = getMinCursor(this.#consumers, this.#bufferStart + this.#buffer.length);
        this.#cachedMinCursor = minCursor, this.#cachedMinCursorConsumers = minCursorConsumers;
    }
    #tryTrimBuffer() {
        if (this.#cachedMinCursorConsumers === 0)
            this.#recomputeMinCursor();
        let trimCount = this.#cachedMinCursor - this.#bufferStart;
        if (trimCount > 0) {
            if (this.#buffer.trimFront(trimCount), this.#bufferStart = this.#cachedMinCursor, this[kOnBufferDrained] && this.#buffer.length < this.#options.highWaterMark)
                this[kOnBufferDrained]();
        }
    }
    #notifyConsumers() {
        let waiters = this.#waiters;
        if (waiters.length === 0)
            return;
        this.#waiters = [];
        for (let i = 0; i < waiters.length; i++) {
            let consumer = waiters[i];
            if (consumer.resolve) {
                let bufferIndex = consumer.cursor - this.#bufferStart;
                if (bufferIndex < this.#buffer.length) {
                    let chunk = this.#buffer.get(bufferIndex), cursor = consumer.cursor;
                    if (consumer.cursor++, cursor === this.#cachedMinCursor && --this.#cachedMinCursorConsumers === 0)
                        this.#tryTrimBuffer();
                    let resolve = consumer.resolve;
                    consumer.resolve = null, consumer.reject = null, resolve({ __proto__: null, done: !1, value: chunk });
                }
                else
                    this.#waiters.push(consumer);
            }
        }
    }
    #deleteConsumerFromMin(consumer) {
        if (consumer.cursor === this.#cachedMinCursor)
            return this.#cachedMinCursorConsumers--, this.#cachedMinCursorConsumers === 0;
        return !1;
    }
    #deleteConsumer(consumer) {
        if (this.#consumers.delete(consumer))
            return this.#deleteConsumerFromMin(consumer);
        return !1;
    }
}
var getBroadcastPendingWrites;
class BroadcastWriter {
    #broadcast;
    #totalBytes = 0;
    #closed;
    #aborted = !1;
    #pendingWrites = new RingBuffer;
    #pendingDrains = [];
    static {
        getBroadcastPendingWrites = (obj) => obj.#pendingWrites;
    }
    constructor(broadcastImpl) {
        this.#broadcast = broadcastImpl, this.#broadcast[kOnBufferDrained] = () => {
            this.#resolvePendingWrites(), this.#resolvePendingDrains(!0);
        };
    }
    [drainableProtocol]() {
        let desired = this.desiredSize;
        if (desired === null)
            return null;
        if (desired > 0)
            return intrinsics.Promise.resolve(!0);
        let { promise, resolve, reject } = PromiseWithResolvers();
        return this.#pendingDrains.push({ __proto__: null, resolve, reject }), promise;
    }
    #isClosed() {
        return this.#closed !== intrinsics.undefined;
    }
    #isClosedOrAborted() {
        return this.#isClosed() || this.#aborted;
    }
    get desiredSize() {
        return this.#isClosedOrAborted() ? null : this.#broadcast[kGetDesiredSize]();
    }
    #canUseWriteFastPath(options) {
        return !options?.signal && !this.#isClosed() && !this.#aborted && this.#broadcast[kCanWrite]();
    }
    write(chunk, options) {
        if (this.#canUseWriteFastPath(options)) {
            let converted = toUint8Array(chunk);
            return this.#broadcast[kWrite]([converted]), this.#totalBytes += converted.byteLength, kResolvedPromise;
        }
        return this.#writevSlow([chunk], options);
    }
    writev(chunks, options) {
        if (!intrinsics.Array.isArray(chunks))
            throw intrinsics.makeErrorWithCode(112, "chunks", "Array", chunks);
        if (this.#canUseWriteFastPath(options)) {
            let converted = convertChunks(chunks);
            this.#broadcast[kWrite](converted);
            for (let i = 0; i < converted.length; i++)
                this.#totalBytes += converted[i].byteLength;
            return kResolvedPromise;
        }
        return this.#writevSlow(chunks, options);
    }
    async #writevSlow(chunks, options) {
        let signal = options?.signal;
        if (signal?.throwIfAborted(), this.#isClosedOrAborted())
            throw intrinsics.makeErrorWithCode(130, "Writer is closed");
        let converted = convertChunks(chunks);
        if (this.#broadcast[kWrite](converted)) {
            for (let i = 0; i < converted.length; i++)
                this.#totalBytes += converted[i].byteLength;
            return;
        }
        let policy = this.#broadcast.backpressurePolicy, hwm = this.#broadcast.highWaterMark;
        if (policy === "strict") {
            if (this.#pendingWrites.length >= hwm)
                throw intrinsics.makeErrorWithCode(130, "Backpressure violation: too many pending writes. Await each write() call to respect backpressure.");
            return this.#createPendingWrite(converted, signal);
        }
        return this.#createPendingWrite(converted, signal);
    }
    writeSync(chunk) {
        if (this.#isClosedOrAborted())
            return !1;
        if (!this.#broadcast[kCanWrite]())
            return !1;
        let converted = toUint8Array(chunk);
        if (this.#broadcast[kWrite]([converted]))
            return this.#totalBytes += converted.byteLength, !0;
        return !1;
    }
    writevSync(chunks) {
        if (!intrinsics.Array.isArray(chunks))
            throw intrinsics.makeErrorWithCode(112, "chunks", "Array", chunks);
        if (this.#isClosedOrAborted())
            return !1;
        if (!this.#broadcast[kCanWrite]())
            return !1;
        let converted = convertChunks(chunks);
        if (this.#broadcast[kWrite](converted)) {
            for (let i = 0; i < converted.length; i++)
                this.#totalBytes += converted[i].byteLength;
            return !0;
        }
        return !1;
    }
    end(_options) {
        if (this.#isClosed())
            return this.#closed;
        return this.#closed = intrinsics.Promise.resolve(this.#totalBytes), this.#broadcast[kEnd](), this.#resolvePendingDrains(!1), this.#closed;
    }
    endSync() {
        if (this.#closed)
            return this.#totalBytes;
        return this.#closed = intrinsics.Promise.resolve(this.#totalBytes), this.#broadcast[kEnd](), this.#resolvePendingDrains(!1), this.#totalBytes;
    }
    fail(reason) {
        if (this.#isClosedOrAborted())
            return;
        this.#aborted = !0, this.#closed = intrinsics.Promise.resolve(this.#totalBytes);
        let error = reason ?? intrinsics.makeErrorWithCode(130, "Failed");
        this.#rejectPendingWrites(error), this.#rejectPendingDrains(error), this.#broadcast[kAbort](error);
    }
    [SymbolAsyncDispose]() {
        return this.fail(), intrinsics.Promise.resolve();
    }
    [SymbolDispose]() {
        this.fail();
    }
    [kCancelWriter]() {
        if (this.#isClosed())
            return;
        this.#closed = intrinsics.Promise.resolve(this.#totalBytes), this.#rejectPendingWrites(intrinsics.makeAbortError("Broadcast cancelled")), this.#resolvePendingDrains(!1);
    }
    #createPendingWrite(chunk, signal) {
        let { promise, resolve, reject } = PromiseWithResolvers(), entry = { __proto__: null, chunk, resolve, reject };
        if (this.#pendingWrites.push(entry), signal)
            wireBroadcastWriteSignal(entry, signal, resolve, reject, this);
        return promise;
    }
    #resolvePendingWrites() {
        while (this.#pendingWrites.length > 0 && this.#broadcast[kCanWrite]()) {
            let pending = this.#pendingWrites.shift(), chunk = pending.chunk;
            if (this.#broadcast[kWrite](chunk)) {
                for (let i = 0; i < chunk.length; i++)
                    this.#totalBytes += chunk[i].byteLength;
                pending.resolve();
            }
            else {
                this.#pendingWrites.unshift(pending);
                break;
            }
        }
    }
    #rejectPendingWrites(error) {
        while (this.#pendingWrites.length > 0)
            this.#pendingWrites.shift().reject(error);
    }
    #resolvePendingDrains(canWrite) {
        let drains = this.#pendingDrains;
        this.#pendingDrains = [];
        for (let i = 0; i < drains.length; i++)
            drains[i].resolve(canWrite);
    }
    #rejectPendingDrains(error) {
        let drains = this.#pendingDrains;
        this.#pendingDrains = [];
        for (let i = 0; i < drains.length; i++)
            drains[i].reject(error);
    }
}
function wireBroadcastWriteSignal(entry, signal, resolve, reject, self) {
    let onAbort = () => {
        let pendingWrites = getBroadcastPendingWrites(self), idx = pendingWrites.indexOf(entry);
        if (idx !== -1)
            pendingWrites.removeAt(idx);
        entry.chunk = null, reject(signal.reason ?? intrinsics.makeAbortError("Aborted"));
    };
    entry.resolve = function () {
        signal.removeEventListener("abort", onAbort), entry.chunk = null, resolve();
    }, entry.reject = function (reason) {
        signal.removeEventListener("abort", onAbort), entry.chunk = null, reject(reason);
    }, signal.addEventListener("abort", onAbort, { __proto__: null, once: !0 });
}
function onBroadcastCancel(broadcastImpl, signal) {
    onSignalAbort(signal, () => broadcastImpl.cancel(signal.reason));
}
function broadcast(options = { __proto__: null }) {
    validateObject(options, "options");
    let { highWaterMark = kMultiConsumerDefaultHWM, backpressure = "strict", signal } = options;
    if (validateInteger(highWaterMark, "options.highWaterMark"), validateBackpressure(backpressure), signal !== intrinsics.undefined)
        validateAbortSignal(signal, "options.signal");
    let opts = {
        __proto__: null,
        highWaterMark: clampHWM(highWaterMark),
        backpressure,
        signal
    }, broadcastImpl = new BroadcastImpl(opts), writer = new BroadcastWriter(broadcastImpl);
    if (broadcastImpl.setWriter(writer), signal)
        onBroadcastCancel(broadcastImpl, signal);
    return { __proto__: null, writer, broadcast: broadcastImpl };
}
function isBroadcastable(value) {
    return hasProtocol(value, broadcastProtocol);
}
var Broadcast = {
    __proto__: null,
    from(input, options) {
        if (isBroadcastable(input)) {
            let bc = input[broadcastProtocol](options);
            if (bc === null || typeof bc !== "object")
                throw intrinsics.makeErrorWithCode(128, "an object", "[Symbol.for('Stream.broadcastProtocol')]", bc);
            return { __proto__: null, writer: { __proto__: null }, broadcast: bc };
        }
        if (!isAsyncIterable(input) && !isSyncIterable(input))
            throw intrinsics.makeErrorWithCode(112, "input", ["Broadcastable", "AsyncIterable", "Iterable"], input);
        let result = broadcast(options), signal = options?.signal;
        return (async () => {
            let w = result.writer;
            try {
                if (isAsyncIterable(input)) {
                    for await (let chunks of input)
                        if (signal?.throwIfAborted(), intrinsics.Array.isArray(chunks)) {
                            if (!w.writevSync(chunks))
                                await w.writev(chunks, signal ? { signal } : intrinsics.undefined);
                        }
                        else if (!w.writeSync(chunks))
                            await w.write(chunks, signal ? { signal } : intrinsics.undefined);
                }
                else if (isSyncIterable(input)) {
                    for (let chunks of input)
                        if (signal?.throwIfAborted(), intrinsics.Array.isArray(chunks)) {
                            if (!w.writevSync(chunks))
                                await w.writev(chunks, signal ? { signal } : intrinsics.undefined);
                        }
                        else if (!w.writeSync(chunks))
                            await w.write(chunks, signal ? { signal } : intrinsics.undefined);
                }
                if (w.endSync() < 0)
                    await w.end(signal ? { signal } : intrinsics.undefined);
            }
            catch (error) {
                w.fail(wrapError(error));
            }
        })().then(intrinsics.undefined, () => { }), result;
    }
};
$ = {
    Broadcast,
    broadcast
};
return $;
})

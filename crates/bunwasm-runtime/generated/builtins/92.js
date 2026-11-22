// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/internal/streams/iter/push.ts.
(function (intrinsics) {
"use strict";
var $, { isNativeError } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 205) || intrinsics.createInternalModuleById(205), { validateAbortSignal, validateInteger } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 122) || intrinsics.createInternalModuleById(122), { drainableProtocol, kSyncWriteAccepted, kSyncWriteAcceptedOnFalse } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 96) || intrinsics.createInternalModuleById(96), { kPushDefaultHWM, kResolvedPromise, clampHWM, onSignalAbort, toUint8Array, convertChunks, parsePullArgs, validateBackpressure } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 97) || intrinsics.createInternalModuleById(97), { pull: pullWithTransforms } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 91) || intrinsics.createInternalModuleById(91), { RingBuffer } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 93) || intrinsics.createInternalModuleById(93), PromiseWithResolvers = intrinsics.Promise.withResolvers.bind(intrinsics.Promise), { asyncDispose: SymbolAsyncDispose, asyncIterator: SymbolAsyncIterator, dispose: SymbolDispose } = Symbol;
function isError(e) {
    return isNativeError(e) || e instanceof Error;
}
class PushQueue {
    #slots = new RingBuffer;
    #pendingWrites = new RingBuffer;
    #pendingReads = new RingBuffer;
    #pendingDrains = [];
    #writerState = "open";
    #consumerState = "active";
    #error = null;
    #bytesWritten = 0;
    #pendingEnd = null;
    #highWaterMark;
    #backpressure;
    #signal;
    #abortHandler;
    constructor(options = { __proto__: null }) {
        let { highWaterMark = kPushDefaultHWM, backpressure = "strict", signal } = options;
        if (validateInteger(highWaterMark, "options.highWaterMark"), validateBackpressure(backpressure), signal !== intrinsics.undefined)
            validateAbortSignal(signal, "options.signal");
        if (this.#highWaterMark = clampHWM(highWaterMark), this.#backpressure = backpressure, this.#signal = signal, this.#abortHandler = intrinsics.undefined, this.#signal)
            this.#abortHandler = () => {
                this.fail(isError(this.#signal.reason) ? this.#signal.reason : intrinsics.makeAbortError("Aborted"));
            }, onSignalAbort(this.#signal, this.#abortHandler);
    }
    get desiredSize() {
        if (this.#writerState !== "open" || this.#consumerState !== "active")
            return null;
        return Math.max(0, this.#highWaterMark - this.#slots.length);
    }
    canWriteSync() {
        if (this.#writerState !== "open")
            return !1;
        if (this.#consumerState !== "active")
            return !1;
        if ((this.#backpressure === "strict" || this.#backpressure === "block") && this.#slots.length >= this.#highWaterMark)
            return !1;
        return !0;
    }
    writeSync(chunks) {
        if (this.#writerState !== "open")
            return !1;
        if (this.#consumerState !== "active")
            return !1;
        if (this.#slots.length >= this.#highWaterMark)
            switch (this.#backpressure) {
                case "strict":
                    return !1;
                case "block":
                    return !1;
                case "drop-oldest":
                    if (this.#slots.length > 0)
                        this.#slots.shift();
                    break;
                case "drop-newest":
                    for (let i = 0; i < chunks.length; i++)
                        this.#bytesWritten += chunks[i].byteLength;
                    return !0;
            }
        this.#slots.push(chunks);
        for (let i = 0; i < chunks.length; i++)
            this.#bytesWritten += chunks[i].byteLength;
        return this.#resolvePendingReads(), !0;
    }
    async writeAsync(chunks, signal) {
        if (this.#writerState === "closed")
            throw intrinsics.makeErrorWithCode(130, "Writer is closed");
        if (this.#writerState === "closing")
            throw intrinsics.makeErrorWithCode(130, "Writer is closing");
        if (this.#writerState === "errored")
            throw this.#error;
        if (this.#consumerState !== "active")
            throw this.#consumerState === "thrown" && this.#error ? this.#error : intrinsics.makeErrorWithCode(130, "Stream closed by consumer");
        if (signal?.throwIfAborted(), this.writeSync(chunks))
            return;
        switch (this.#backpressure) {
            case "strict":
                if (this.#pendingWrites.length >= this.#highWaterMark)
                    throw intrinsics.makeErrorWithCode(131, "Backpressure violation: too many pending writes. Await each write() call to respect backpressure.");
                return this.#createPendingWrite(chunks, signal);
            case "block":
                return this.#createPendingWrite(chunks, signal);
            default:
                throw intrinsics.makeErrorWithCode(129, "Unexpected: writeSync should have handled non-strict policy");
        }
    }
    #createPendingWrite(chunks, signal) {
        let { promise, resolve, reject } = PromiseWithResolvers(), entry = { __proto__: null, chunks, resolve, reject };
        if (this.#pendingWrites.push(entry), signal) {
            let onAbort = () => {
                let idx = this.#pendingWrites.indexOf(entry);
                if (idx !== -1)
                    this.#pendingWrites.removeAt(idx);
                reject(signal.reason ?? intrinsics.makeAbortError("Aborted"));
            };
            entry.resolve = function () {
                signal.removeEventListener("abort", onAbort), resolve();
            }, entry.reject = function (reason) {
                signal.removeEventListener("abort", onAbort), reject(reason);
            }, signal.addEventListener("abort", onAbort, { __proto__: null, once: !0 });
        }
        return promise;
    }
    end() {
        if (this.#writerState === "errored")
            return -2;
        if (this.#writerState === "closing")
            return -3;
        if (this.#writerState === "closed")
            return this.#bytesWritten;
        if (this.#cleanup(), this.#rejectPendingWrites(intrinsics.makeErrorWithCode(130, "Writer closed")), this.#resolvePendingDrains(!1), this.#slots.length === 0)
            return this.#writerState = "closed", this.#resolvePendingReads(), this.#bytesWritten;
        return this.#writerState = "closing", -3;
    }
    endDrained() {
        if (this.#writerState !== "closing")
            return;
        if (this.#writerState = "closed", this.#pendingEnd)
            this.#pendingEnd.resolve(this.#bytesWritten), this.#pendingEnd = null;
    }
    fail(reason) {
        if (this.#writerState === "errored" || this.#writerState === "closed")
            return;
        let wasClosing = this.#writerState === "closing";
        if (this.#writerState = "errored", this.#error = reason ?? intrinsics.makeErrorWithCode(129, "Failed"), this.#cleanup(), this.#rejectPendingReads(this.#error), this.#rejectPendingDrains(this.#error), wasClosing) {
            if (this.#pendingEnd)
                this.#pendingEnd.reject(this.#error), this.#pendingEnd = null;
        }
        else
            this.#rejectPendingWrites(this.#error);
    }
    get totalBytesWritten() {
        return this.#bytesWritten;
    }
    get error() {
        return this.#error;
    }
    get backpressurePolicy() {
        return this.#backpressure;
    }
    get writerState() {
        return this.#writerState;
    }
    get pendingEndPromise() {
        return this.#pendingEnd?.promise ?? null;
    }
    setPendingEnd(pending) {
        this.#pendingEnd = pending;
    }
    forceEnqueue(chunks) {
        this.#slots.push(chunks);
        for (let i = 0; i < chunks.length; i++)
            this.#bytesWritten += chunks[i].byteLength;
        this.#resolvePendingReads();
    }
    waitForDrain() {
        let { promise, resolve, reject } = PromiseWithResolvers();
        return this.#pendingDrains.push({ __proto__: null, resolve, reject }), promise;
    }
    async read() {
        if (this.#slots.length > 0) {
            let result = this.#drain();
            if (this.#resolvePendingWrites(), this.#writerState === "closing" && this.#slots.length === 0)
                this.endDrained();
            return { __proto__: null, value: result, done: !1 };
        }
        if (this.#writerState === "closing")
            return this.endDrained(), { __proto__: null, value: intrinsics.undefined, done: !0 };
        if (this.#writerState === "closed")
            return { __proto__: null, value: intrinsics.undefined, done: !0 };
        if (this.#writerState === "errored" && this.#error)
            throw this.#error;
        let { promise, resolve, reject } = PromiseWithResolvers();
        return this.#pendingReads.push({ __proto__: null, resolve, reject }), promise;
    }
    consumerReturn() {
        if (this.#consumerState !== "active")
            return;
        if (this.#consumerState = "returned", this.#cleanup(), this.#resolvePendingReads(), this.#rejectPendingWrites(intrinsics.makeErrorWithCode(130, "Stream closed by consumer")), this.#writerState === "closing" && this.#pendingEnd)
            this.#pendingEnd.reject(intrinsics.makeErrorWithCode(130, "Stream closed by consumer")), this.#pendingEnd = null;
        this.#resolvePendingDrains(!1);
    }
    consumerThrow(error) {
        if (this.#consumerState !== "active")
            return;
        if (this.#consumerState = "thrown", this.#error = error, this.#cleanup(), this.#rejectPendingReads(error), this.#rejectPendingWrites(error), this.#writerState === "closing" && this.#pendingEnd)
            this.#pendingEnd.reject(error), this.#pendingEnd = null;
        this.#rejectPendingDrains(error);
    }
    #drain() {
        if (this.#slots.length === 1)
            return this.#slots.shift();
        let result = [];
        for (let i = 0; i < this.#slots.length; i++) {
            let slot = this.#slots.get(i);
            for (let j = 0; j < slot.length; j++)
                result.push(slot[j]);
        }
        return this.#slots.clear(), result;
    }
    #resolvePendingReads() {
        while (this.#pendingReads.length > 0)
            if (this.#slots.length > 0) {
                let pending = this.#pendingReads.shift(), result = this.#drain();
                this.#resolvePendingWrites(), pending.resolve({ __proto__: null, value: result, done: !1 });
            }
            else if (this.#writerState === "closing" && this.#slots.length === 0)
                this.endDrained(), this.#pendingReads.shift().resolve({ __proto__: null, value: intrinsics.undefined, done: !0 });
            else if (this.#writerState === "closed")
                this.#pendingReads.shift().resolve({ __proto__: null, value: intrinsics.undefined, done: !0 });
            else if (this.#writerState === "errored" && this.#error)
                this.#pendingReads.shift().reject(this.#error);
            else if (this.#consumerState === "returned")
                this.#pendingReads.shift().resolve({ __proto__: null, done: !0, value: intrinsics.undefined });
            else
                break;
    }
    #resolvePendingWrites() {
        while (this.#pendingWrites.length > 0 && this.#slots.length < this.#highWaterMark) {
            let pending = this.#pendingWrites.shift();
            this.#slots.push(pending.chunks);
            for (let i = 0; i < pending.chunks.length; i++)
                this.#bytesWritten += pending.chunks[i].byteLength;
            pending.resolve();
        }
        if (this.#slots.length < this.#highWaterMark)
            this.#resolvePendingDrains(!0);
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
    #rejectPendingReads(error) {
        while (this.#pendingReads.length > 0)
            this.#pendingReads.shift().reject(error);
    }
    #rejectPendingWrites(error) {
        while (this.#pendingWrites.length > 0)
            this.#pendingWrites.shift().reject(error);
    }
    #cleanup() {
        if (this.#signal && this.#abortHandler)
            this.#signal.removeEventListener("abort", this.#abortHandler), this.#abortHandler = intrinsics.undefined;
    }
}
class PushWriter {
    #queue;
    #syncWriteAccepted = !1;
    constructor(queue) {
        this.#queue = queue;
    }
    [kSyncWriteAccepted]() {
        return this.#syncWriteAccepted;
    }
    [drainableProtocol]() {
        let desired = this.desiredSize;
        if (desired === null)
            return null;
        if (desired > 0)
            return intrinsics.Promise.resolve(!0);
        return this.#queue.waitForDrain();
    }
    get desiredSize() {
        return this.#queue.desiredSize;
    }
    get [kSyncWriteAcceptedOnFalse]() {
        return this.#queue.backpressurePolicy === "block";
    }
    write(chunk, options) {
        if (!options?.signal && this.#queue.canWriteSync()) {
            let bytes = toUint8Array(chunk);
            return this.#queue.writeSync([bytes]), kResolvedPromise;
        }
        let bytes = toUint8Array(chunk);
        return this.#queue.writeAsync([bytes], options?.signal);
    }
    writev(chunks, options) {
        if (!intrinsics.Array.isArray(chunks))
            throw intrinsics.makeErrorWithCode(112, "chunks", "Array", chunks);
        if (!options?.signal && this.#queue.canWriteSync()) {
            let bytes = convertChunks(chunks);
            return this.#queue.writeSync(bytes), kResolvedPromise;
        }
        let bytes = convertChunks(chunks);
        return this.#queue.writeAsync(bytes, options?.signal);
    }
    writeSync(chunk) {
        this.#syncWriteAccepted = !1;
        let bytes = toUint8Array(chunk), result = this.#queue.writeSync([bytes]);
        if (!result && this.#queue.backpressurePolicy === "block" && this.#queue.desiredSize === 0)
            return this.#queue.forceEnqueue([bytes]), this.#syncWriteAccepted = !0, !1;
        return this.#syncWriteAccepted = result, result;
    }
    writevSync(chunks) {
        if (this.#syncWriteAccepted = !1, !intrinsics.Array.isArray(chunks))
            throw intrinsics.makeErrorWithCode(112, "chunks", "Array", chunks);
        let bytes = convertChunks(chunks), result = this.#queue.writeSync(bytes);
        if (!result && this.#queue.backpressurePolicy === "block" && this.#queue.desiredSize === 0)
            return this.#queue.forceEnqueue(bytes), this.#syncWriteAccepted = !0, !1;
        return this.#syncWriteAccepted = result, result;
    }
    end(_options) {
        let result = this.#queue.end();
        if (result === -2)
            return intrinsics.Promise.reject(this.#queue.error);
        if (result === -3) {
            let pendingEndPromise = this.#queue.pendingEndPromise;
            if (pendingEndPromise !== null)
                return pendingEndPromise;
            let { promise, resolve, reject } = PromiseWithResolvers();
            return this.#queue.setPendingEnd({ __proto__: null, promise, resolve, reject }), promise;
        }
        return intrinsics.Promise.resolve(result);
    }
    endSync() {
        let result = this.#queue.end();
        if (result === -2)
            return -1;
        if (result === -3)
            return -1;
        return result;
    }
    fail(reason) {
        this.#queue.fail(reason);
    }
    [SymbolAsyncDispose]() {
        let state = this.#queue.writerState;
        if (state === "closing")
            return this.#queue.pendingEndPromise ?? intrinsics.Promise.resolve();
        if (state === "open")
            this.fail();
        return intrinsics.Promise.resolve();
    }
    [SymbolDispose]() {
        this.fail();
    }
}
function createReadable(queue) {
    return {
        __proto__: null,
        [SymbolAsyncIterator]() {
            return {
                __proto__: null,
                async next() {
                    return queue.read();
                },
                async return() {
                    return queue.consumerReturn(), { __proto__: null, value: intrinsics.undefined, done: !0 };
                },
                async throw(error) {
                    return queue.consumerThrow(error), { __proto__: null, value: intrinsics.undefined, done: !0 };
                }
            };
        }
    };
}
function parseArgs(args) {
    let result = parsePullArgs(args);
    if (result.options === intrinsics.undefined)
        result.options = { __proto__: null };
    return result;
}
function push(...args) {
    let { transforms, options } = parseArgs(args), queue = new PushQueue(options), writer = new PushWriter(queue), rawReadable = createReadable(queue), readable;
    if (transforms.length > 0) {
        let signal = options.signal;
        if (signal)
            readable = pullWithTransforms(rawReadable, ...transforms, { __proto__: null, signal });
        else
            readable = pullWithTransforms(rawReadable, ...transforms);
    }
    else
        readable = rawReadable;
    return { __proto__: null, writer, readable };
}
$ = {
    push
};
return $;
})

// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/internal/streams/iter/share.ts.
(function (intrinsics) {
"use strict";
var $, { shareProtocol, shareSyncProtocol } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 96) || intrinsics.createInternalModuleById(96), { from, fromSync, isAsyncIterable, isSyncIterable } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 90) || intrinsics.createInternalModuleById(90), { pull: pullWithTransforms, pullSync: pullSyncWithTransforms } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 91) || intrinsics.createInternalModuleById(91), { kMultiConsumerDefaultHWM, clampHWM, getMinCursor, hasProtocol, onSignalAbort, wrapError, parsePullArgs, validateBackpressure } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 97) || intrinsics.createInternalModuleById(97), { RingBuffer } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 93) || intrinsics.createInternalModuleById(93), { validateAbortSignal, validateInteger, validateObject } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 122) || intrinsics.createInternalModuleById(122);
class ShareImpl {
    #source;
    #options;
    #buffer = new RingBuffer;
    #bufferStart = 0;
    #consumers = new Set;
    #sourceIterator = null;
    #sourceExhausted = !1;
    #sourceError = null;
    #cancelled = !1;
    #pulling = !1;
    #pullWaiters = [];
    #cachedMinCursor = 0;
    #cachedMinCursorConsumers = 0;
    constructor(source, options) {
        this.#source = source, this.#options = options;
    }
    get consumerCount() {
        return this.#consumers.size;
    }
    get bufferSize() {
        return this.#buffer.length;
    }
    pull(...args) {
        let { transforms, options } = parsePullArgs(args), rawConsumer = this.#createRawConsumer();
        if (transforms.length > 0) {
            if (options)
                return pullWithTransforms(rawConsumer, ...transforms, options);
            return pullWithTransforms(rawConsumer, ...transforms);
        }
        return rawConsumer;
    }
    #createRawConsumer() {
        let state = {
            __proto__: null,
            cursor: this.#bufferStart,
            resolve: null,
            reject: null,
            detached: !1,
            pendingNext: intrinsics.Promise.resolve()
        };
        if (this.#consumers.add(state), this.#consumers.size === 1)
            this.#cachedMinCursor = state.cursor, this.#cachedMinCursorConsumers = 1;
        else if (state.cursor === this.#cachedMinCursor)
            this.#cachedMinCursorConsumers++;
        else
            this.#recomputeMinCursor();
        let self = this;
        return {
            __proto__: null,
            [Symbol.asyncIterator]() {
                let getNext = async () => {
                    if (self.#sourceError)
                        throw state.detached = !0, self.#consumers.delete(state), self.#sourceError;
                    for (;;) {
                        if (state.detached) {
                            if (self.#sourceError)
                                throw self.#sourceError;
                            return { __proto__: null, done: !0, value: intrinsics.undefined };
                        }
                        if (self.#cancelled)
                            return state.detached = !0, self.#deleteConsumer(state), { __proto__: null, done: !0, value: intrinsics.undefined };
                        let bufferIndex = state.cursor - self.#bufferStart;
                        if (bufferIndex < self.#buffer.length) {
                            let chunk = self.#buffer.get(bufferIndex), cursor = state.cursor;
                            if (state.cursor++, cursor === self.#cachedMinCursor && --self.#cachedMinCursorConsumers === 0)
                                self.#tryTrimBuffer();
                            return { __proto__: null, done: !1, value: chunk };
                        }
                        if (self.#sourceExhausted) {
                            if (state.detached = !0, self.#deleteConsumer(state), self.#sourceError)
                                throw self.#sourceError;
                            return { __proto__: null, done: !0, value: intrinsics.undefined };
                        }
                        if (!await self.#waitForBufferSpace()) {
                            if (state.detached = !0, self.#deleteConsumer(state), self.#sourceError)
                                throw self.#sourceError;
                            return { __proto__: null, done: !0, value: intrinsics.undefined };
                        }
                        await self.#pullFromSource();
                    }
                };
                return {
                    __proto__: null,
                    next() {
                        let next = state.pendingNext.then(getNext, getNext);
                        return state.pendingNext = next.then(intrinsics.undefined, () => { }), next;
                    },
                    async return() {
                        if (state.detached = !0, state.resolve = null, state.reject = null, self.#deleteConsumer(state))
                            self.#tryTrimBuffer();
                        return { __proto__: null, done: !0, value: intrinsics.undefined };
                    },
                    async throw() {
                        if (state.detached = !0, state.resolve = null, state.reject = null, self.#deleteConsumer(state))
                            self.#tryTrimBuffer();
                        return { __proto__: null, done: !0, value: intrinsics.undefined };
                    }
                };
            }
        };
    }
    cancel(reason) {
        if (this.#cancelled)
            return;
        if (this.#cancelled = !0, reason !== intrinsics.undefined)
            this.#sourceError = reason;
        if (this.#sourceIterator?.return)
            this.#sourceIterator.return().then(intrinsics.undefined, () => { });
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
        this.#consumers.clear();
        for (let i = 0; i < this.#pullWaiters.length; i++)
            this.#pullWaiters[i]();
        this.#pullWaiters = [];
    }
    [Symbol.dispose]() {
        this.cancel();
    }
    async #waitForBufferSpace() {
        while (this.#buffer.length >= this.#options.highWaterMark) {
            if (this.#cancelled || this.#sourceError || this.#sourceExhausted)
                return !this.#cancelled;
            switch (this.#options.backpressure) {
                case "strict":
                    throw intrinsics.makeErrorWithCode(149, "buffer size", `<= ${this.#options.highWaterMark}`, this.#buffer.length);
                case "block": {
                    let { promise, resolve } = intrinsics.Promise.withResolvers();
                    this.#pullWaiters.push(resolve), await promise;
                    break;
                }
                case "drop-oldest":
                    this.#buffer.shift(), this.#bufferStart++;
                    for (let consumer of this.#consumers)
                        if (consumer.cursor < this.#bufferStart)
                            this.#deleteConsumerFromMin(consumer), consumer.cursor = this.#bufferStart;
                    return this.#recomputeMinCursor(), !0;
                case "drop-newest":
                    return !0;
            }
        }
        return !0;
    }
    #pullFromSource() {
        if (this.#sourceExhausted || this.#cancelled)
            return intrinsics.Promise.resolve();
        if (this.#pulling) {
            let { promise, resolve } = intrinsics.Promise.withResolvers();
            return this.#pullWaiters.push(resolve), promise;
        }
        return this.#pulling = !0, (async () => {
            try {
                if (!this.#sourceIterator)
                    if (isAsyncIterable(this.#source))
                        this.#sourceIterator = this.#source[Symbol.asyncIterator]();
                    else if (isSyncIterable(this.#source)) {
                        let syncIterator = this.#source[Symbol.iterator]();
                        this.#sourceIterator = {
                            __proto__: null,
                            async next() {
                                return syncIterator.next();
                            },
                            async return() {
                                return syncIterator.return?.() ?? { __proto__: null, done: !0, value: intrinsics.undefined };
                            }
                        };
                    }
                    else
                        throw intrinsics.makeErrorWithCode(112, "source", ["AsyncIterable", "Iterable"], this.#source);
                let result = await this.#sourceIterator.next();
                if (result.done)
                    this.#sourceExhausted = !0;
                else
                    this.#buffer.push(result.value);
            }
            catch (error) {
                this.#sourceError = wrapError(error), this.#sourceExhausted = !0;
            }
            finally {
                this.#pulling = !1;
                for (let i = 0; i < this.#pullWaiters.length; i++)
                    this.#pullWaiters[i]();
                this.#pullWaiters = [];
            }
        })();
    }
    #tryTrimBuffer() {
        if (this.#cachedMinCursorConsumers === 0)
            this.#recomputeMinCursor();
        let trimCount = this.#cachedMinCursor - this.#bufferStart;
        if (trimCount > 0) {
            this.#buffer.trimFront(trimCount), this.#bufferStart = this.#cachedMinCursor;
            for (let i = 0; i < this.#pullWaiters.length; i++)
                this.#pullWaiters[i]();
            this.#pullWaiters = [];
        }
    }
    #recomputeMinCursor() {
        let { minCursor, minCursorConsumers } = getMinCursor(this.#consumers, this.#bufferStart + this.#buffer.length);
        this.#cachedMinCursor = minCursor, this.#cachedMinCursorConsumers = minCursorConsumers;
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
class SyncShareImpl {
    #source;
    #options;
    #buffer = new RingBuffer;
    #bufferStart = 0;
    #consumers = new Set;
    #sourceIterator = null;
    #sourceExhausted = !1;
    #sourceError = null;
    #cancelled = !1;
    #cachedMinCursor = 0;
    #cachedMinCursorConsumers = 0;
    constructor(source, options) {
        this.#source = source, this.#options = options;
    }
    get consumerCount() {
        return this.#consumers.size;
    }
    get bufferSize() {
        return this.#buffer.length;
    }
    pull(...transforms) {
        let rawConsumer = this.#createRawConsumer();
        if (transforms.length > 0)
            return pullSyncWithTransforms(rawConsumer, ...transforms);
        return rawConsumer;
    }
    #createRawConsumer() {
        let state = {
            __proto__: null,
            cursor: this.#bufferStart,
            detached: !1
        };
        if (this.#consumers.add(state), this.#consumers.size === 1)
            this.#cachedMinCursor = state.cursor, this.#cachedMinCursorConsumers = 1;
        else if (state.cursor === this.#cachedMinCursor)
            this.#cachedMinCursorConsumers++;
        else
            this.#recomputeMinCursor();
        let self = this;
        return {
            __proto__: null,
            [Symbol.iterator]() {
                return {
                    __proto__: null,
                    next() {
                        if (state.detached)
                            return { __proto__: null, done: !0, value: intrinsics.undefined };
                        if (self.#sourceError)
                            throw state.detached = !0, self.#deleteConsumer(state), self.#sourceError;
                        if (self.#cancelled)
                            return state.detached = !0, self.#deleteConsumer(state), { __proto__: null, done: !0, value: intrinsics.undefined };
                        let bufferIndex = state.cursor - self.#bufferStart;
                        if (bufferIndex < self.#buffer.length) {
                            let chunk = self.#buffer.get(bufferIndex), cursor = state.cursor;
                            if (state.cursor++, cursor === self.#cachedMinCursor && --self.#cachedMinCursorConsumers === 0)
                                self.#tryTrimBuffer();
                            return { __proto__: null, done: !1, value: chunk };
                        }
                        if (self.#sourceExhausted)
                            return state.detached = !0, self.#deleteConsumer(state), { __proto__: null, done: !0, value: intrinsics.undefined };
                        if (self.#buffer.length >= self.#options.highWaterMark)
                            switch (self.#options.backpressure) {
                                case "strict":
                                    throw intrinsics.makeErrorWithCode(149, "buffer size", `<= ${self.#options.highWaterMark}`, self.#buffer.length);
                                case "block":
                                    throw intrinsics.makeErrorWithCode(149, "buffer size", `<= ${self.#options.highWaterMark} (blocking not available in sync context)`, self.#buffer.length);
                                case "drop-oldest":
                                    self.#buffer.shift(), self.#bufferStart++;
                                    for (let consumer of self.#consumers)
                                        if (consumer.cursor < self.#bufferStart)
                                            self.#deleteConsumerFromMin(consumer), consumer.cursor = self.#bufferStart;
                                    self.#recomputeMinCursor();
                                    break;
                                case "drop-newest":
                                    return state.detached = !0, self.#deleteConsumer(state), { __proto__: null, done: !0, value: intrinsics.undefined };
                            }
                        if (self.#pullFromSource(), self.#sourceError)
                            throw state.detached = !0, self.#deleteConsumer(state), self.#sourceError;
                        let newBufferIndex = state.cursor - self.#bufferStart;
                        if (newBufferIndex < self.#buffer.length) {
                            let chunk = self.#buffer.get(newBufferIndex), cursor = state.cursor;
                            if (state.cursor++, cursor === self.#cachedMinCursor && --self.#cachedMinCursorConsumers === 0)
                                self.#tryTrimBuffer();
                            return { __proto__: null, done: !1, value: chunk };
                        }
                        if (self.#sourceExhausted)
                            return state.detached = !0, self.#deleteConsumer(state), { __proto__: null, done: !0, value: intrinsics.undefined };
                        return { __proto__: null, done: !0, value: intrinsics.undefined };
                    },
                    return() {
                        if (state.detached = !0, self.#deleteConsumer(state))
                            self.#tryTrimBuffer();
                        return { __proto__: null, done: !0, value: intrinsics.undefined };
                    },
                    throw() {
                        if (state.detached = !0, self.#deleteConsumer(state))
                            self.#tryTrimBuffer();
                        return { __proto__: null, done: !0, value: intrinsics.undefined };
                    }
                };
            }
        };
    }
    cancel(reason) {
        if (this.#cancelled)
            return;
        if (this.#cancelled = !0, reason !== intrinsics.undefined)
            this.#sourceError = reason;
        if (this.#sourceIterator?.return)
            this.#sourceIterator.return();
        for (let consumer of this.#consumers)
            consumer.detached = !0;
        this.#consumers.clear();
    }
    [Symbol.dispose]() {
        this.cancel();
    }
    #pullFromSource() {
        if (this.#sourceExhausted || this.#cancelled)
            return;
        try {
            this.#sourceIterator ||= this.#source[Symbol.iterator]();
            let result = this.#sourceIterator.next();
            if (result.done)
                this.#sourceExhausted = !0;
            else
                this.#buffer.push(result.value);
        }
        catch (error) {
            this.#sourceError = wrapError(error), this.#sourceExhausted = !0;
        }
    }
    #tryTrimBuffer() {
        if (this.#cachedMinCursorConsumers === 0)
            this.#recomputeMinCursor();
        let trimCount = this.#cachedMinCursor - this.#bufferStart;
        if (trimCount > 0)
            this.#buffer.trimFront(trimCount), this.#bufferStart = this.#cachedMinCursor;
    }
    #recomputeMinCursor() {
        let { minCursor, minCursorConsumers } = getMinCursor(this.#consumers, this.#bufferStart + this.#buffer.length);
        this.#cachedMinCursor = minCursor, this.#cachedMinCursorConsumers = minCursorConsumers;
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
function onShareCancel(shareImpl, signal) {
    onSignalAbort(signal, () => shareImpl.cancel(signal.reason));
}
function share(source, options = { __proto__: null }) {
    let normalized = from(source);
    validateObject(options, "options");
    let { highWaterMark = kMultiConsumerDefaultHWM, backpressure = "strict", signal } = options;
    if (validateInteger(highWaterMark, "options.highWaterMark"), validateBackpressure(backpressure), signal !== intrinsics.undefined)
        validateAbortSignal(signal, "options.signal");
    let opts = {
        __proto__: null,
        highWaterMark: clampHWM(highWaterMark),
        backpressure,
        signal
    }, shareImpl = new ShareImpl(normalized, opts);
    if (signal)
        onShareCancel(shareImpl, signal);
    return shareImpl;
}
function shareSync(source, options = { __proto__: null }) {
    let normalized = fromSync(source);
    validateObject(options, "options");
    let { highWaterMark = kMultiConsumerDefaultHWM, backpressure = "strict" } = options;
    validateInteger(highWaterMark, "options.highWaterMark"), validateBackpressure(backpressure);
    let opts = {
        __proto__: null,
        highWaterMark: clampHWM(highWaterMark),
        backpressure
    };
    return new SyncShareImpl(normalized, opts);
}
function isShareable(value) {
    return hasProtocol(value, shareProtocol);
}
function isSyncShareable(value) {
    return hasProtocol(value, shareSyncProtocol);
}
var Share = {
    __proto__: null,
    from(input, options) {
        if (isShareable(input)) {
            let result = input[shareProtocol](options);
            if (result === null || typeof result !== "object")
                throw intrinsics.makeErrorWithCode(128, "an object", "[Symbol.for('Stream.shareProtocol')]", result);
            return result;
        }
        if (isAsyncIterable(input) || isSyncIterable(input))
            return share(input, options);
        throw intrinsics.makeErrorWithCode(112, "input", ["Shareable", "AsyncIterable", "Iterable"], input);
    }
}, SyncShare = {
    __proto__: null,
    fromSync(input, options) {
        if (isSyncShareable(input)) {
            let result = input[shareSyncProtocol](options);
            if (result === null || typeof result !== "object")
                throw intrinsics.makeErrorWithCode(128, "an object", "[Symbol.for('Stream.shareSyncProtocol')]", result);
            return result;
        }
        if (isSyncIterable(input))
            return shareSync(input, options);
        throw intrinsics.makeErrorWithCode(112, "input", ["SyncShareable", "Iterable"], input);
    }
};
$ = {
    Share,
    SyncShare,
    share,
    shareSync
};
return $;
})

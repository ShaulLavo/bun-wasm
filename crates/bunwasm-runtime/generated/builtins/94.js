// Generated from Bun a7733435cf40429e3b35c36072769df2052b80f1, src/js/internal/streams/iter/duplex.ts.
(function (intrinsics) {
"use strict";
var $, { push } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 97) || intrinsics.createInternalModuleById(97), { validateAbortSignal, validateObject } = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 127) || intrinsics.createInternalModuleById(127);
function duplex(options = { __proto__: null }) {
    validateObject(options, "options");
    let { highWaterMark, backpressure, signal, a, b } = options;
    if (a !== intrinsics.undefined)
        validateObject(a, "options.a");
    if (b !== intrinsics.undefined)
        validateObject(b, "options.b");
    if (signal !== intrinsics.undefined)
        validateAbortSignal(signal, "options.signal");
    let { writer: aWriter, readable: bReadable } = push({
        highWaterMark: a?.highWaterMark ?? highWaterMark,
        backpressure: a?.backpressure ?? backpressure
    }), { writer: bWriter, readable: aReadable } = push({
        highWaterMark: b?.highWaterMark ?? highWaterMark,
        backpressure: b?.backpressure ?? backpressure
    }), aClosed = !1, bClosed = !1, aReadableIterator = null, bReadableIterator = null, channelA = {
        __proto__: null,
        get writer() {
            return aWriter;
        },
        get readable() {
            return {
                __proto__: null,
                [Symbol.asyncIterator]() {
                    let iter = aReadable[Symbol.asyncIterator]();
                    return aReadableIterator = iter, iter;
                }
            };
        },
        async close() {
            if (aClosed)
                return;
            if (aClosed = !0, aWriter.endSync(), aReadableIterator?.return)
                await aReadableIterator.return(), aReadableIterator = null;
        },
        [Symbol.asyncDispose]() {
            return this.close();
        }
    }, channelB = {
        __proto__: null,
        get writer() {
            return bWriter;
        },
        get readable() {
            return {
                __proto__: null,
                [Symbol.asyncIterator]() {
                    let iter = bReadable[Symbol.asyncIterator]();
                    return bReadableIterator = iter, iter;
                }
            };
        },
        async close() {
            if (bClosed)
                return;
            if (bClosed = !0, bWriter.endSync(), bReadableIterator?.return)
                await bReadableIterator.return(), bReadableIterator = null;
        },
        [Symbol.asyncDispose]() {
            return this.close();
        }
    };
    if (signal) {
        let abortBoth = () => {
            let reason = signal.reason;
            aWriter.fail(reason), bWriter.fail(reason);
        };
        if (signal.aborted)
            abortBoth();
        else
            signal.addEventListener("abort", abortBoth, { __proto__: null, once: !0 });
    }
    return [channelA, channelB];
}
$ = {
    duplex
};
return $;
})

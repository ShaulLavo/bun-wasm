// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/internal/streams/duplexpair.ts.
(function (intrinsics) {
"use strict";
var $, Duplex = intrinsics.getInternalField(intrinsics.internalModuleRegistry, 80) || intrinsics.createInternalModuleById(80), kCallback = Symbol("Callback"), kInitOtherSide = Symbol("InitOtherSide");
class DuplexSide extends Duplex {
    #otherSide = null;
    [kCallback] = null;
    constructor(options) {
        super(options);
        this.#otherSide = null;
    }
    [kInitOtherSide](otherSide) {
        if (this.#otherSide === null)
            this.#otherSide = otherSide;
    }
    _read() {
        let callback = this[kCallback];
        if (callback)
            this[kCallback] = null, callback();
    }
    _write(chunk, encoding, callback) {
        if (chunk.length === 0)
            process.nextTick(callback);
        else
            this.#otherSide.push(chunk), this.#otherSide[kCallback] = callback;
    }
    _final(callback) {
        this.#otherSide.on("end", callback), this.#otherSide.push(null);
    }
    _destroy(err, callback) {
        let otherSide = this.#otherSide;
        if (otherSide !== null && !otherSide.destroyed)
            process.nextTick(() => {
                if (otherSide.destroyed)
                    return;
                if (err)
                    otherSide.destroy();
                else
                    otherSide.push(null);
            });
        callback(err);
    }
}
function duplexPair(options) {
    let side0 = new DuplexSide(options), side1 = new DuplexSide(options);
    return side0[kInitOtherSide](side1), side1[kInitOtherSide](side0), [side0, side1];
}
$ = duplexPair;
return $;
})

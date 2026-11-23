// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/internal/streams/iter/ringbuffer.ts.
(function (intrinsics) {
"use strict";
var $;
class RingBuffer {
    #backing;
    #head = 0;
    #size = 0;
    #mask;
    constructor(initialCapacity = 16) {
        this.#mask = initialCapacity - 1, this.#backing = new intrinsics.Array(initialCapacity);
    }
    get length() {
        return this.#size;
    }
    push(item) {
        if (this.#size > this.#mask)
            this.#grow();
        this.#backing[this.#head + this.#size & this.#mask] = item, this.#size++;
    }
    unshift(item) {
        if (this.#size > this.#mask)
            this.#grow();
        this.#head = this.#head - 1 + this.#mask + 1 & this.#mask, this.#backing[this.#head] = item, this.#size++;
    }
    shift() {
        if (this.#size === 0)
            return intrinsics.undefined;
        let item = this.#backing[this.#head];
        return this.#backing[this.#head] = intrinsics.undefined, this.#head = this.#head + 1 & this.#mask, this.#size--, item;
    }
    get(index) {
        if (index < 0 || index >= this.#size)
            return intrinsics.undefined;
        return this.#backing[this.#head + index & this.#mask];
    }
    trimFront(count) {
        if (count <= 0)
            return;
        if (count >= this.#size) {
            this.clear();
            return;
        }
        for (let i = 0; i < count; i++)
            this.#backing[this.#head + i & this.#mask] = intrinsics.undefined;
        this.#head = this.#head + count & this.#mask, this.#size -= count;
    }
    indexOf(item) {
        for (let i = 0; i < this.#size; i++)
            if (this.#backing[this.#head + i & this.#mask] === item)
                return i;
        return -1;
    }
    removeAt(index) {
        if (index < 0 || index >= this.#size)
            return;
        for (let i = index; i < this.#size - 1; i++) {
            let from = this.#head + i + 1 & this.#mask, to = this.#head + i & this.#mask;
            this.#backing[to] = this.#backing[from];
        }
        let last = this.#head + this.#size - 1 & this.#mask;
        this.#backing[last] = intrinsics.undefined, this.#size--;
    }
    clear() {
        for (let i = 0; i < this.#size; i++)
            this.#backing[this.#head + i & this.#mask] = intrinsics.undefined;
        this.#head = 0, this.#size = 0;
    }
    #grow() {
        let newCapacity = (this.#mask + 1) * 2, newBacking = new intrinsics.Array(newCapacity);
        for (let i = 0; i < this.#size; i++)
            newBacking[i] = this.#backing[this.#head + i & this.#mask];
        this.#backing = newBacking, this.#head = 0, this.#mask = newCapacity - 1;
    }
}
$ = { RingBuffer };
return $;
})

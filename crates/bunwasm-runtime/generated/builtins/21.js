// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/internal/fixed_queue.ts.
(function (intrinsics) {
"use strict";
var $, ArrayPrototypeFill = intrinsics.Array.prototype.fill;
class FixedCircularBuffer {
    top;
    bottom;
    list;
    next;
    constructor() {
        this.bottom = 0, this.top = 0, this.list = intrinsics.uncurry(ArrayPrototypeFill, "call")(intrinsics.newArrayWithSize(2048), intrinsics.undefined), this.next = null;
    }
    isEmpty() {
        return this.top === this.bottom;
    }
    isFull() {
        return (this.top + 1 & 2047) === this.bottom;
    }
    push(data) {
        this.list[this.top] = data, this.top = this.top + 1 & 2047;
    }
    shift() {
        var { list, bottom } = this;
        let nextItem = list[bottom];
        if (nextItem === intrinsics.undefined)
            return null;
        return list[bottom] = intrinsics.undefined, this.bottom = bottom + 1 & 2047, nextItem;
    }
}
class FixedQueue {
    head;
    tail;
    constructor() {
        this.head = this.tail = new FixedCircularBuffer;
    }
    isEmpty() {
        return this.head.isEmpty();
    }
    push(data) {
        if (this.head.isFull())
            this.head = this.head.next = new FixedCircularBuffer;
        this.head.push(data);
    }
    shift() {
        let tail = this.tail, next = tail.shift();
        if (tail.isEmpty() && tail.next !== null)
            this.tail = tail.next, tail.next = null;
        return next;
    }
}
$ = {
    FixedQueue
};
return $;
})

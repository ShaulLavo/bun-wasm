// Generated from Bun a7733435cf40429e3b35c36072769df2052b80f1, src/js/internal/freelist.ts.
(function (intrinsics) {
"use strict";
var $;
class FreeList {
    name;
    max;
    ctor;
    list;
    constructor(name, max, ctor) {
        this.name = name, this.ctor = ctor, this.max = max, this.list = [];
    }
    alloc() {
        return this.list.length > 0 ? this.list.pop() : new this.ctor(...arguments);
    }
    free(obj) {
        if (this.list.length < this.max)
            return this.list.push(obj), !0;
        return !1;
    }
}
$ = FreeList;
return $;
})

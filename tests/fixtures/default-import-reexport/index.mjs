import EventEmitter, { EventEmitter as named } from "./cjs.mjs";
import snapshot, { renamed } from "./esm.mjs";
import { update } from "./lib.mjs";
console.log("constructor", typeof EventEmitter, named === EventEmitter);
console.log("static", named.EventEmitter === named);
console.log("before", snapshot, renamed);
update();
console.log("after", snapshot, renamed);

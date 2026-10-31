import assert from "node:assert/strict";
import { MessageChannel, MessagePort } from "node:worker_threads";

assert.throws(() => Reflect.apply(MessagePort, undefined, []), { constructor: TypeError, code: "ERR_CONSTRUCT_CALL_INVALID" });
assert.throws(() => Reflect.construct(MessagePort, []), { constructor: TypeError, code: "ERR_CONSTRUCT_CALL_INVALID" });
assert.throws(() => Reflect.construct(MessagePort, [{}]), { constructor: TypeError, code: "ERR_CONSTRUCT_CALL_INVALID" });
assert.throws(() => Reflect.apply(MessageChannel, undefined, []), { constructor: TypeError, code: "ERR_CONSTRUCT_CALL_REQUIRED" });
const channel = new MessageChannel();
assert.equal(channel.constructor, MessageChannel);
assert.equal(channel.port1.constructor, MessagePort);
assert.equal(channel.port1 instanceof MessagePort, true);
class Channel extends MessageChannel {}
const derived = new Channel();
assert.equal(derived.constructor, Channel);
assert.equal(derived.port1 instanceof MessagePort, true);
channel.port1.close();
channel.port2.close();
derived.port1.close();
derived.port2.close();
console.log("MessagePort and MessageChannel constructor errors and identity");


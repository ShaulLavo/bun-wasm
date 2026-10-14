const EventEmitter = require("events");
const { once, EventEmitter: Named } = require("events");
console.log("same class:", EventEmitter === Named);
class Bus extends EventEmitter {}
const bus = new Bus();
bus.on("msg", (a, b) => console.log("on:", a, b));
bus.prependListener("msg", () => console.log("prepended first"));
bus.once("msg", () => console.log("once only"));
bus.emit("msg", 1, 2);
bus.emit("msg", 3, 4);
console.log("listenerCount:", bus.listenerCount("msg"), "names:", bus.eventNames().join(","));
const handler = () => console.log("removed?");
bus.on("x", handler);
bus.off("x", handler);
console.log("emit returns:", bus.emit("x"), bus.emit("msg", 5, 6));
try {
  bus.emit("error", new Error("unhandled boom"));
} catch (err) {
  console.log("error event throws:", err.message);
}
bus.on("error", (err) => console.log("handled error:", err.message));
bus.emit("error", new Error("handled boom"));
bus.on("newListener", (name) => console.log("newListener:", name));
bus.on("late", () => {});
bus.removeAllListeners("msg");
console.log("after removeAll:", bus.listenerCount("msg"));
once(bus, "ready").then(([v]) => console.log("events.once:", v));
setTimeout(() => bus.emit("ready", "go"), 1);
console.log("defaultMaxListeners:", EventEmitter.defaultMaxListeners);

// error.stack begins with the error's "Name: message" header, as in Bun, then its frames.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { inspect } from "node:util";

function head(stack, lines = 1) {
  return typeof stack === "string" ? JSON.stringify(stack.split("\n").slice(0, lines).join("\n")) : `<${typeof stack}>`;
}
function hasFrames(stack, lines = 1) {
  return typeof stack === "string" && stack.split("\n").length > lines;
}
function show(label, stack, lines = 1) {
  console.log(`${label}: ${head(stack, lines)}${hasFrames(stack, lines) ? "" : " (no frames)"}`);
}

show("Error", new Error("boom").stack);
show("no message", new Error().stack);
show("empty message", new Error("").stack);
show("TypeError", new TypeError("bad type").stack);
show("RangeError", new RangeError("out").stack);
show("SyntaxError", new SyntaxError("s").stack);
show("Error() call", Error("called").stack);
class NamedInConstructor extends Error {
  constructor(message) { super(message); this.name = "NamedInConstructor"; }
}
show("subclass named in constructor", new NamedInConstructor("custom").stack);
class NamedOnPrototype extends Error {}
NamedOnPrototype.prototype.name = "NamedOnPrototype";
show("subclass named on prototype", new NamedOnPrototype("p").stack);
class Unnamed extends Error {}
show("unnamed subclass", new Unnamed("x").stack);
class SubTypeError extends TypeError {}
show("unnamed TypeError subclass", new SubTypeError("deep").stack);
class GetterName extends Error { get name() { return "GetterName"; } }
show("getter name", new GetterName("g").stack);
show("multi-line message", new Error("line one\nline two").stack, 2);

const changed = new Error("before");
changed.message = "after";
show("message changed before first read", changed.stack);
const read = new Error("first");
read.stack;
read.message = "second";
show("message changed after first read", read.stack);
const renamed = new Error("late");
renamed.name = "LateName";
show("name set before first read", renamed.stack);
const nameless = new Error("only message");
nameless.name = "";
show("empty name", nameless.stack);
const blank = new Error("");
blank.name = "";
show("empty name and message", blank.stack);
const numericName = new Error("n");
numericName.name = 42;
show("numeric name", numericName.stack);
const undefinedName = new Error("u");
undefinedName.name = undefined;
show("undefined name", undefinedName.stack);
const objectMessage = new Error("x");
objectMessage.message = { toString() { return "object"; } };
show("object message", objectMessage.stack);
const getterMessage = new Error("x");
Object.defineProperty(getterMessage, "message", { get() { return "getter message"; } });
show("getter message", getterMessage.stack);
const ownToString = new Error("plain");
ownToString.toString = () => "OVERRIDDEN";
show("own toString", ownToString.stack);
show("with cause", new Error("outer", { cause: new Error("inner") }).stack);
show("AggregateError", new AggregateError([new Error("a")], "many").stack);
show("AggregateError without message", new AggregateError([]).stack);

try { null.x; } catch (error) { console.log("engine TypeError header is String(error):", error.stack.split("\n")[0] === String(error)); }
try { missingVariable; } catch (error) { console.log("engine ReferenceError header is String(error):", error.stack.split("\n")[0] === String(error)); }
try { throw "a string"; } catch (error) { console.log("thrown string stack:", typeof error.stack); }
try { throw { message: "plain" }; } catch (error) { console.log("thrown object stack:", typeof error.stack); }

const plain = {};
Error.captureStackTrace(plain);
show("captureStackTrace on a plain object", plain.stack);
const named = { name: "Thing", message: "msg" };
Error.captureStackTrace(named);
show("captureStackTrace on a named object", named.stack);
const errorLike = Object.create(Error.prototype);
errorLike.message = "own";
Error.captureStackTrace(errorLike);
show("captureStackTrace on an Error.prototype object", errorLike.stack);
const recaptured = new Error("recapture");
recaptured.name = "Recaptured";
Error.captureStackTrace(recaptured);
recaptured.message = "recaptured later";
show("captureStackTrace on an error", recaptured.stack);
function construct() {
  class Custom extends Error {
    constructor() { super("captured in constructor"); this.name = "Custom"; Error.captureStackTrace(this, Custom); }
  }
  return new Custom();
}
show("captureStackTrace in a constructor", construct().stack);

const saved = Error.prepareStackTrace;
Error.prepareStackTrace = (error, sites) => `custom ${error.message} ${Array.isArray(sites)}`;
show("prepareStackTrace override", new Error("p").stack);
Error.prepareStackTrace = (error, sites) => saved(error, sites);
show("prepareStackTrace delegating to the default", new TypeError("delegated").stack);
Error.prepareStackTrace = saved;

const boom = new Error("printed once");
const count = text => text.split("\n").filter(line => line.includes("printed once")).length;
console.log("util.inspect header lines:", count(inspect(boom)));
console.log("Bun.inspect header lines:", count(Bun.inspect(boom)));
console.log("String(error) unchanged:", String(boom));

const proxied = new Error("proxied");
Object.setPrototypeOf(proxied, new Proxy(Error.prototype, { getOwnPropertyDescriptor() { throw new Error("trap ran"); } }));
let proxiedHeader;
try { proxiedHeader = head(proxied.stack); } catch (error) { proxiedHeader = `threw ${error.message}`; }
console.log("Proxy prototype:", proxiedHeader);
const fakeEvalPosition = stack => String(stack).split("\n").some(line => /<eval>:0:0|\(<eval>/.test(line));
console.log("eval frame has a fake position:", fakeEvalPosition(eval("new Error('from eval')").stack));
console.log("new Function frame has a fake position:", fakeEvalPosition(new Function("return new Error('from Function')")().stack));
console.log("eval frame shown:", String(eval("new Error('shown')").stack).split("\n").length > 1);

// A file reloaded with type-only lines added keeps its generated positions; its frame moves.
const require = createRequire(import.meta.url);
const reloadedPath = resolve("reloaded.ts");
const thrower = "export function thrower(count: number): number {\n  if (count > 0) throw new Error(\"reloaded\");\n  return count;\n}\n";
function reloadedFrame() {
  delete require.cache[reloadedPath];
  let stack = "";
  try { require(reloadedPath).thrower(1); } catch (error) { stack = String(error.stack); }
  return stack.split("\n").find(text => text.includes("reloaded.ts"))?.replace(/^.*reloaded\.ts:/, "reloaded.ts:");
}
writeFileSync(reloadedPath, thrower);
console.log("first load:", reloadedFrame());
writeFileSync(reloadedPath, "interface A { a: number }\ninterface B { b: string }\n" + thrower);
console.log("after reload:", reloadedFrame());

import assert from "node:assert/strict";
import { Script } from "node:vm";

interface NativeFrame { name: string | null; file: string; line: number; column: number; frameKind: number }
const hook: unknown = Reflect.get(globalThis, Symbol.for("bunwasm.internal.spidermonkey.errorFrames"));
if (typeof hook !== "function") throw new Error("native SavedFrame reader is unavailable");
function nativeFrames(error: Error): NativeFrame[] {
  return Reflect.apply(hook, undefined, [error, error.stack, true]);
}
const prefix = "(function () { return ";
for (const order of [[1, 2], [2, 1]]) {
  const frames = order.map(kind => {
    const source = kind === 1 ? " ".repeat(prefix.length) + 'new Error("same")' : prefix + 'new Error("same"); })()';
    const error = new Script(source, { filename: `/capture-${order[0]}.ts` }).runInThisContext();
    const first = nativeFrames(error)[0];
    assert.equal(first.name, null);
    assert.equal(first.frameKind, kind);
    const saved = Error.prepareStackTrace;
    try {
      Error.prepareStackTrace = (_target, sites) => {
        const site = sites[0];
        assert.equal(site.getFunctionName(), null);
        assert.equal(site.getFunction(), undefined);
        const location = `${site.getFileName()}:${site.getLineNumber()}:${site.getColumnNumber()}`;
        const expected = kind === 2 ? `<anonymous> (${location})` : location;
        assert.equal(site.toString(), expected);
        assert.equal(String(site), expected);
        return sites;
      };
      // Use a fresh Error so the custom formatter owns its first stack access.
      const fresh = new Script(source, { filename: `/capture-${order[0]}.ts` }).runInThisContext();
      assert(Array.isArray(fresh.stack));
    } finally { Error.prepareStackTrace = saved; }
    return first;
  });
  const { frameKind: _firstKind, ...first } = frames[0];
  const { frameKind: _secondKind, ...second } = frames[1];
  assert.deepEqual(first, second);
  assert.equal(frames[0].file, frames[1].file);
  assert.equal(frames[0].line, frames[1].line);
  assert.equal(frames[0].column, frames[1].column);
}
for (const [source, kind, name] of [
  ['eval("new Error()")', 1, null], ['(0,eval)("new Error()")', 1, null],
  ['(function named(){return new Error()})()', 2, "named"],
  ['new (function(){return new Error()})()', 2, null],
  ['Function("return new Error()")()', 2, "anonymous"],
] satisfies [string, number, string | null][]) {
  const error = new Script(source, { filename: "/categories.ts" }).runInThisContext();
  const frame = nativeFrames(error)[0];
  assert.equal(frame.frameKind, kind);
  assert.equal(frame.name, name);
}
console.log("Capture kind preserves null names and distinguishes same-position Function and Program presentation");

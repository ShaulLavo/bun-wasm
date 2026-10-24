import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript-api";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-core-adapters-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function emit(name: string, compact = false) {
  const output = join(scratch, `${name}-${compact ? "compact" : "stripped"}.js`);
  const command = compact ? "bun" : "node";
  const args = [command, join(root, "scripts/transpile-runtime.ts"), join(root, `crates/bunwasm-runtime/src/js/${name}.ts`), output];
  if (compact) args.push("--minify-whitespace");
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return readFileSync(output, "utf8");
}

function thrownName(action: () => unknown) {
  try {
    action();
  } catch (error) {
    return error && typeof error === "object" && "name" in error ? error.name : undefined;
  }
  return undefined;
}

function syntaxHash(source: string) {
  const file = ts.createSourceFile("runtime.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function syntax(node: ts.Node): unknown {
    const children = node.getChildren(file).filter(child => child.kind !== ts.SyntaxKind.EndOfFileToken
      && !(ts.isArrowFunction(node) && (child.kind === ts.SyntaxKind.OpenParenToken || child.kind === ts.SyntaxKind.CloseParenToken)));
    return [node.kind, children.length ? children.map(syntax) : node.getText(file)];
  }
  return createHash("sha256").update(JSON.stringify(syntax(file))).digest("hex");
}

// Hashes come from the JavaScript factories at 23e2125d. Ignore only arrow-parameter parentheses.
const originalTokens = {
  stack_trace: "749819b642caac17947531faaa802271feac2fd7219af4d271c3a8d25f5cf1db",
  bun_builtins: "58e3de8a4232bc992b2b483d817198d6f020bedafc8220c3a1903d4f360f3bbe",
};
const originalEmbeddedBytes = { stack_trace: 4330, bun_builtins: 4092 };
for (const [name, hash] of Object.entries(originalTokens)) {
  test(`stripped ${name} keeps every original executable token`, () => {
    expect(syntaxHash(emit(name))).toBe(hash);
  });

  test(`embedded ${name} does not grow after TypeScript erasure`, () => {
    expect(Buffer.byteLength(emit(name, true))).toBeLessThanOrEqual(originalEmbeddedBytes[name as keyof typeof originalEmbeddedBytes]);
  });
}

test("compact factories preserve strict classic-script semantics", () => {
  for (const name of Object.keys(originalTokens)) {
    const source = emit(name, true);
    expect(thrownName(() => runInNewContext(`(function () { return (${source}).caller; })()`))).toBe("TypeError");
  }

  const source = emit("stack_trace", true);
  expect(thrownName(() => runInNewContext(`(function () {
    (${source})({ native: { engine: "jsc" }, defineHidden: Object.assign });
    return Error.captureStackTrace.caller;
  })()`))).toBe("TypeError");
});

test("emitted builtin loader keeps caches, private symbols and unsupported errors", () => {
  const factory = runInNewContext(emit("bun_builtins", true));
  let evaluations = 0;
  const builtin = { fallback: true };
  const loader = factory({
    bunBuiltinGlobals: { Array, Error, Function, Map, Object, Proxy, RangeError, Reflect, Set, String, Symbol, TypeError, URIError },
    native: {
      bunBuiltinNames: () => ["selected", "node:fallback", "cycle"],
      bunBuiltinSource: (id: number) => id === 1 ? undefined : String(id),
      bunBuiltinHookName: () => "js2native_wrap_missing",
      bunBuiltinErrorCode: () => "ERR_INVALID_URI",
      evalScript(source: string) {
        evaluations++;
        if (source === "2") return (hooks: { createInternalModuleById(id: number): unknown }) => hooks.createInternalModuleById(2);
        return (hooks: Record<string, unknown>) => hooks;
      },
    },
    builtin: () => builtin,
  });
  const hooks = loader.require("selected");
  expect(loader.require(0)).toBe(hooks);
  expect(loader.require("node:fallback")).toBe(builtin);
  expect(evaluations).toBe(1);
  const target = {};
  hooks.putByIdDirectPrivate(target, "key", 7);
  expect(hooks.getByIdDirectPrivate(target, "key")).toBe(7);
  expect(hooks.privateName("key")).toBe(hooks.privateName("key"));
  expect(Object.keys(target)).toEqual([]);
  expect(hooks.makeErrorWithCode(0)).toMatchObject({ name: "URIError", code: "ERR_INVALID_URI" });
  expect(() => hooks.lazy(0)()).toThrow("not implemented");
  expect(() => loader.require("missing")).toThrow("module -1");
  expect(() => loader.require("cycle")).toThrow("circular initialization of cycle");
  expect(() => hooks.missingIntrinsic).toThrow("intrinsic $missingIntrinsic");
});

test("emitted stack adapter leaves host hooks intact", () => {
  const context = { internal: { native: { engine: "host" }, defineHidden: Object.assign } };
  const source = emit("stack_trace", true);
  expect(runInNewContext(`const capture = Error.captureStackTrace; (${source})(internal); Error.captureStackTrace === capture`, context)).toBe(true);
});

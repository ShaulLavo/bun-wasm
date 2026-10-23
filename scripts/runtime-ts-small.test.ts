import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript-api";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-ts-small-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Hash the original JavaScript AST at e0c85f29, or ac43127c for websocket. Ignore only redundant expression parentheses.
const originals = {
  websocket: "dc216befcf12f2d82ced593f19185a9e74c97e65c72fbe48b84ccb0bc882d795",
  cookie: "5cc1305618ad7b836b36694847306b57aa21a4a6d8bd977ffd3e5901cc21b34f",
  formats: "2e6b5465d602987a9a0a5a455d7ced74ab893db48fc4617cb23cd89d24bae930",
  intl: "74d0927e7dbc59c832d8ede9a6ec7e7ff6a220cd6aa077ed17fc2abff6d66c24",
};

function syntax(text: string): string {
  const source = ts.createSourceFile("runtime.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node: ts.Node): unknown {
    if (ts.isParenthesizedExpression(node)) return visit(node.expression);
    const children = node.getChildren(source);
    return children.length ? [node.kind, children.map(visit)] : [node.kind, node.getText(source)];
  }
  return JSON.stringify(visit(source));
}

for (const [name, hash] of Object.entries(originals)) {
  test(`${name} embeds the original runtime syntax, including strict directives`, () => {
    const output = join(scratch, `${name}.js`);
    const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(root, `crates/bunwasm-runtime/src/js/${name}.ts`), output]);
    expect(result.exitCode).toBe(0);
    const emitted = readFileSync(output, "utf8");
    expect(createHash("sha256").update(syntax(emitted)).digest("hex")).toBe(hash);
  });
}

test("preview bundles the shared typed WebSocket factory", async () => {
  const { previewWebsocketScript } = await import("../web/preview-build");
  const source = await previewWebsocketScript();
  expect(new Bun.Transpiler({ loader: "js" }).scan(source).imports).toEqual([]);
  expect(source).toContain("Invalid WebSocket handshake");
});

test("WebSocket rejects unsupported TLS options before native connection or header access", async () => {
  const { runInNewContext } = await import("node:vm");
  const output = join(scratch, "websocket-controls.js");
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(root, "crates/bunwasm-runtime/src/js/websocket.ts"), output]);
  expect(result.exitCode).toBe(0);
  const factory: (internal: object) => { clientClass(connection: unknown): new(input: string, options?: object) => object } = runInNewContext(readFileSync(output, "utf8"), {
    TextEncoder, TextDecoder, EventTarget, URL, SyntaxError, Error,
  });
  const runtime = factory({ require: () => ({ Buffer }), native: { hostConnect() { throw new Error("unexpected native connection"); } } });
  const Socket = runtime.clientClass(class {});
  expect(() => new Socket("wss://127.0.0.1/")).toThrow("WebSocket requires a ws:// URL without credentials or a fragment");
  const options = { tls: {}, get headers() { throw new Error("headers read too early"); } };
  expect(() => new Socket("ws://127.0.0.1/", options)).toThrow("WebSocket proxy and TLS options are not supported by this networking host");
  expect(() => new Socket("ws://127.0.0.1/", { proxy: "fixture" })).toThrow("WebSocket proxy and TLS options are not supported by this networking host");
});

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript-api";

const root = resolve(import.meta.dir, "..");
const js = "crates/bunwasm-runtime/src/js/";

function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(resolve(root, path), "utf8"), ts.ScriptTarget.Latest, true);
}

function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined {
  if (predicate(node)) return node;
  return ts.forEachChild(node, child => find(child, predicate));
}

function digest(node: ts.Node, file: ts.SourceFile): string {
  function syntax(value: ts.Node): unknown {
    const children = value.getChildren(file);
    return children.length ? [value.kind, children.map(syntax)] : [value.kind, value.getText(file)];
  }
  return createHash("sha256").update(JSON.stringify(syntax(node))).digest("hex");
}

// Frozen PR128 syntax, not an execution or worker-delivery qualification.
const contracts = [
  ["bootstrap.js", "if (!native.exists(path))", "54de86a480dee49d3180c5390987a33122e52f559f4b11e70c75de93d0dd23e0"],
  ["builtins.js", '"node:trace_events":', "5caeb9e11d9cf86c20bd64a1ae96a45935f1af075b45f555608148b0dff89f26"],
  ["process.ts", "execve()", "3fd2f8decd0e15737125d817e3f7c80644b13b09da43e740ec1ebc19d61cb5c6"],
  ["process.ts", "execveWarned =", "76cb34635f1a5847bf8d957f8dd96445175fa217de83b93c18cbe04147a84e12"],
] as const;

for (const [path, prefix, expected] of contracts) {
  test(`residual syntax matches the accepted source: ${path} ${prefix}`, () => {
    const file = source(js + path);
    const node = find(file, value => value.getText(file).startsWith(prefix));
    expect(node).toBeDefined();
    if (!node) throw new Error(`Missing source contract: ${prefix}`);
    expect(digest(node, file)).toBe(expected);
  });
}

test("the Rust builtin table registers trace_events exactly once between tls and tty", () => {
  const text = readFileSync(resolve(root, "crates/bunwasm-runtime/src/resolve.rs"), "utf8");
  const table = text.match(/pub const NODE_BUILTINS: &\[&str\] = &\[([^\]]+)\];/)?.[1];
  expect(table).toBeDefined();
  const names = Array.from((table ?? "").matchAll(/"([^"]+)"/g), match => match[1]);
  expect(names.filter(name => name === "trace_events")).toHaveLength(1);
  expect(names.slice(names.indexOf("trace_events") - 1, names.indexOf("trace_events") + 2)).toEqual(["tls", "trace_events", "tty"]);
});

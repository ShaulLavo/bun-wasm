import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript-api";

function deepBlocks(file: string, scope?: string): string[] {
  const root = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const failures: string[] = [];
  let found = scope === undefined;
  function visit(node: ts.Node, depth: number, selected: boolean) {
    const match = ts.isFunctionDeclaration(node) && node.name?.text === scope;
    const withinScope = selected || match;
    if (match) found = true;
    const block = ts.isBlock(node) || ts.isCaseBlock(node);
    const next = depth + Number(block);
    if (block && next > 3 && withinScope) failures.push(`${file}:${root.getLineAndCharacterOfPosition(node.getStart(root)).line + 1}: depth ${next}`);
    ts.forEachChild(node, child => visit(child, next, withinScope));
  }
  visit(root, 0, scope === undefined);
  if (!found) failures.push(`${file}: missing function ${scope}`);
  return failures;
}

test("Next cleanup and observer code stays within three block levels", () => {
  const paths = ["../examples/frameworks/lifetime.ts", "../web/tests/next-framework-native.ts", "../web/tests/next-framework-browser.ts", "../web/tests/next-framework-process.ts", "../web/tests/next-framework-sockets.ts", "../web/tests/next-framework-process.test.ts", "next-framework-nesting.test.ts", "../web/tests/browser-next-sockets.ts", "../examples/frameworks/lifecycle.test.ts"];
  const failures = paths.flatMap(path => deepBlocks(new URL(path, import.meta.url).pathname));
  expect(failures).toEqual([]);
});


test("production VM functions stay within three block levels in their registry", () => {
  const path = new URL("../crates/bunwasm-runtime/src/js/builtins.js", import.meta.url).pathname;
  expect(deepBlocks(path, "vmModule")).toEqual([]);
});

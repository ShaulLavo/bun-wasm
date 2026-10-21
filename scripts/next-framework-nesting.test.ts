import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript-api";

function deepBlocks(file: string): string[] {
  const root = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const failures: string[] = [];
  function visit(node: ts.Node, depth: number) {
    const block = ts.isBlock(node) || ts.isCaseBlock(node);
    const next = depth + Number(block);
    if (block && next > 3) failures.push(`${file}:${root.getLineAndCharacterOfPosition(node.getStart(root)).line + 1}: depth ${next}`);
    ts.forEachChild(node, child => visit(child, next));
  }
  visit(root, 0);
  return failures;
}

test("Next cleanup and observer code stays within three block levels", () => {
  const paths = ["../examples/frameworks/lifetime.ts", "../web/tests/next-framework-native.ts", "../web/tests/next-framework-browser.ts", "../web/tests/next-framework-process.ts", "../web/tests/next-framework-sockets.ts", "../web/tests/next-framework-process.test.ts", "next-framework-nesting.test.ts", "../web/tests/browser-next-sockets.ts", "../examples/frameworks/lifecycle.test.ts"];
  const failures = paths.flatMap(path => deepBlocks(new URL(path, import.meta.url).pathname));
  expect(failures).toEqual([]);
});

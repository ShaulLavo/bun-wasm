import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript-api";
import { checkCommand, discoverChecks, nativeGroups, selectChecks } from "./test-checks";

const root = resolve(import.meta.dir, "..");
const fixtures = ["package-script-dispatch", "package-script-behavior"];
const commands = [
  "evaluate", "print", "cli-flags", "ok", "nodejs-file", "nodejs-eval",
  "nodejs-named-file", "bun-file", "bun-alias", "node-file", "node-alias-file",
  "test", "failed-test", "exit", "nodejs-exit", "shell-syntax", "hooked",
  "--silent exit", "alias", "bin-script", "env-bin", "tool",
];

function literal(node: ts.Node | undefined): string {
  if (!node || !ts.isStringLiteral(node)) throw new Error("Expected a literal dispatch case");
  return node.text;
}

type Fixture = { calls: string[]; assertions: string[] };

function commandRow(node: ts.Expression): string {
  if (!ts.isArrayLiteralExpression(node)) throw new Error("Expected command and output pair");
  return literal(node.elements[0]);
}

function inspectCall(node: ts.CallExpression, source: ts.SourceFile, fixture: Fixture) {
  const callee = node.expression.getText(source);
  const argument = node.arguments[0];
  if (callee === "run" && argument && ts.isStringLiteral(argument)) fixture.calls.push(literal(argument));
  if (callee === "tracedSpawnSync" && argument && ts.isArrayLiteralExpression(argument)) {
    fixture.calls.push(argument.elements.slice(2).map(literal).join(" "));
  }
  if (callee.startsWith("assert.")) fixture.assertions.push(node.getText(source));
}

function visit(node: ts.Node, source: ts.SourceFile, fixture: Fixture) {
  if (ts.isForOfStatement(node) && ts.isArrayLiteralExpression(node.expression)) {
    fixture.calls.push(...node.expression.elements.map(commandRow));
  }
  if (ts.isCallExpression(node)) inspectCall(node, source, fixture);
  ts.forEachChild(node, child => visit(child, source, fixture));
}

function inspectFixture(name: string): Fixture {
  const path = join(root, "tests/fixtures", name, "index.ts");
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const fixture: Fixture = { calls: [], assertions: [] };
  visit(source, source, fixture);
  return fixture;
}

test("package dispatch cases fit independent fixture deadlines without dropping or repeating commands", () => {
  expect(inspectFixture("package-script-dispatch").calls.length).toBeLessThanOrEqual(11);
  const cases = fixtures.map(inspectFixture);
  expect(cases.map(fixture => fixture.calls.length)).toEqual([11, 11]);
  expect(cases.flatMap(fixture => fixture.calls)).toEqual(commands);
  expect(new Set(cases.flatMap(fixture => fixture.calls)).size).toBe(22);
});

test("each package fixture retains one blocking native owner and needs no extra build", () => {
  const checks = discoverChecks();
  const paths = fixtures.map(name => `tests/fixtures/${name}`);
  for (const path of paths) expect(checks.filter(check => check.path === path).map(check => check.owner)).toEqual(["native"]);
  expect(checkCommand("native", paths).slice(0, 3)).toEqual(["bash", join(root, "scripts/test.sh"), "--no-build"]);
  const groups = nativeGroups(selectChecks("native", checks), 4);
  expect(groups.flat().filter(path => paths.includes(path)).toSorted()).toEqual(paths.toSorted());
  expect(readFileSync(join(root, "scripts/test.sh"), "utf8").match(/timeout --kill-after=5s 60 /g)).toHaveLength(2);
});

test("the split retains every original output, argv, environment, hook, silence and status assertion", () => {
  expect(fixtures.flatMap(name => inspectFixture(name).assertions)).toEqual([
    "assert.equal(child.exitCode, 0, child.stderr.toString())",
    "assert.equal(child.stdout.toString().trim(), output, name)",
    "assert.equal(passed.exitCode, 0, passed.stderr.toString())",
    "assert.equal(passed.stdout.toString().trim().split(\"\\n\").filter(line => line === \"test once\").length, 1)",
    "assert.equal(failed.exitCode, 1, failed.stderr.toString())",
    "assert.equal(run(\"exit\").exitCode, 17)",
    "assert.equal(run(\"nodejs-exit\").exitCode, 17)",
    "assert.equal(syntax.exitCode, 0, syntax.stderr.toString())",
    "assert.equal(syntax.stdout.toString(), \"one\\nTWO SHELL-SYNTAX\\nthree\\n\")",
    "assert.equal(hooked.stdout.toString(), \"pre\\nmain\\npost\\n\")",
    "assert.equal(hooked.stderr.toString(), \"$ echo pre\\n$ echo main\\n$ echo post\\n\")",
    "assert.equal(silent.exitCode, 17)",
    "assert.equal(silent.stderr.toString(), \"\")",
    "assert.equal(inspected.exitCode, 0, inspected.stderr.toString())",
    "assert.equal(inspected.stdout.toString().trim(), \"inspect second|first|tail outer inner true\")",
    "assert.equal(binary.exitCode, 0, binary.stderr.toString())",
    "assert.equal(binary.stdout.toString().trim(), \"installed baked|tail\")",
    "assert.equal(viaEnv.exitCode, 0, viaEnv.stderr.toString())",
    "assert.equal(viaEnv.stdout.toString().trim(), \"env baked|tail\")",
    "assert.equal(entry.exitCode, 0, entry.stderr.toString())",
    "assert.equal(entry.stdout.toString().trim(), \"local\")"
  ]);
});

test("both fixtures keep the same package namespace and support files", () => {
  const files = ["package.json", "app.ts", "failure.test.ts", "inspect", "inspect.ts", "manual", "sample.test.ts", "test", "upper.ts"];
  for (const file of files) {
    const original = readFileSync(join(root, "tests/fixtures/package-script-dispatch", file), "utf8");
    expect(readFileSync(join(root, "tests/fixtures/package-script-behavior", file), "utf8")).toBe(original);
  }
});

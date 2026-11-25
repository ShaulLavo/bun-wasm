import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript-api";
import { discoverChecks } from "./test-checks";

const root = resolve(import.meta.dir, "..");
const scannedRoots = ["web/tests", "web/guest-tests", "scripts", "sandbox/tests", "tests"] as const;
const sourceExtension = /\.[cm]?[jt]sx?$/;
const skippedDirs = new Set(["node_modules", "dist", "target", ".git"]);
const selfPath = "scripts/mode-memory-allowlist.test.ts";

/**
 * Only tests whose explicit purpose is verifying `?mode=memory` (or dynamic `?mode=` selection)
 * may appear here. Non-memory browser and unit tests must exercise the default persistent FS.
 */
const MODE_MEMORY_ALLOWLIST: Readonly<Record<string, string>> = {
  "scripts/goals-matrix/run.ts": "Supports optional mode?: \"fast\" | \"memory\" query parameter (defaults to persistent when omitted).",
  "scripts/goals-matrix/run.test.ts": "Unit-tests the optional mode: \"memory\" override in playgroundURL while asserting default is persistent.",
  "scripts/multitab-browser.test.ts": "Verifies same-port preview body isolation between two ?mode=memory tabs alongside persistent multi-tab tests.",
  "web/tests/browser-editor.ts": "filesystemInfoCheck and unsupportedModeCheck explicitly test memory, fast, default, and unsupported ?mode= values.",
  "web/tests/browser-startup-mode.ts": "Explicitly tests startup storage modes (safe, invalid, memory volatility, and default fast persistence).",
  "web/tests/playground-start-fresh.test.ts": "Explicitly verifies that a ?mode=memory startup failure offers no Start fresh button.",
};

const literalModeMemory = /(?:^|[?&])mode=memory(?=$|[^a-z0-9_-])/i;
const dynamicModeQuery = /(?:^|[?&])mode=$/i;
const nonMemoryModes = new Set(["fast", "safe", "invalid"]);

function isStringLiteral(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function methodName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
  return undefined;
}

function staticText(node: ts.Expression): string | undefined {
  if (isStringLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  return undefined;
}

function isDisallowedModeValue(node: ts.Expression): boolean {
  const value = staticText(node)?.toLowerCase();
  if (value === undefined) return true;
  return !nonMemoryModes.has(value);
}

function location(source: ts.SourceFile, node: ts.Node): string {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${line + 1}:${character + 1}`;
}

function checkTemplateExpression(source: ts.SourceFile, node: ts.TemplateExpression, file: string, findings: string[]): void {
  if (literalModeMemory.test(node.head.text) || dynamicModeQuery.test(node.head.text)) {
    findings.push(`${file}:${location(source, node.head)}: template literal sets URL mode=memory or dynamic mode=`);
  }
  for (const span of node.templateSpans) {
    const text = span.literal.text;
    const isLast = span === node.templateSpans[node.templateSpans.length - 1];
    if (literalModeMemory.test(text) || (!isLast && dynamicModeQuery.test(text))) {
      findings.push(`${file}:${location(source, span.literal)}: template literal sets URL mode=memory or dynamic mode=`);
    }
  }
}

function checkCallExpression(source: ts.SourceFile, node: ts.CallExpression, file: string, findings: string[]): void {
  const name = methodName(node.expression);
  if ((name === "set" || name === "append") && node.arguments.length >= 2) {
    if (staticText(node.arguments[0]!) === "mode" && isDisallowedModeValue(node.arguments[1]!)) {
      findings.push(`${file}:${location(source, node)}: ${name}("mode", ...) sets memory or dynamic mode`);
    }
    return;
  }
  if (name === "playgroundURL" && node.arguments.length >= 5 && isDisallowedModeValue(node.arguments[4]!)) {
    findings.push(`${file}:${location(source, node)}: playgroundURL(..., mode) sets memory or dynamic mode`);
  }
}

function hasDisallowedModeProp(expr: ts.ObjectLiteralExpression): boolean {
  for (const prop of expr.properties) {
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "mode") return true;
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name) || isStringLiteral(prop.name) ? prop.name.text : undefined;
    if (key === "mode" && isDisallowedModeValue(prop.initializer)) return true;
  }
  return false;
}

function hasDisallowedModeTuple(expr: ts.ArrayLiteralExpression): boolean {
  for (const elem of expr.elements) {
    if (!ts.isArrayLiteralExpression(elem) || elem.elements.length < 2) continue;
    if (staticText(elem.elements[0]!) === "mode" && isDisallowedModeValue(elem.elements[1]!)) return true;
  }
  return false;
}

function checkNewExpression(source: ts.SourceFile, node: ts.NewExpression, file: string, findings: string[]): void {
  if (methodName(node.expression) !== "URLSearchParams" || !node.arguments?.length) return;
  const arg = node.arguments[0]!;
  if (ts.isObjectLiteralExpression(arg) && hasDisallowedModeProp(arg)) {
    findings.push(`${file}:${location(source, node)}: new URLSearchParams({ mode: ... })`);
  } else if (ts.isArrayLiteralExpression(arg) && hasDisallowedModeTuple(arg)) {
    findings.push(`${file}:${location(source, node)}: new URLSearchParams([["mode", ...]])`);
  }
}

function checkConcatenation(source: ts.SourceFile, node: ts.BinaryExpression, file: string, findings: string[]): void {
  if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return;
  const left = staticText(node.left);
  if (left !== undefined && dynamicModeQuery.test(left) && isDisallowedModeValue(node.right)) {
    findings.push(`${file}:${location(source, node)}: concatenated mode= with memory or dynamic mode`);
    return;
  }
  const combined = staticText(node);
  if (combined === undefined || !literalModeMemory.test(combined)) return;
  const right = staticText(node.right);
  if ((left !== undefined && literalModeMemory.test(left)) || (right !== undefined && literalModeMemory.test(right))) return;
  findings.push(`${file}:${location(source, node)}: concatenated mode=memory`);
}

const fastPreFilter = /mode=|["'`]mode["'`]|URLSearchParams|playgroundURL/i;

export function findModeMemoryUses(file: string, text: string): string[] {
  if (!fastPreFilter.test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings: string[] = [];
  function visit(node: ts.Node): void {
    if (isStringLiteral(node) && literalModeMemory.test(node.text)) {
      findings.push(`${file}:${location(source, node)}: literal ${JSON.stringify(node.text)}`);
    } else if (ts.isBinaryExpression(node)) {
      checkConcatenation(source, node, file, findings);
    } else if (ts.isTemplateExpression(node)) {
      checkTemplateExpression(source, node, file, findings);
    } else if (ts.isCallExpression(node)) {
      checkCallExpression(source, node, file, findings);
    } else if (ts.isNewExpression(node)) {
      checkNewExpression(source, node, file, findings);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}

function walkSourceFiles(directory: string, out: string[]): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (skippedDirs.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (entry.isFile() && sourceExtension.test(entry.name)) {
      out.push(full);
    }
  }
}

test("only allowlisted memory-mode tests may pass mode=memory", () => {
  const files: string[] = [];
  for (const dir of scannedRoots) walkSourceFiles(join(root, dir), files);
  const matched = new Map<string, string[]>();
  for (const full of files.toSorted()) {
    const rel = relative(root, full).replaceAll("\\", "/");
    if (rel === selfPath) continue;
    const uses = findModeMemoryUses(rel, readFileSync(full, "utf8"));
    if (uses.length > 0) matched.set(rel, uses);
  }

  const unexpected: string[] = [];
  for (const [file, uses] of matched) {
    if (!(file in MODE_MEMORY_ALLOWLIST)) {
      for (const use of uses) unexpected.push(use);
    }
  }
  expect(unexpected, "Unallowlisted mode=memory usage detected; migrate to default persistent FS or justify in MODE_MEMORY_ALLOWLIST").toEqual([]);

  for (const [file, reason] of Object.entries(MODE_MEMORY_ALLOWLIST)) {
    expect(reason.trim().length, `Missing reason for ${file}`).toBeGreaterThan(0);
    expect(existsSync(join(root, file)), `Stale allowlist entry (file deleted): ${file}`).toBe(true);
    expect(matched.has(file), `Stale allowlist entry (no longer uses mode=memory): ${file}`).toBe(true);
  }
}, 30_000);

test("mode=memory detector catches static, dynamic, embedded, and API escape hatches while ignoring comments and fast mode", () => {
  expect(findModeMemoryUses("probe.ts", 'page.goto(`${base}?engine=browser&mode=memory`)')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'page.goto("http://127.0.0.1/?mode=memory")')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const script = `new Playground("?engine=quickjs&mode=memory")`;')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'page.goto(`${base}?mode=${mode}`)')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const q = "?mode=" + mode;')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const q = "?mode=" + "memory";')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'url.searchParams.set("mode", "memory");')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'url.searchParams.set("mode", selected);')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'params.append("mode", "memory");')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'new URLSearchParams({ mode: "memory" });')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'new URLSearchParams({ mode });')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'new URLSearchParams([["mode", "memory"]]);')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'playgroundURL(base, fw, "browser", undefined, "memory");')).toHaveLength(1);

  expect(findModeMemoryUses("probe.ts", '// Default persistent IndexedDB (not mode=memory)\npage.goto(`${base}?engine=browser`);')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", '/* no mode=memory */\npage.goto("http://127.0.0.1/?mode=fast");')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'url.searchParams.set("mode", "fast");')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'new URLSearchParams({ mode: "fast" });')).toEqual([]);
});

test("mode=memory allowlist check is registered under the blocking quality owner", () => {
  expect(discoverChecks().filter(check => check.path === selfPath).map(check => check.owner)).toEqual(["quality"]);
});

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

interface AllowlistRule {
  readonly scope: string;
  readonly count: number;
  readonly reason: string;
}

export interface ModeMemoryFinding {
  readonly file: string;
  readonly location: string;
  readonly scope: string;
  readonly message: string;
}

/**
 * Only specific functions/tests whose explicit purpose is verifying `?mode=memory` or dynamic
 * `?mode=` handling may appear here, pinned by scope name and exact usage count. Non-memory
 * browser and unit tests (and even other tests in these same files) must exercise the default
 * persistent IndexedDB filesystem.
 */
const MODE_MEMORY_ALLOWLIST: Readonly<Record<string, readonly AllowlistRule[]>> = {
  "scripts/multitab-browser.test.ts": [
    {
      scope: "verifyMemoryModePreviewIsolation",
      count: 2,
      reason: "Verifies same-port preview body isolation between two ?mode=memory tabs alongside persistent multi-tab tests.",
    },
  ],
  "web/tests/browser-editor.ts": [
    {
      scope: "filesystemInfoCheck",
      count: 1,
      reason: "Explicitly tests memory, fast, and default ?mode= values.",
    },
    {
      scope: "unsupportedModeCheck",
      count: 1,
      reason: "Explicitly tests unsupported ?mode= values (safe, invalid).",
    },
  ],
  "web/tests/browser-startup-mode.ts": [
    {
      scope: "checkUnsupportedMode",
      count: 1,
      reason: "Explicitly tests unsupported ?mode= values (safe, invalid).",
    },
    {
      scope: "checkModes",
      count: 1,
      reason: "Explicitly tests ?mode=memory volatility on reload before verifying default persistent mode.",
    },
  ],
  "web/tests/playground-start-fresh.test.ts": [
    {
      scope: 'test("a startup failure with a readable workspace offers no Start fresh")',
      count: 1,
      reason: "Explicitly verifies that a ?mode=memory startup failure offers no Start fresh button.",
    },
  ],
};

const literalModeMemory = /(?:^|[?&])mode=memory(?=$|[^a-z0-9_-])/i;
const dynamicModeQuery = /(?:^|[?&])mode=$/i;
const nonMemoryModes = new Set(["fast", "safe", "invalid"]);
const queryParamNameHint = /search|param|query/i;
const nonQueryCollectionNames = new Set(["Map", "Headers", "FormData", "Set", "WeakMap"]);

interface FileBindings {
  readonly allBindings: Map<string, ts.Expression[]>;
  readonly uniqueConsts: Map<string, ts.Expression>;
  readonly queryParamVars: Set<string>;
  readonly nonQueryParamVars: Set<string>;
}

function isStringLiteral(node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function methodName(node: ts.Expression): string | undefined {
  const target = unwrap(node);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target) && isStringLiteral(target.argumentExpression)) {
    return target.argumentExpression.text;
  }
  return undefined;
}

function isSearchParamsExpr(expr: ts.Expression): boolean {
  const target = unwrap(expr);
  if (ts.isPropertyAccessExpression(target) && target.name.text === "searchParams") return true;
  if (ts.isNewExpression(target) && methodName(target.expression) === "URLSearchParams") return true;
  return false;
}

function isNonQueryCollectionExpr(expr: ts.Expression): boolean {
  const target = unwrap(expr);
  const name = ts.isNewExpression(target) ? methodName(target.expression) : undefined;
  return name !== undefined && nonQueryCollectionNames.has(name);
}

function collectBindings(source: ts.SourceFile): FileBindings {
  const allBindings = new Map<string, ts.Expression[]>();
  const constCounts = new Map<string, number>();
  const constCandidate = new Map<string, ts.Expression>();
  const queryParamVars = new Set<string>();
  const nonQueryParamVars = new Set<string>();

  function recordBinding(name: string, init: ts.Expression, isConst: boolean): void {
    const existing = allBindings.get(name) ?? [];
    existing.push(init);
    allBindings.set(name, existing);
    const nextCount = (constCounts.get(name) ?? 0) + 1;
    constCounts.set(name, nextCount);
    if (isConst && nextCount === 1) constCandidate.set(name, init);
    else constCandidate.delete(name);
    if (isSearchParamsExpr(init)) queryParamVars.add(name);
    if (isNonQueryCollectionExpr(init)) nonQueryParamVars.add(name);
  }

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      if (node.type && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName)) {
        if (node.type.typeName.text === "URLSearchParams") queryParamVars.add(name);
        else if (nonQueryCollectionNames.has(node.type.typeName.text)) nonQueryParamVars.add(name);
      }
      if (node.initializer) {
        const isConst = Boolean(node.parent && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const));
        recordBinding(name, node.initializer, isConst);
      }
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName)) {
      if (node.type.typeName.text === "URLSearchParams") queryParamVars.add(node.name.text);
      else if (nonQueryCollectionNames.has(node.type.typeName.text)) nonQueryParamVars.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { allBindings, uniqueConsts: constCandidate, queryParamVars, nonQueryParamVars };
}

function staticText(node: ts.Expression, env: FileBindings, seen = new Set<string>()): string | undefined {
  const target = unwrap(node);
  if (isStringLiteral(target)) return target.text;
  if (ts.isIdentifier(target)) {
    if (seen.has(target.text)) return undefined;
    const init = env.uniqueConsts.get(target.text);
    if (!init) return undefined;
    const next = new Set(seen);
    next.add(target.text);
    return staticText(init, env, next);
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(target.left, env, seen);
    const right = staticText(target.right, env, seen);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  if (ts.isTemplateExpression(target)) {
    let out = target.head.text;
    for (const span of target.templateSpans) {
      const part = staticText(span.expression, env, seen);
      if (part === undefined) return undefined;
      out += part + span.literal.text;
    }
    return out;
  }
  return undefined;
}

function isDisallowedModeValue(node: ts.Expression, env: FileBindings): boolean {
  const value = staticText(node, env)?.toLowerCase();
  if (value === undefined) return true;
  return !nonMemoryModes.has(value);
}

function location(source: ts.SourceFile, node: ts.Node): string {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${line + 1}:${character + 1}`;
}

function testCallLabel(node: ts.CallExpression): string | undefined {
  const name = methodName(node.expression);
  if (name !== "test" && name !== "it") return undefined;
  const first = node.arguments[0];
  return first && isStringLiteral(first) ? `test(${JSON.stringify(first.text)})` : undefined;
}

function enclosingScope(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name) && cur.initializer && (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))) {
      return cur.name.text;
    }
    if (ts.isCallExpression(cur)) {
      const label = testCallLabel(cur);
      if (label) return label;
    }
    cur = cur.parent;
  }
  return "<top-level>";
}

function recordFinding(source: ts.SourceFile, node: ts.Node, file: string, message: string, findings: ModeMemoryFinding[]): void {
  findings.push({ file, location: location(source, node), scope: enclosingScope(node), message });
}

function isQueryParamsReceiver(callee: ts.Expression, env: FileBindings): boolean {
  const target = unwrap(callee);
  if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return false;
  const receiver = unwrap(target.expression);
  if (isSearchParamsExpr(receiver)) return true;
  if (isNonQueryCollectionExpr(receiver)) return false;
  if (ts.isIdentifier(receiver)) {
    if (env.queryParamVars.has(receiver.text)) return true;
    if (env.nonQueryParamVars.has(receiver.text)) return false;
    return queryParamNameHint.test(receiver.text);
  }
  return false;
}

function checkTemplateExpression(source: ts.SourceFile, node: ts.TemplateExpression, file: string, env: FileBindings, findings: ModeMemoryFinding[]): void {
  const fullStatic = staticText(node, env);
  if (fullStatic !== undefined) {
    if (literalModeMemory.test(fullStatic)) {
      recordFinding(source, node, file, `template literal evaluates to ${JSON.stringify(fullStatic)}`, findings);
    }
    return;
  }
  let segment = node.head.text;
  if (literalModeMemory.test(segment)) {
    recordFinding(source, node.head, file, "template literal sets URL mode=memory", findings);
  }
  for (const span of node.templateSpans) {
    const evaluated = staticText(span.expression, env);
    if (evaluated !== undefined) {
      const merged = segment + evaluated + span.literal.text;
      if (literalModeMemory.test(merged) && !literalModeMemory.test(segment)) {
        recordFinding(source, span, file, "template literal evaluates to URL mode=memory", findings);
      }
      segment = merged;
      continue;
    }
    if (dynamicModeQuery.test(segment) && isDisallowedModeValue(span.expression, env)) {
      recordFinding(source, span.expression, file, "template literal sets dynamic URL mode=", findings);
    }
    segment = span.literal.text;
    if (literalModeMemory.test(segment)) {
      recordFinding(source, span.literal, file, "template literal sets URL mode=memory", findings);
    }
  }
}

function checkCallExpression(source: ts.SourceFile, node: ts.CallExpression, file: string, env: FileBindings, findings: ModeMemoryFinding[]): void {
  const name = methodName(node.expression);
  if ((name !== "set" && name !== "append") || node.arguments.length < 2) return;
  if (!isQueryParamsReceiver(node.expression, env)) return;
  if (staticText(node.arguments[0]!, env) === "mode" && isDisallowedModeValue(node.arguments[1]!, env)) {
    recordFinding(source, node, file, `${name}("mode", ...) sets memory or dynamic mode`, findings);
  }
}

function propertyKeyText(name: ts.PropertyName, env: FileBindings): string | undefined {
  if (ts.isIdentifier(name) || isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return staticText(name.expression, env);
  return undefined;
}

function hasDisallowedModeInit(expr: ts.Expression, env: FileBindings, seen = new Set<string>()): boolean {
  const target = unwrap(expr);
  if (ts.isObjectLiteralExpression(target)) return hasDisallowedModeProp(target, env, seen);
  if (ts.isArrayLiteralExpression(target)) return hasDisallowedModeTuple(target, env);
  if (ts.isIdentifier(target) && !seen.has(target.text)) {
    const next = new Set(seen);
    next.add(target.text);
    for (const init of env.allBindings.get(target.text) ?? []) {
      if (hasDisallowedModeInit(init, env, next)) return true;
    }
  }
  return false;
}

function hasDisallowedModeProp(expr: ts.ObjectLiteralExpression, env: FileBindings, seen: Set<string>): boolean {
  for (const prop of expr.properties) {
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "mode" && isDisallowedModeValue(prop.name, env)) {
      return true;
    }
    if (ts.isSpreadAssignment(prop) && hasDisallowedModeInit(prop.expression, env, seen)) {
      return true;
    }
    if (!ts.isPropertyAssignment(prop)) continue;
    if (propertyKeyText(prop.name, env) === "mode" && isDisallowedModeValue(prop.initializer, env)) {
      return true;
    }
  }
  return false;
}

function hasDisallowedModeTuple(expr: ts.ArrayLiteralExpression, env: FileBindings): boolean {
  for (const elem of expr.elements) {
    if (!ts.isArrayLiteralExpression(elem) || elem.elements.length < 2) continue;
    if (staticText(elem.elements[0]!, env) === "mode" && isDisallowedModeValue(elem.elements[1]!, env)) {
      return true;
    }
  }
  return false;
}

function checkNewExpression(source: ts.SourceFile, node: ts.NewExpression, file: string, env: FileBindings, findings: ModeMemoryFinding[]): void {
  if (methodName(node.expression) !== "URLSearchParams" || !node.arguments?.length) return;
  const arg = node.arguments[0]!;
  if (hasDisallowedModeInit(arg, env)) {
    recordFinding(source, node, file, "new URLSearchParams(...) sets memory or dynamic mode", findings);
  }
}

function checkConcatenation(source: ts.SourceFile, node: ts.BinaryExpression, file: string, env: FileBindings, findings: ModeMemoryFinding[]): void {
  if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken) return;
  const left = staticText(node.left, env);
  if (left !== undefined && dynamicModeQuery.test(left) && isDisallowedModeValue(node.right, env)) {
    recordFinding(source, node, file, "concatenated mode= with memory or dynamic mode", findings);
    return;
  }
  const combined = staticText(node, env);
  if (combined === undefined || !literalModeMemory.test(combined)) return;
  const right = staticText(node.right, env);
  if ((left !== undefined && literalModeMemory.test(left)) || (right !== undefined && literalModeMemory.test(right))) return;
  recordFinding(source, node, file, "concatenated mode=memory", findings);
}

const fastPreFilter = /URLSearchParams|searchParams|mode|memory/i;

export function findModeMemoryUses(file: string, text: string): ModeMemoryFinding[] {
  if (!fastPreFilter.test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const env = collectBindings(source);
  const findings: ModeMemoryFinding[] = [];
  function visit(node: ts.Node): void {
    if (isStringLiteral(node) && literalModeMemory.test(node.text)) {
      recordFinding(source, node, file, `literal ${JSON.stringify(node.text)}`, findings);
    } else if (ts.isBinaryExpression(node)) {
      checkConcatenation(source, node, file, env, findings);
    } else if (ts.isTemplateExpression(node)) {
      checkTemplateExpression(source, node, file, env, findings);
    } else if (ts.isCallExpression(node)) {
      checkCallExpression(source, node, file, env, findings);
    } else if (ts.isNewExpression(node)) {
      checkNewExpression(source, node, file, env, findings);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}

export function evaluateAllowlist(
  matched: ReadonlyMap<string, readonly ModeMemoryFinding[]>,
  allowlist: Readonly<Record<string, readonly AllowlistRule[]>>,
): { unexpected: string[]; mismatched: string[] } {
  const unexpected: string[] = [];
  const mismatched: string[] = [];
  const seenCounts = new Map<string, number>();

  for (const [file, uses] of matched) {
    const rules = allowlist[file];
    for (const use of uses) {
      const rule = rules?.find(entry => entry.scope === use.scope);
      if (!rule) {
        unexpected.push(`${use.file}:${use.location} [${use.scope}]: ${use.message}`);
        continue;
      }
      const key = `${file}\0${use.scope}`;
      const next = (seenCounts.get(key) ?? 0) + 1;
      seenCounts.set(key, next);
      if (next > rule.count) {
        unexpected.push(`${use.file}:${use.location} [${use.scope}]: exceeds allowlisted count ${rule.count} (${use.message})`);
      }
    }
  }

  for (const [file, rules] of Object.entries(allowlist)) {
    for (const rule of rules) {
      const actual = seenCounts.get(`${file}\0${rule.scope}`) ?? 0;
      if (actual !== rule.count) {
        mismatched.push(`${file} [${rule.scope}]: expected ${rule.count} allowlisted usage(s), found ${actual}`);
      }
    }
  }
  return { unexpected, mismatched };
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

test("only allowlisted memory-mode scopes may pass mode=memory", () => {
  const files: string[] = [];
  for (const dir of scannedRoots) walkSourceFiles(join(root, dir), files);
  const matched = new Map<string, ModeMemoryFinding[]>();
  for (const full of files.toSorted()) {
    const rel = relative(root, full).replaceAll("\\", "/");
    if (rel === selfPath) continue;
    const uses = findModeMemoryUses(rel, readFileSync(full, "utf8"));
    if (uses.length > 0) matched.set(rel, uses);
  }

  for (const [file, rules] of Object.entries(MODE_MEMORY_ALLOWLIST)) {
    expect(existsSync(join(root, file)), `Stale allowlist entry (file deleted): ${file}`).toBe(true);
    expect(rules.length, `Empty allowlist rules for ${file}`).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.reason.trim().length, `Missing reason for ${file} [${rule.scope}]`).toBeGreaterThan(0);
    }
  }

  const { unexpected, mismatched } = evaluateAllowlist(matched, MODE_MEMORY_ALLOWLIST);
  expect(unexpected, "Unallowlisted mode=memory usage detected; migrate to default persistent FS or add a scoped rule in MODE_MEMORY_ALLOWLIST").toEqual([]);
  expect(mismatched, "Stale or over-broad allowlist count detected; update MODE_MEMORY_ALLOWLIST").toEqual([]);
}, 30_000);

test("mode=memory detector catches static, dynamic, split, computed, and indirect forms without false positives", () => {
  expect(findModeMemoryUses("probe.ts", 'page.goto(`${base}?engine=browser&mode=memory`)')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'page.goto("http://127.0.0.1/?mode=memory")')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const script = `new Playground("?engine=quickjs&mode=memory")`;')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'page.goto(`${base}?mode=${mode}`)')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const q = "?mode=" + mode;')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const q = "?mode=" + "memory";')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const q = "?mo" + "de=memory";')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const q = `?mo${"de"}=${"memory"}`;')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'url.searchParams.set("mode", "memory");')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'url.searchParams.set("mode", selected);')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'params.append("mode", "memory");')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const p = new URLSearchParams(); p.set("mode", "memory");')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'new URLSearchParams({ mode: "memory" });')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'new URLSearchParams({ ["mode"]: "memory" });')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const options = { mode: "memory" }; new URLSearchParams(options);')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'new URLSearchParams({ mode });')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'new URLSearchParams([["mode", "memory"]]);')).toHaveLength(1);

  expect(findModeMemoryUses("probe.ts", '// Default persistent IndexedDB (not mode=memory)\npage.goto(`${base}?engine=browser`);')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", '/* no mode=memory */\npage.goto("http://127.0.0.1/?mode=fast");')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'page.goto(`${base}?mode=${"fast"}`);')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'const q = `?mode=${"fast"}`;')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'url.searchParams.set("mode", "fast");')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'new URLSearchParams({ mode: "fast" });')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'new Map().set("mode", "verify");')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'const map = new Map<string, string>(); map.set("mode", "verify");')).toEqual([]);

  // Scoped allowlist rejects an unallowlisted scope in an allowlisted file and rejects extra usages in an allowlisted scope.
  const probeSource = `
    function allowedHelper() {
      page.goto("http://127.0.0.1/?mode=memory");
    }
    function persistentTest() {
      page.goto("http://127.0.0.1/?mode=memory");
    }
  `;
  const probeUses = new Map([["probe.ts", findModeMemoryUses("probe.ts", probeSource)]]);
  const scoped = evaluateAllowlist(probeUses, {
    "probe.ts": [{ scope: "allowedHelper", count: 1, reason: "explicit memory test" }],
  });
  expect(scoped.unexpected).toHaveLength(1);
  expect(scoped.unexpected[0]).toContain("[persistentTest]");
  expect(scoped.mismatched).toEqual([]);
});

test("mode=memory allowlist check is registered under the blocking quality owner", () => {
  expect(discoverChecks().filter(check => check.path === selfPath).map(check => check.owner)).toEqual(["quality"]);
});

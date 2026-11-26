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

type ReceiverKind = "query" | "non-query" | "unknown";
type ObjectModeState = "none" | "allowed" | "disallowed";

interface BindingInfo {
  readonly isConst: boolean;
  readonly isParam: boolean;
  readonly count: number;
  readonly inits: ts.Expression[];
  readonly typeKind: ReceiverKind;
}

interface LexicalEnv {
  readonly parent: LexicalEnv | undefined;
  readonly bindings: Map<string, BindingInfo>;
  readonly fnReturns: Map<string, ReceiverKind>;
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

function classifyTypeNode(type: ts.TypeNode | undefined): ReceiverKind {
  if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return "unknown";
  if (type.typeName.text === "URLSearchParams") return "query";
  return nonQueryCollectionNames.has(type.typeName.text) ? "non-query" : "unknown";
}

function classifyFunctionTypeReturn(type: ts.TypeNode | undefined): ReceiverKind {
  if (!type || !ts.isFunctionTypeNode(type)) return "unknown";
  return classifyTypeNode(type.type);
}

function isScopeContainer(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isCaseBlock(node)
  );
}

function addBinding(env: LexicalEnv, name: string, init: ts.Expression | undefined, isConst: boolean, typeKind: ReceiverKind, isParam = false): void {
  const prev = env.bindings.get(name);
  const inits = prev ? prev.inits.concat(init ? [init] : []) : init ? [init] : [];
  const nextCount = (prev?.count ?? 0) + 1;
  const resolvedType = typeKind !== "unknown" ? typeKind : (prev?.typeKind ?? "unknown");
  env.bindings.set(name, { isConst: isConst && nextCount === 1, isParam: isParam && !prev, count: nextCount, inits, typeKind: resolvedType });
}

function directExpressionKind(expr: ts.Expression): ReceiverKind {
  const target = unwrap(expr);
  if (ts.isPropertyAccessExpression(target) && target.name.text === "searchParams") return "query";
  if (!ts.isNewExpression(target)) return "unknown";
  const ctor = methodName(target.expression);
  if (ctor === "URLSearchParams") return "query";
  return ctor !== undefined && nonQueryCollectionNames.has(ctor) ? "non-query" : "unknown";
}

function inferFunctionReturnKind(fn: ts.FunctionLikeDeclaration): ReceiverKind {
  const declared = classifyTypeNode(fn.type);
  if (declared !== "unknown") return declared;
  if (!fn.body) return "unknown";
  if (!ts.isBlock(fn.body)) return directExpressionKind(fn.body);
  let inferred: ReceiverKind = "unknown";
  for (const stmt of fn.body.statements) {
    if (!ts.isReturnStatement(stmt) || !stmt.expression) continue;
    const kind = directExpressionKind(stmt.expression);
    if (kind === "unknown") continue;
    if (inferred !== "unknown" && inferred !== kind) return "unknown";
    inferred = kind;
  }
  return inferred;
}

function inferCallableReturnKind(type: ts.TypeNode | undefined, initializer: ts.Expression | undefined): ReceiverKind {
  const fromType = classifyFunctionTypeReturn(type);
  if (fromType !== "unknown") return fromType;
  const init = initializer ? unwrap(initializer) : undefined;
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
    return inferFunctionReturnKind(init);
  }
  return "unknown";
}

function registerVariableStatement(env: LexicalEnv, stmt: ts.VariableStatement): void {
  const isConst = Boolean(stmt.declarationList.flags & ts.NodeFlags.Const);
  for (const decl of stmt.declarationList.declarations) {
    if (!ts.isIdentifier(decl.name)) continue;
    const name = decl.name.text;
    addBinding(env, name, decl.initializer, isConst, classifyTypeNode(decl.type));
    const ret = inferCallableReturnKind(decl.type, decl.initializer);
    if (ret !== "unknown") env.fnReturns.set(name, ret);
  }
}

function registerStatement(env: LexicalEnv, stmt: ts.Statement): void {
  if (ts.isVariableStatement(stmt)) {
    registerVariableStatement(env, stmt);
    return;
  }
  if (ts.isFunctionDeclaration(stmt) && stmt.name) {
    const ret = inferFunctionReturnKind(stmt);
    if (ret !== "unknown") env.fnReturns.set(stmt.name.text, ret);
  }
}

function registerStatements(env: LexicalEnv, statements: readonly ts.Statement[]): void {
  for (const stmt of statements) registerStatement(env, stmt);
}

function registerForInitializer(env: LexicalEnv, init: ts.ForInitializer | undefined): void {
  if (!init || !ts.isVariableDeclarationList(init)) return;
  const isConst = Boolean(init.flags & ts.NodeFlags.Const);
  for (const decl of init.declarations) {
    if (!ts.isIdentifier(decl.name)) continue;
    addBinding(env, decl.name.text, decl.initializer, isConst, classifyTypeNode(decl.type));
  }
}

function registerParameters(env: LexicalEnv, params: readonly ts.ParameterDeclaration[]): void {
  for (const param of params) {
    if (!ts.isIdentifier(param.name)) continue;
    addBinding(env, param.name.text, param.initializer, false, classifyTypeNode(param.type), true);
    const fromType = classifyFunctionTypeReturn(param.type);
    if (fromType !== "unknown") {
      env.fnReturns.set(param.name.text, fromType);
      continue;
    }
    if (inferCallableReturnKind(undefined, param.initializer) === "query") {
      env.fnReturns.set(param.name.text, "query");
    }
  }
}

function createScopeEnv(node: ts.Node, parent: LexicalEnv | undefined): LexicalEnv {
  const env: LexicalEnv = { parent, bindings: new Map(), fnReturns: new Map() };
  if (ts.isSourceFile(node) || ts.isBlock(node)) {
    registerStatements(env, node.statements);
  } else if (ts.isCaseBlock(node)) {
    for (const clause of node.clauses) registerStatements(env, clause.statements);
  } else if (ts.isFunctionLike(node)) {
    registerParameters(env, node.parameters);
  } else if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    registerForInitializer(env, node.initializer);
  } else if (ts.isCatchClause(node) && node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name)) {
    addBinding(env, node.variableDeclaration.name.text, undefined, false, "unknown");
  }
  return env;
}

function lookupBinding(env: LexicalEnv | undefined, name: string): { binding: BindingInfo; scope: LexicalEnv } | undefined {
  let cur = env;
  while (cur) {
    const found = cur.bindings.get(name);
    if (found) return { binding: found, scope: cur };
    cur = cur.parent;
  }
  return undefined;
}

function lookupFnReturn(env: LexicalEnv | undefined, name: string): ReceiverKind {
  let cur = env;
  while (cur) {
    const found = cur.fnReturns.get(name);
    if (found) return found;
    if (cur.bindings.has(name)) return "unknown";
    cur = cur.parent;
  }
  return "unknown";
}

function staticText(node: ts.Expression, env: LexicalEnv, seen = new Set<string>()): string | undefined {
  const target = unwrap(node);
  if (isStringLiteral(target)) return target.text;
  if (ts.isIdentifier(target)) {
    if (seen.has(target.text)) return undefined;
    const found = lookupBinding(env, target.text);
    if (!found || !found.binding.isConst || found.binding.inits.length !== 1) return undefined;
    const next = new Set(seen);
    next.add(target.text);
    return staticText(found.binding.inits[0]!, found.scope, next);
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

function isDisallowedModeValue(node: ts.Expression, env: LexicalEnv): boolean {
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

function classifyReceiver(expr: ts.Expression, env: LexicalEnv, seen = new Set<string>()): ReceiverKind {
  const target = unwrap(expr);
  const direct = directExpressionKind(target);
  if (direct !== "unknown") return direct;
  if (ts.isCallExpression(target)) {
    const calleeName = methodName(target.expression);
    return calleeName ? lookupFnReturn(env, calleeName) : "unknown";
  }
  if (!ts.isIdentifier(target) || seen.has(target.text)) return "unknown";
  const found = lookupBinding(env, target.text);
  if (!found) return queryParamNameHint.test(target.text) ? "query" : "unknown";
  if (found.binding.typeKind !== "unknown") return found.binding.typeKind;
  if (found.binding.inits.length === 0) return queryParamNameHint.test(target.text) ? "query" : "unknown";
  const next = new Set(seen);
  next.add(target.text);
  let resolved: ReceiverKind = "unknown";
  for (const init of found.binding.inits) {
    const kind = classifyReceiver(init, found.scope, next);
    if (kind === "query") return "query";
    if (kind === "non-query" && !found.binding.isParam) resolved = "non-query";
  }
  if (resolved !== "unknown") return resolved;
  return queryParamNameHint.test(target.text) ? "query" : "unknown";
}

function isQueryParamsReceiver(callee: ts.Expression, env: LexicalEnv): boolean {
  const target = unwrap(callee);
  if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return false;
  return classifyReceiver(target.expression, env) === "query";
}

function checkTemplateSpan(
  source: ts.SourceFile,
  span: ts.TemplateSpan,
  segment: string,
  file: string,
  env: LexicalEnv,
  findings: ModeMemoryFinding[],
): string {
  const evaluated = staticText(span.expression, env);
  if (evaluated !== undefined) {
    const merged = segment + evaluated + span.literal.text;
    if (literalModeMemory.test(merged) && !literalModeMemory.test(segment)) {
      recordFinding(source, span, file, "template literal evaluates to URL mode=memory", findings);
    }
    return merged;
  }
  if (dynamicModeQuery.test(segment) && isDisallowedModeValue(span.expression, env)) {
    recordFinding(source, span.expression, file, "template literal sets dynamic URL mode=", findings);
  }
  if (literalModeMemory.test(span.literal.text)) {
    recordFinding(source, span.literal, file, "template literal sets URL mode=memory", findings);
  }
  return span.literal.text;
}

function checkTemplateExpression(source: ts.SourceFile, node: ts.TemplateExpression, file: string, env: LexicalEnv, findings: ModeMemoryFinding[]): void {
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
    segment = checkTemplateSpan(source, span, segment, file, env, findings);
  }
}

function checkCallExpression(source: ts.SourceFile, node: ts.CallExpression, file: string, env: LexicalEnv, findings: ModeMemoryFinding[]): void {
  const name = methodName(node.expression);
  if ((name !== "set" && name !== "append") || node.arguments.length < 2) return;
  if (!isQueryParamsReceiver(node.expression, env)) return;
  if (staticText(node.arguments[0]!, env) === "mode" && isDisallowedModeValue(node.arguments[1]!, env)) {
    recordFinding(source, node, file, `${name}("mode", ...) sets memory or dynamic mode`, findings);
  }
}

function propertyKeyText(name: ts.PropertyName, env: LexicalEnv): string | undefined {
  if (ts.isIdentifier(name) || isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return staticText(name.expression, env);
  return undefined;
}

function resolveObjectModeState(expr: ts.Expression, env: LexicalEnv, seen: Set<string>): ObjectModeState {
  const target = unwrap(expr);
  if (ts.isObjectLiteralExpression(target)) return evaluateObjectLiteralMode(target, env, seen);
  if (!ts.isIdentifier(target) || seen.has(target.text)) return "none";
  const found = lookupBinding(env, target.text);
  if (!found) return "none";
  const next = new Set(seen);
  next.add(target.text);
  let state: ObjectModeState = "none";
  for (const init of found.binding.inits) {
    const candidate = resolveObjectModeState(init, found.scope, next);
    if (candidate === "disallowed") return "disallowed";
    if (candidate === "allowed") state = "allowed";
  }
  return state;
}

function evaluateObjectLiteralMode(expr: ts.ObjectLiteralExpression, env: LexicalEnv, seen: Set<string>): ObjectModeState {
  let state: ObjectModeState = "none";
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const spreadState = resolveObjectModeState(prop.expression, env, seen);
      if (spreadState !== "none") state = spreadState;
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === "mode") {
      state = isDisallowedModeValue(prop.name, env) ? "disallowed" : "allowed";
      continue;
    }
    if (ts.isPropertyAssignment(prop) && propertyKeyText(prop.name, env) === "mode") {
      state = isDisallowedModeValue(prop.initializer, env) ? "disallowed" : "allowed";
    }
  }
  return state;
}

function hasDisallowedModeTuple(expr: ts.ArrayLiteralExpression, env: LexicalEnv, seen: Set<string>): boolean {
  for (const elem of expr.elements) {
    if (ts.isSpreadElement(elem) && hasDisallowedModeInit(elem.expression, env, seen)) return true;
    if (!ts.isArrayLiteralExpression(elem) || elem.elements.length < 2) continue;
    if (staticText(elem.elements[0]!, env) === "mode" && isDisallowedModeValue(elem.elements[1]!, env)) return true;
  }
  return false;
}

function hasDisallowedModeInit(expr: ts.Expression, env: LexicalEnv, seen = new Set<string>()): boolean {
  const target = unwrap(expr);
  if (ts.isObjectLiteralExpression(target)) return evaluateObjectLiteralMode(target, env, seen) === "disallowed";
  if (ts.isArrayLiteralExpression(target)) return hasDisallowedModeTuple(target, env, seen);
  if (!ts.isIdentifier(target) || seen.has(target.text)) return false;
  const found = lookupBinding(env, target.text);
  if (!found) return false;
  const next = new Set(seen);
  next.add(target.text);
  return found.binding.inits.some(init => hasDisallowedModeInit(init, found.scope, next));
}

function checkNewExpression(source: ts.SourceFile, node: ts.NewExpression, file: string, env: LexicalEnv, findings: ModeMemoryFinding[]): void {
  if (methodName(node.expression) !== "URLSearchParams" || !node.arguments?.length) return;
  const arg = node.arguments[0]!;
  if (hasDisallowedModeInit(arg, env)) {
    recordFinding(source, node, file, "new URLSearchParams(...) sets memory or dynamic mode", findings);
  }
}

function checkConcatenation(source: ts.SourceFile, node: ts.BinaryExpression, file: string, env: LexicalEnv, findings: ModeMemoryFinding[]): void {
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

export function findModeMemoryUses(file: string, text: string): ModeMemoryFinding[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const findings: ModeMemoryFinding[] = [];
  function visit(node: ts.Node, env: LexicalEnv): void {
    const currentEnv = isScopeContainer(node) && !ts.isSourceFile(node) ? createScopeEnv(node, env) : env;
    if (isStringLiteral(node) && literalModeMemory.test(node.text)) {
      recordFinding(source, node, file, `literal ${JSON.stringify(node.text)}`, findings);
    } else if (ts.isBinaryExpression(node)) {
      checkConcatenation(source, node, file, currentEnv, findings);
    } else if (ts.isTemplateExpression(node)) {
      checkTemplateExpression(source, node, file, currentEnv, findings);
    } else if (ts.isCallExpression(node)) {
      checkCallExpression(source, node, file, currentEnv, findings);
    } else if (ts.isNewExpression(node)) {
      checkNewExpression(source, node, file, currentEnv, findings);
    }
    ts.forEachChild(node, child => visit(child, currentEnv));
  }
  visit(source, createScopeEnv(source, undefined));
  return findings;
}

function checkFileUses(
  file: string,
  uses: readonly ModeMemoryFinding[],
  rules: readonly AllowlistRule[] | undefined,
  seenCounts: Map<string, number>,
  unexpected: string[],
): void {
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

export function evaluateAllowlist(
  matched: ReadonlyMap<string, readonly ModeMemoryFinding[]>,
  allowlist: Readonly<Record<string, readonly AllowlistRule[]>>,
): { unexpected: string[]; mismatched: string[] } {
  const unexpected: string[] = [];
  const mismatched: string[] = [];
  const seenCounts = new Map<string, number>();

  for (const [file, uses] of matched) {
    checkFileUses(file, uses, allowlist[file], seenCounts, unexpected);
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
}, 60_000);

test("mode=memory detector catches static, dynamic, split, spread, computed, and aliased forms without false positives", () => {
  expect(findModeMemoryUses("probe.ts", 'page.goto(`${base}?engine=browser&mode=memory`)')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'page.goto("http://127.0.0.1/?mode=memory")')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const script = `new Playground("?engine=quickjs&mode=memory")`;')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'page.goto(`${base}?mode=${mode}`)')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const q = "?mode=" + mode;')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const q = "?mode=" + "memory";')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const q = "?mo" + "de=memory";')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'page.goto("?mo" + "de=mem" + "ory");')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const q = `?mo${"de"}=${"memory"}`;')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'url.searchParams.set("mode", "memory");')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'url.searchParams.set("mode", selected);')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'params.append("mode", "memory");')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const p = new URLSearchParams(); p.set("mode", "memory");')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const p = new URLSearchParams(); const q = p; q.set("mode", "memory");')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'import { makeParams } from "./helper"; const params = makeParams(); params.set("mode", "memory");')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'switch (kind) { case 1: const p = new URLSearchParams(); p.set("mode", "memory"); break; }')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'function makeHeaders() { return new Headers(); }\nfunction inner(makeHeaders: () => unknown) { const params = makeHeaders(); params.set("mode", "memory"); }')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'function makeHeaders() { return new Headers(); }\nfunction inner(makeHeaders: () => URLSearchParams) { const q = makeHeaders(); q.set("mode", "memory"); }')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'function makeParams() { return new URLSearchParams(); }\nfunction probe(makeParams = () => new URLSearchParams()) { makeParams().set("mode", "memory"); }')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'function probe(make: () => { set(key: string, value: string): void } = () => new Headers()) { const params = make(); params.set("mode", "memory"); }')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const defaults = new URLSearchParams();\nfunction probe(p = defaults) { p.set("mode", "memory"); }')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'function probe(params: { set(k: string, v: string): void } = new Headers()) { params.set("mode", "memory"); }')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'new URLSearchParams({ mode: "memory" });')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'new URLSearchParams({ ["mode"]: "memory" });')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const options = { mode: "memory" }; new URLSearchParams(options);')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const options = { mode: "memory" }; new URLSearchParams({ mode: "fast", ...options });')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'const entries = [["mode", "memory"]]; new URLSearchParams([...entries]);')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'new URLSearchParams({ mode });')).toHaveLength(1);
  expect(findModeMemoryUses("probe.ts", 'new URLSearchParams([["mode", "memory"]]);')).toHaveLength(1);

  expect(findModeMemoryUses("probe.ts", '// Default persistent IndexedDB (not mode=memory)\npage.goto(`${base}?engine=browser`);')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", '/* no mode=memory */\npage.goto("http://127.0.0.1/?mode=fast");')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'page.goto(`${base}?mode=${"fast"}`);')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'const q = `?mode=${"fast"}`;')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'url.searchParams.set("mode", "fast");')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'new URLSearchParams({ mode: "fast" });')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'const options = { mode: "memory" }; new URLSearchParams({ ...options, mode: "fast" });')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'new Map().set("mode", "verify");')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'const map = new Map<string, string>(); map.set("mode", "verify");')).toEqual([]);
  expect(findModeMemoryUses("probe.ts", 'function makeHeaders() { return new Headers(); }\nconst params = makeHeaders(); params.set("mode", "cors");')).toEqual([]);

  // Lexical scoping isolates bindings between separate tests in the same file.
  const isolatedSource = `
    function firstTest() {
      const options = { mode: "memory" };
      return options;
    }
    function secondTest() {
      const options = { mode: "fast" };
      return new URLSearchParams(options);
    }
  `;
  expect(findModeMemoryUses("probe.ts", isolatedSource)).toEqual([]);

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

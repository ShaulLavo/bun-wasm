import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve, sep, win32 } from "node:path";
import ts from "typescript-api";
import { automaticChecks, discoverChecks } from "./test-checks";

const root = resolve(import.meta.dir, "..");
const temporaryMethods = new Set(["mkdtemp", "mkdtempSync", "mkdtempDisposable", "mkdtempDisposableSync"]);
const sourceExtension = /\.[cm]?[jt]sx?$/;

function methodName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return undefined;
}

const fallbackOperators = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken]);

// With `fallback`, `TMPDIR ?? "/work/tmp"` counts as its literal right side: jobs without TMPDIR use it.
function literalPrefix(node: ts.Expression, fallback = false): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  if (ts.isParenthesizedExpression(node)) return literalPrefix(node.expression, fallback);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return literalPrefix(node.left, fallback);
  if (fallback && ts.isBinaryExpression(node) && fallbackOperators.has(node.operatorToken.kind)) return literalPrefix(node.right, fallback);
  if (!ts.isCallExpression(node)) return undefined;
  if (methodName(node.expression) === "resolve") return resolvedPrefix(node.arguments, fallback);
  if (methodName(node.expression) === "join" && node.arguments[0]) return literalPrefix(node.arguments[0], fallback);
  return undefined;
}

function resolvedPrefix(arguments_: readonly ts.Expression[], fallback: boolean): string | undefined {
  for (let index = arguments_.length - 1; index >= 0; index--) {
    const argument = arguments_[index]!;
    const prefix = literalPrefix(argument, fallback);
    if (prefix === undefined || (prefix === "" && !ts.isStringLiteralLike(argument))) return undefined;
    if (posix.isAbsolute(prefix) || win32.isAbsolute(prefix)) return prefix;
  }
  return undefined;
}

export function temporaryPathFailures(file: string, text: string, rejectFallback = false): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const methods = new Set(temporaryMethods);
  const failures: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportSpecifier(node) && temporaryMethods.has(node.propertyName?.text ?? node.name.text)) methods.add(node.name.text);
    if (ts.isBindingElement(node) && node.propertyName && temporaryMethods.has(node.propertyName.getText(source))) methods.add(node.name.getText(source));
    if (ts.isCallExpression(node) && methods.has(methodName(node.expression) ?? "")) checkCall(node);
    ts.forEachChild(node, visit);
  }
  function checkCall(node: ts.CallExpression): void {
    const argument = node.arguments[0];
    const prefix = argument && literalPrefix(argument, rejectFallback);
    if (!prefix || (!posix.isAbsolute(prefix) && !win32.isAbsolute(prefix))) return;
    const { line, character } = source.getLineAndCharacterOfPosition(argument.getStart(source));
    failures.push(`${file}:${line + 1}:${character + 1}: hard-coded temporary directory ${JSON.stringify(prefix)}; use join(tmpdir(), prefix) or a configured temporary root`);
  }
  visit(source);
  return failures;
}

function localSource(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  const withoutExtension = base.slice(0, base.length - extname(base).length);
  const candidates = [base].concat([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"].map(extension => base + extension),
    [".ts", ".tsx", ".mts", ".cts"].map(extension => withoutExtension + extension), [join(base, "index.ts"), join(base, "index.js")]);
  return candidates.find(path => sourceExtension.test(path) && existsSync(path));
}

export function ciTemporarySources(directory = root): string[] {
  const selected = discoverChecks(directory).filter(check => check.owner !== "native").map(check => check.path)
    .concat(automaticChecks(directory).map(check => check.path));
  return withLocalImports(directory, selected);
}

/** Sources run by the Web unit job, which sets no TMPDIR, so an environment fallback is the path used. */
export function webTemporarySources(directory = root): string[] {
  return withLocalImports(directory, discoverChecks(directory).filter(check => check.owner === "web").map(check => check.path));
}

function withLocalImports(directory: string, selected: readonly string[]): string[] {
  const paths = new Set(selected);
  for (const path of paths) {
    const source = readFileSync(join(directory, path), "utf8");
    const imports = ts.preProcessFile(source, true, true).importedFiles;
    for (const imported of imports) addLocal(path, imported.fileName);
  }
  function addLocal(path: string, specifier: string): void {
    const imported = localSource(join(directory, path), specifier);
    if (!imported) return;
    const local = relative(directory, imported);
    if (local.startsWith(`..${sep}`) || local.split(sep).includes("node_modules")) return;
    paths.add(local);
  }
  return Array.from(paths).sort();
}

export function auditTemporaryPaths(directory = root): string[] {
  const web = new Set(webTemporarySources(directory));
  return ciTemporarySources(directory).flatMap(path => temporaryPathFailures(path, readFileSync(join(directory, path), "utf8"), web.has(path)));
}

if (import.meta.main) {
  const failures = auditTemporaryPaths();
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(`Temporary directory portability: ${ciTemporarySources().length} CI test/setup sources checked`);
}

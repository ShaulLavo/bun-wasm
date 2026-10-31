import { createHash } from "node:crypto";
import ts from "typescript-api";

function parseRuntime(text: string): ts.SourceFile {
  return ts.createSourceFile("util.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function syntax(source: ts.SourceFile): string {
  function visit(node: ts.Node): unknown {
    if (ts.isParenthesizedExpression(node)) return visit(node.expression);
    const children = node.getChildren(source);
    return children.length ? [node.kind, children.map(visit)] : [node.kind, node.getText(source)];
  }
  return JSON.stringify(visit(source));
}

export function astHash(text: string): string {
  return createHash("sha256").update(syntax(parseRuntime(text))).digest("hex");
}

function declarations(source: ts.SourceFile, name: string, scope: ts.Node = source): ts.VariableDeclaration {
  const found: ts.VariableDeclaration[] = [];
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(scope);
  if (found.length !== 1 || !found[0]) throw new Error(`Expected exactly one ${name}`);
  return found[0];
}

function statement(node: ts.VariableDeclaration): ts.VariableStatement {
  const list = node.parent;
  if (!ts.isVariableDeclarationList(list) || list.declarations.length !== 1 || !(list.flags & ts.NodeFlags.Const)) throw new Error("Expected single const destination");
  if (!ts.isVariableStatement(list.parent)) throw new Error("Expected destination statement");
  return list.parent;
}

function identifier(node: ts.Node | undefined, name: string): void {
  if (!node || !ts.isIdentifier(node) || node.text !== name) throw new Error(`Expected ${name} identifier`);
}

function concatReceiver(node: ts.Node | undefined): ts.Identifier {
  if (!node || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) throw new Error("Expected concat call");
  if (node.expression.name.text !== "concat" || !ts.isIdentifier(node.expression.expression)) throw new Error("Expected destination.concat");
  return node.expression.expression;
}

function constructorReceiver(node: ts.NewExpression): ts.Identifier {
  const outer = node.arguments?.[0];
  if (node.arguments?.length !== 1 || !outer || !ts.isCallExpression(outer) || !ts.isPropertyAccessExpression(outer.expression)) throw new Error("Expected constructor concat chain");
  if (outer.expression.name.text !== "concat") throw new Error("Expected second concat");
  return concatReceiver(outer.expression.expression);
}

interface Edit { start: number; end: number; text: string }

function restoreParseEnv(text: string): string {
  const source = parseRuntime(text);
  const matches: ts.Node[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "parseEnv") matches.push(node);
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "parseEnv") matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (matches.length !== 2) throw new Error("Expected parseEnv function and utility export");
  for (const node of matches.toSorted((left, right) => right.getStart(source) - left.getStart(source))) {
    const end = ts.isShorthandPropertyAssignment(node) && text[node.end] === "," ? node.end + 1 : node.end;
    text = text.slice(0, node.getStart(source)) + text.slice(end);
  }
  return text;
}

// Restore the two reviewed extractions and the separately tested parseEnv addition.
export function restoreDestinations(text: string): string {
  text = restoreParseEnv(text);
  const source = parseRuntime(text);
  const capture = declarations(source, "ConstructorSet");
  const array = declarations(source, "constructors");
  const set = declarations(source, "wellKnownConstructors");
  const captureStatement = statement(capture);
  const arrayStatement = statement(array);
  const setStatement = statement(set);
  identifier(capture.initializer, "Set");
  if (!array.initializer || !ts.isArrayLiteralExpression(array.initializer)) throw new Error("Expected literal constructor destination");
  if (captureStatement.end > arrayStatement.getStart(source) || arrayStatement.end > setStatement.getStart(source)) throw new Error("Destination statements are out of order");
  if (!/^\s*$/.test(text.slice(captureStatement.end, arrayStatement.getStart(source))) || !/^\s*$/.test(text.slice(arrayStatement.end, setStatement.getStart(source)))) throw new Error("Set must be captured before the constructor array, immediately before construction");
  if (captureStatement.parent !== setStatement.parent || arrayStatement.parent !== setStatement.parent) throw new Error("Constructor statements must share scope");
  const construct = set.initializer;
  if (!construct || !ts.isNewExpression(construct)) throw new Error("Expected constructor expression");
  identifier(construct.expression, "ConstructorSet");
  const receiver = constructorReceiver(construct);
  identifier(receiver, "constructors");
  const functions: ts.FunctionDeclaration[] = [];
  function findKeys(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "ownEnumerableKeys") functions.push(node);
    ts.forEachChild(node, findKeys);
  }
  findKeys(source);
  if (functions.length !== 1 || !functions[0]) throw new Error("Expected ownEnumerableKeys");
  const keys = declarations(source, "keys", functions[0]);
  const keysStatement = statement(keys);
  const body = keysStatement.parent;
  if (!ts.isBlock(body) || !ts.isFunctionDeclaration(body.parent) || body.parent.name?.text !== "ownEnumerableKeys" || body.statements.length !== 2 || body.statements[0] !== keysStatement) throw new Error("Expected local keys destination and return only");
  const returned = body.statements[1];
  if (!returned || !ts.isReturnStatement(returned) || !keys.initializer) throw new Error("Expected keys return");
  const keyReceiver = concatReceiver(returned.expression);
  identifier(keyReceiver, "keys");
  const edits: Edit[] = [
    { start: captureStatement.getStart(source), end: captureStatement.end, text: "" },
    { start: arrayStatement.getStart(source), end: arrayStatement.end, text: "" },
    { start: construct.expression.getStart(source), end: construct.expression.end, text: "Set" },
    { start: receiver.getStart(source), end: receiver.end, text: `(${array.initializer.getText(source)})` },
    { start: keysStatement.getStart(source), end: keysStatement.end, text: "" },
    { start: keyReceiver.getStart(source), end: keyReceiver.end, text: `(${keys.initializer.getText(source)})` },
  ];
  edits.sort((a, b) => b.start - a.start);
  let restored = text;
  for (const edit of edits) restored = restored.slice(0, edit.start) + edit.text + restored.slice(edit.end);
  return restored;
}

export function constructorCode(text: string, extracted: boolean): string {
  const source = parseRuntime(text);
  const set = statement(declarations(source, "wellKnownConstructors"));
  const start = extracted ? statement(declarations(source, "ConstructorSet")).getStart(source) : set.getStart(source);
  return text.slice(start, set.end) + "\nwellKnownConstructors;";
}

export function keysCode(text: string): string {
  const source = parseRuntime(text);
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && ["ownEnumerableKeys", "enumerableSymbols"].includes(node.name?.text ?? "")) found.push(node.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (found.length !== 2) throw new Error("Expected both original key helpers");
  return statement(declarations(source, "isEnumerable")).getText(source) + "\n" + found.join("\n") + "\nownEnumerableKeys(obj);";
}

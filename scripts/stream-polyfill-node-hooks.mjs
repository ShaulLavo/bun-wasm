import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(resolve(root, "vendor/bun/package.json"))("typescript");
const source = readFileSync(process.argv[2], "utf8");
if (createHash("sha256").update(source).digest("hex") !== "5c36bb87ddfddc29a25420608770e9f26b54bb9233f5b59d56771854bb1bbcf8") throw new Error("Streams ponyfill input changed");
const tree = ts.createSourceFile("ponyfill.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const counts = { readableInit: 0, writableInit: 0, readableClose: 0, writableClose: 0, readableError: 0, writableError: 0 };
function directStates(node) {
  const found = [];
  function visit(child) {
    if (child !== node && ts.isFunctionLike(child)) return;
    if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(child.left) && child.left.name.text === "_state" && ts.isStringLiteral(child.right)) found.push(child.right.text);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}
const transformed = ts.transform(tree, [context => {
  const f = context.factory;
  function visit(node) {
    if (!ts.isFunctionLike(node) || !node.body || !ts.isBlock(node.body)) return ts.visitEachChild(node, visit, context);
    const original = node.getText(tree);
    const states = directStates(node);
    let kind;
    if (states.includes("readable")) kind = "readableInit";
    else if (states.includes("writable")) kind = "writableInit";
    else if (states.includes("closed")) kind = original.includes("._reader") ? "readableClose" : "writableClose";
    else if (states.includes("errored") && original.includes("._reader")) kind = "readableError";
    else if (original.includes("._closeRequest") && original.includes("._writer") && original.includes("._storedError") && !original.includes("._state")) kind = "writableError";
    if (!kind) return ts.visitEachChild(node, visit, context);
    counts[kind]++;
    const parameter = node.parameters[0].name;
    const name = kind.endsWith("Init") ? "__bunNodeStreamInit" : kind.endsWith("Close") ? "__bunNodeStreamClose" : "__bunNodeStreamError";
    const args = kind.endsWith("Error") ? [parameter, f.createPropertyAccessExpression(parameter, "_storedError")] : [parameter];
    const notify = f.createExpressionStatement(f.createCallExpression(f.createIdentifier(name), undefined, args));
    const body = f.updateBlock(node.body, Array.from(node.body.statements, statement => ts.visitNode(statement, visit)).concat([notify]));
    if (ts.isFunctionDeclaration(node)) return f.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, body);
    if (ts.isFunctionExpression(node)) return f.updateFunctionExpression(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, body);
    throw new Error("Unexpected stream algorithm shape");
  }
  return node => ts.visitNode(node, visit);
}]);
if (Object.values(counts).some(count => count !== 1)) throw new Error(`Stream completion algorithms changed: ${JSON.stringify(counts)}`);
const body = ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]);
transformed.dispose();
const hooks = `const __bunNodeStreamRecords = new WeakMap();
function __bunNodeStreamInit(stream) {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  promise.catch(() => {});
  __bunNodeStreamRecords.set(stream, { promise, resolve, reject });
}
function __bunNodeStreamClose(stream) { __bunNodeStreamRecords.get(stream).resolve(); }
function __bunNodeStreamError(stream, reason) { __bunNodeStreamRecords.get(stream).reject(reason); }
`;
const expose = `for (const Ctor of [ReadableStream, WritableStream]) {
  Object.defineProperty(Ctor.prototype, Symbol.for("nodejs.webstream.isClosedPromise"), {
    get() { return __bunNodeStreamRecords.get(this); }
  });
}
`;
writeFileSync(process.argv[3], hooks + body + expose);

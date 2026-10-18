import type * as TS from "../vendor/bun/node_modules/typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts: typeof TS = createRequire(resolve(root, "vendor/bun/package.json"))("typescript");
const input = process.argv[2], output = process.argv[3];
if (!input || !output) throw new Error("Usage: stream-polyfill-node-hooks.ts <input> <output>");
const source = readFileSync(input, "utf8");
if (createHash("sha256").update(source).digest("hex") !== "5c36bb87ddfddc29a25420608770e9f26b54bb9233f5b59d56771854bb1bbcf8") throw new Error("Streams ponyfill input changed");
const tree = ts.createSourceFile("ponyfill.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let readerLockErrors = 0;
const counts = { readableInit: 0, writableInit: 0, readableClose: 0, writableClose: 0, readableError: 0, writableError: 0 };
function directStates(node: TS.Node): string[] {
  const found: string[] = [];
  function visit(child: TS.Node): void {
    if (child !== node && ts.isFunctionLike(child)) return;
    if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(child.left) && child.left.name.text === "_state" && ts.isStringLiteral(child.right)) found.push(child.right.text);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return found;
}
const transformed = ts.transform(tree, [context => {
  const f = context.factory;
  const visit: TS.Visitor = node => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "TypeError" && node.arguments?.some(argument => ts.isStringLiteral(argument) && /locked|already has a writer/i.test(argument.text))) {
      const args = Array.from(node.arguments, argument => {
        if (!ts.isStringLiteral(argument) || argument.text !== "This stream has already been locked for exclusive reading by another reader") return argument;
        readerLockErrors++;
        return f.createStringLiteral("ReadableStream is locked");
      });
      return f.createCallExpression(f.createIdentifier("__bunNodeInvalidState"), undefined, args);
    }
    if ((!ts.isFunctionDeclaration(node) && !ts.isFunctionExpression(node)) || !node.body) return ts.visitEachChild(node, visit, context);
    const original = node.getText(tree);
    const states = directStates(node);
    let kind: keyof typeof counts | undefined;
    if (states.includes("readable")) kind = "readableInit";
    else if (states.includes("writable")) kind = "writableInit";
    else if (states.includes("closed")) kind = original.includes("._reader") ? "readableClose" : "writableClose";
    else if (states.includes("errored") && original.includes("._reader")) kind = "readableError";
    else if (original.includes("._closeRequest") && original.includes("._writer") && original.includes("._storedError") && !original.includes("._state")) kind = "writableError";
    if (!kind) return ts.visitEachChild(node, visit, context);
    counts[kind]++;
    const parameter = node.parameters[0]?.name;
    if (!parameter || !ts.isIdentifier(parameter)) throw new Error("Unexpected stream algorithm parameter");
    const name = kind.endsWith("Init") ? "__bunNodeStreamInit" : kind.endsWith("Close") ? "__bunNodeStreamClose" : "__bunNodeStreamError";
    const args = kind.endsWith("Error") ? [parameter, f.createPropertyAccessExpression(parameter, "_storedError")] : [parameter];
    const notify = f.createExpressionStatement(f.createCallExpression(f.createIdentifier(name), undefined, args));
    const body = f.updateBlock(node.body, ts.visitNodes(node.body.statements, visit, ts.isStatement).concat([notify]));
    if (ts.isFunctionDeclaration(node)) return f.updateFunctionDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, body);
    if (ts.isFunctionExpression(node)) return f.updateFunctionExpression(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, body);
    throw new Error("Unexpected stream algorithm shape");
  };
  return node => ts.visitEachChild(node, visit, context);
}]);
if (Object.values(counts).some(count => count !== 1)) throw new Error(`Stream completion algorithms changed: ${JSON.stringify(counts)}`);
if (readerLockErrors !== 2) throw new Error(`Reader lock errors changed: ${readerLockErrors}`);
const result = transformed.transformed[0];
if (!result) throw new Error("Missing transformed streams source");
const body = ts.createPrinter({ removeComments: true }).printFile(result);
transformed.dispose();
const hooks = `function __bunNodeInvalidState(message) {
  return Object.assign(new TypeError(message), { code: "ERR_INVALID_STATE" });
}
const __bunNodeStreamRecords = new WeakMap();
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
writeFileSync(output, hooks + body + expose);

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bun = join(root, "vendor/bun");
const require = createRequire(join(bun, "package.json"));
const ts = require("typescript");
const build = resolve(process.argv[2] ?? "");
const check = process.argv.includes("--check");
const destination = join(root, "crates/bunwasm-runtime/generated/builtins");
const selection = JSON.parse(readFileSync(join(root, "scripts/bun-builtins.json"), "utf8"));
const revision = execFileSync("git", ["-C", bun, "log", "-1", "--format=%H", "--", "src/js", "src/codegen", "src/jsc/modules/NativeModuleList.h", "src/jsc/bindings/ErrorCode.ts"], { encoding: "utf8" }).trim();
const hash = text => createHash("sha256").update(text).digest("hex");
const blob = readFileSync(join(build, "codegen/InternalModuleRegistryConstants.bin"));
if (blob.subarray(0, 8).toString() !== "BUNBLTNS" || blob.readUInt32LE(8) !== 1) {
  throw new Error("Unsupported Bun builtin registry format");
}
const count = blob.readUInt32LE(16);
const records = blob.readUInt32LE(20);
const dataOffset = blob.readUInt32LE(32);
const fileNames = Array.from(readFileSync(join(build, "codegen/InternalModuleRegistryConstants.h"), "utf8")
  .matchAll(/^  "([^"]+\.js)",?$/gm), match => match[1]);
if (fileNames.length !== count) throw new Error("Bun registry filename count differs from blob");
const nativeNames = Array.from(readFileSync(join(bun, "src/jsc/modules/NativeModuleList.h"), "utf8")
  .matchAll(/macro\("([^"]+)"_s,/g), match => match[1]);
let names = [];
const sources = new Map();
for (let id = 0; id < count; id++) {
  const record = records + id * 24;
  const name = blob.subarray(dataOffset + blob.readUInt32LE(record), dataOffset + blob.readUInt32LE(record) + blob.readUInt32LE(record + 4)).toString();
  names.push(name);
  sources.set(name, readFileSync(join(build, "tmp_modules/modules_out", fileNames[id]), "utf8").replace(/^\/\/.*tmp_modules.*$/gm, ""));
}
names = names.concat(nativeNames);
const hooks = Object.fromEntries(Array.from(readFileSync(join(build, "codegen/GeneratedJS2Native.h"), "utf8")
  .matchAll(/case (\d+): return ([^;]+);/g), match => [Number(match[1]), match[2].replace(/\(global\)/g, "")]));

function intrinsicName(node) {
  return ts.isIdentifier(node) && node.text.startsWith("__intrinsic__") ? node.text.slice(13) : undefined;
}

function describe(source) {
  const intrinsics = new Set();
  const privateNames = new Set();
  const dependencies = new Set();
  const nativeHooks = new Set();
  const tree = ts.createSourceFile("builtin.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function visit(node) {
    const name = intrinsicName(node);
    if (name) intrinsics.add(name);
    if (ts.isPropertyAccessExpression(node) && intrinsicName(node.name) && !["call", "apply", "bind"].includes(intrinsicName(node.name))) privateNames.add(intrinsicName(node.name));
    if (ts.isCallExpression(node)) inspectCall(node);
    ts.forEachChild(node, visit);
  }
  function inspectCall(node) {
    const name = intrinsicName(node.expression);
    if (name === "createInternalModuleById") dependencies.add(Number(node.arguments[0].text));
    if (name === "lazy") nativeHooks.add(Number(node.arguments[0].text));
  }
  visit(tree);
  return { intrinsics: Array.from(intrinsics).sort(), privateNames: Array.from(privateNames).sort(), dependencies: Array.from(dependencies).sort((a, b) => a - b), hooks: Array.from(nativeHooks).sort((a, b) => a - b) };
}
function upstream(id) {
  const path = fileNames[id].replace(/\.js$/, ".ts");
  return existsSync(join(bun, "src/js", path)) ? path : fileNames[id];
}
const catalog = names.map((name, id) => {
  if (id >= count) return { id, name, native: true };
  const source = sources.get(name);
  return { id, name, file: fileNames[id], upstream: upstream(id), sourceSha256: hash(readFileSync(join(bun, "src/js", upstream(id)))), sha256: hash(source), ...describe(source) };
});
const errorsTree = ts.createSourceFile("ErrorCode.ts", readFileSync(join(bun, "src/jsc/bindings/ErrorCode.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const errorCodes = [];
function collectErrors(node) {
  if (ts.isVariableDeclaration(node) && node.name.text === "errors") {
    for (const row of node.initializer.elements) {
      errorCodes.push(row.elements[0].text);
      for (const alternate of row.elements.slice(3)) {
        if (alternate.kind !== ts.SyntaxKind.NullKeyword && alternate.text !== "undefined") errorCodes.push(row.elements[0].text);
      }
    }
  }
  ts.forEachChild(node, collectErrors);
}
collectErrors(errorsTree);
const selected = new Set();
function include(name) {
  const id = names.indexOf(name);
  if (id < 0) throw new Error(`Unknown builtin ${name}`);
  if (id >= count || selected.has(id)) return;
  const original = readFileSync(join(bun, "src/js", upstream(id)), "utf8");
  if (/process\.arch/.test(original)) throw new Error(`Architecture-specialized builtin needs a WASI codegen policy: ${name}`);
  selected.add(id);
  for (const dependency of catalog[id].dependencies) include(names[dependency]);
}
for (const name of selection.modules) include(name);

function lower(source) {
  const tree = ts.createSourceFile("builtin.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const result = ts.transform(tree, [context => {
    const f = context.factory;
    const intrinsic = name => f.createPropertyAccessExpression(f.createIdentifier("intrinsics"), name);
    function visit(node) {
      if (ts.isExpressionStatement(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "$$EXPORT_END$$") {
        const marker = node.expression.expression;
        if (!ts.isCallExpression(marker) || marker.expression.text !== "$$EXPORT$$" || marker.arguments.length !== 1) throw new Error("Unexpected export marker");
        return f.createReturnStatement(ts.visitNode(marker.arguments[0], visit));
      }
      if (ts.isPropertyAccessExpression(node) && intrinsicName(node.name)) return property(node);
      const name = intrinsicName(node);
      if (name) return intrinsic(name);
      if (ts.isIdentifier(node) && node.text.startsWith("__no_intrinsic__")) return f.createIdentifier(node.text.slice(16));
      return ts.visitEachChild(node, visit, context);
    }
    function property(node) {
      const name = intrinsicName(node.name);
      const target = ts.visitNode(node.expression, visit);
      if (["call", "apply", "bind"].includes(name)) return f.createCallExpression(intrinsic("uncurry"), undefined, [target, f.createStringLiteral(name)]);
      return f.createElementAccessExpression(target, f.createCallExpression(intrinsic("privateName"), undefined, [f.createStringLiteral(name)]));
    }
    return node => ts.visitNode(node, visit);
  }]);
  const printed = ts.createPrinter({ removeComments: true }).printFile(result.transformed[0]);
  result.dispose();
  const factory = `(function (intrinsics) {\n"use strict";\n${printed}})\n`;
  new Function(`return ${factory}`);
  return factory;
}

const output = new Map();
output.set("LICENSE.md", readFileSync(join(bun, "LICENSE.md"), "utf8"));
const selectedIds = Array.from(selected).sort((a, b) => a - b);
for (const id of selectedIds) {
  output.set(`${id}.js`, `// Generated from Bun ${revision}, src/js/${upstream(id)}.\n${lower(sources.get(names[id]))}`);
}
output.set("registry.rs", `// Generated by scripts/generate-bun-builtins.mjs.\npub static BUN_BUILTIN_NAMES: &[&str] = &[\n${names.map(name => `    ${JSON.stringify(name)},`).join("\n")}\n];\npub static BUN_BUILTINS: &[(usize, &str)] = &[\n${selectedIds.map(id => `    (${id}, include_str!("${id}.js")),`).join("\n")}\n];\n`);
const strings = values => values.map(value => `    ${JSON.stringify(value)},`).join("\n");
const hookNames = Array.from({ length: Object.keys(hooks).length }, (_, id) => hooks[id]);
output.set("bindings.rs", `// Generated by scripts/generate-bun-builtins.mjs.\npub static BUN_BUILTIN_HOOK_NAMES: &[&str] = &[\n${strings(hookNames)}\n];\npub static BUN_BUILTIN_ERROR_CODES: &[&str] = &[\n${strings(errorCodes)}\n];\n`);
output.set("catalog.json", JSON.stringify({ revision, platform: "linux", arch: "x64", architecturePolicy: "Reject selected sources referencing process.arch", modules: catalog, hooks }, null, 2) + "\n");
mkdirSync(destination, { recursive: true });
for (const [file, text] of output) {
  const path = join(destination, file);
  if (check) {
    if (readFileSync(path, "utf8") !== text) throw new Error(`Generated builtin differs: ${file}`);
  } else writeFileSync(path, text);
}
for (const file of readdirSync(destination)) {
  if (/^\d+\.js$/.test(file) && !output.has(file)) throw new Error(`Remove deselected generated builtin ${file}`);
}
console.log(`${check ? "Checked" : "Generated"} ${selected.size} builtin factories; cataloged ${names.length} modules and ${Object.keys(hooks).length} hooks`);

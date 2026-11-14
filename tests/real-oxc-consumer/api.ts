import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const minifySource = "function answer() { return 40 + 2; } globalThis.__oxcAnswer = answer();";
export const oxcConsumers = [
  { name: "parser", package: "oxc-parser", binding: "@oxc-parser/binding-wasm32-wasi", method: "parseSync", asyncMethod: "parseAsync", filename: "input.ts", source: "export const answer: number = 42;", options: {}, check: checkParser },
  { name: "transform", package: "oxc-transform", binding: "@oxc-transform/binding-wasm32-wasi", method: "transform", asyncMethod: "transformAsync", filename: "input.ts", source: "const answer: number = 40 + 2; globalThis.__oxcAnswer = answer;", options: { cwd: "/", lang: "ts" }, check: checkCode },
  { name: "minify", package: "oxc-minify", binding: "@oxc-minify/binding-wasm32-wasi", method: "minify", filename: "input.js", source: minifySource, options: {}, check: checkMinified },
] as const;
export const oxcAsyncConsumers = oxcConsumers.filter(consumer => "asyncMethod" in consumer);

function requireResult(value: unknown): asserts value is { errors: unknown[] } {
  assert.ok(value && typeof value === "object" && "errors" in value && Array.isArray(value.errors), "Expected an Oxc result");
  assert.deepEqual(value.errors, [], "Oxc reported errors");
}

export function checkParser(value: unknown): void {
  requireResult(value);
  assert.ok("program" in value);
  // Direct NAPI results contain the JSON envelope decoded by the public parser's wrap.js.
  const program = record(typeof value.program === "string" ? record(JSON.parse(value.program)).node : value.program);
  assert.equal(program.type, "Program");
  assert.ok(Array.isArray(program.body));
  assert.equal(program.body.length, 1);
  const declaration = record(program.body[0]);
  assert.equal(declaration.type, "ExportNamedDeclaration");
  const declarations = record(declaration.declaration).declarations;
  assert.ok(Array.isArray(declarations));
  const variable = record(declarations[0]);
  assert.equal(record(variable.id).name, "answer");
  assert.equal(record(variable.init).value, 42);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object");
  return value as Record<string, unknown>;
}

export function checkCode(value: unknown): void {
  requireResult(value);
  assert.ok("code" in value && typeof value.code === "string", "Expected generated JavaScript");
  assert.ok(!value.code.includes(": number"), "TypeScript must be removed");
  const target: { __oxcAnswer?: number } = {};
  new Function("globalThis", value.code)(target);
  assert.equal(target.__oxcAnswer, 42, "Generated JavaScript must compute 42");
}

export function checkMinified(value: unknown): void {
  checkCode(value);
  const code = record(value).code;
  assert.ok(typeof code === "string" && code.length < minifySource.length, "Minification must shorten the source");
}

export function exerciseConsumer(consumer: typeof oxcConsumers[number], api: unknown): void {
  assert.ok(api && typeof api === "object");
  const method: unknown = Reflect.get(api, consumer.method);
  assert.ok(typeof method === "function", `Missing ${consumer.method}`);
  const result: unknown = method(consumer.filename, consumer.source, consumer.options);
  consumer.check(result);
}

export async function exerciseAsyncConsumer(consumer: typeof oxcAsyncConsumers[number], api: unknown): Promise<void> {
  const method: unknown = record(api)[consumer.asyncMethod];
  assert.ok(typeof method === "function", `Missing ${consumer.asyncMethod}`);
  const pending: unknown = method(consumer.filename, consumer.source, consumer.options);
  assert.ok(pending instanceof Promise, `${consumer.asyncMethod} must return a promise`);
  consumer.check(await pending);
}

export function checkPackages(selection: "package" | "binding"): unknown[] {
  const failures: unknown[] = [];
  const evaluated = selection === "package" ? "package evaluated" : "official Wasm binding evaluated";
  const passed = selection === "package" ? "package API passed" : "official Wasm API passed";
  const failure = selection === "package" ? "package selection/API failed" : "direct binding/API failed";
  for (const consumer of oxcConsumers) {
    try {
      const api: unknown = require(consumer[selection]);
      console.log(`${consumer.name} ${evaluated}`);
      exerciseConsumer(consumer, api);
      console.log(`${consumer.name} ${passed}`);
    } catch (error) {
      console.error(`${consumer[selection]} ${failure}`, error);
      failures.push(error);
    }
  }
  return failures;
}

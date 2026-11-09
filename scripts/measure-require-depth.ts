// Native Node preload that reports how deep the CommonJS loader is when a module first loads:
//   REQUIRE_DEPTH_TARGETS=prompts/lib/util/action.js node --import ./scripts/measure-require-depth.ts app.js
// It prints one JSON line per target and exits once every target has loaded, so the application
// never starts. The depth is Node's: an ES module import of a CommonJS package starts a new chain
// here, while the guest loader in crates/bunwasm-runtime/src/js/bootstrap.js nests differently.
import Module from "node:module";

function moduleMethod(name: string) {
  const method: unknown = Reflect.get(Module, name);
  if (typeof method !== "function") throw new TypeError(`Node module method ${name} is unavailable`);
  return method;
}

const resolveFilename = moduleMethod("_resolveFilename");
const pending = new Set((process.env.REQUIRE_DEPTH_TARGETS ?? "").split(",").filter(Boolean));
const loading: string[] = [];
const load = moduleMethod("_load");

function resolved(request: string, parent: unknown, isMain: boolean): string {
  try {
    return String(Reflect.apply(resolveFilename, Module, [request, parent, isMain]));
  } catch {
    return request;
  }
}

function report(filename: string): void {
  const target = Array.from(pending).find((suffix) => filename.endsWith(suffix));
  if (!target) return;
  pending.delete(target);
  const chain = loading.concat(filename);
  console.log(JSON.stringify({ target, depth: chain.length, chain }));
  if (pending.size === 0) process.exit(0);
}

const measured = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  const filename = resolved(request, parent, isMain);
  if (!filename.startsWith("/")) return Reflect.apply(load, this, [request, parent, isMain]);
  report(filename);
  loading.push(filename);
  try {
    return Reflect.apply(load, this, [request, parent, isMain]);
  } finally {
    loading.pop();
  }
};

if (!Reflect.set(Module, "_load", measured)) throw new TypeError("Node module loader is not writable");

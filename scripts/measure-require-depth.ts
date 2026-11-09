// Native Node preload that reports how deep the CommonJS loader is when a module first loads:
//   REQUIRE_DEPTH_TARGETS=prompts/lib/util/action.js node --import ./scripts/measure-require-depth.ts app.js
// It prints one JSON line per target and exits once every target has loaded, so the application
// never starts. The depth is Node's: an ES module import of a CommonJS package starts a new chain
// here, while the guest loader in crates/bunwasm-runtime/src/js/bootstrap.js nests differently.
import Module from "node:module";

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
type Internals = { _load: Loader; _resolveFilename: Loader };

const internals = Module as unknown as Internals;
const pending = new Set((process.env.REQUIRE_DEPTH_TARGETS ?? "").split(",").filter(Boolean));
const loading: string[] = [];
const load = internals._load;

function resolved(request: string, parent: unknown, isMain: boolean): string {
  try {
    return String(internals._resolveFilename(request, parent, isMain));
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

internals._load = function measured(request, parent, isMain) {
  const filename = resolved(request, parent, isMain);
  if (!filename.startsWith("/")) return load.call(this, request, parent, isMain);
  report(filename);
  loading.push(filename);
  try {
    return load.call(this, request, parent, isMain);
  } finally {
    loading.pop();
  }
};

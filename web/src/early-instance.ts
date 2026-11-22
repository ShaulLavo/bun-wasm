// Instantiates a guest as soon as its start message arrives, before the worker loads its
// bootstrap. docs/engine-browser.md, "Early guest instance", has the reason: WebKit collects
// synchronously inside `new WebAssembly.Instance` once the page holds its limit of fast Wasm
// memories, and that collection never returns when a collection cycle is already open in this
// worker while a sleeping worker holds the shared marking threads. At the first message this
// worker has allocated almost nothing, so no cycle is open.
//
// The worker entry imports this module, so it must stay small and import nothing.

/** A guest instance created ahead of its imports. */
export interface EarlyInstance {
  readonly module: WebAssembly.Module;
  readonly instance: WebAssembly.Instance;
  /** Routes the instance's imports to the linked ones. A guest call before this throws. */
  link(imports: WebAssembly.Imports): void;
}

const apply = Reflect.apply;
const moduleImports = WebAssembly.Module.imports;
const Instance = WebAssembly.Instance;

type GuestFunction = (...args: unknown[]) => unknown;

/** The start requests whose guest is one Bun-built module with no start function. */
function eligibleModule(request: unknown): WebAssembly.Module | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const { module, linkPlan, memoryGroup, adapter } = request as Record<string, unknown>;
  if (!(module instanceof WebAssembly.Module)) return undefined;
  // A link plan instantiates several modules itself, a group member imports its memory, and a
  // Preview 1 program is arbitrary user code that may run a start function.
  if (linkPlan || memoryGroup || adapter === "preview1") return undefined;
  return module;
}

function forward(targets: { linked?: WebAssembly.Imports }, namespace: string, name: string): GuestFunction {
  return (...args) => {
    const target = targets.linked?.[namespace]?.[name];
    if (typeof target !== "function") throw new Error(`Guest import ${namespace}.${name} was called before the process linked it`);
    return apply(target, undefined, args);
  };
}

/** The guest instance for a start request, or undefined when the ordinary late path must run. */
export function earlyInstance(request: unknown): EarlyInstance | undefined {
  const module = eligibleModule(request);
  if (!module) return undefined;
  const descriptors = moduleImports(module);
  // Memories, tables and globals cannot be forwarded: their values must exist at instantiation.
  if (descriptors.some(entry => entry.kind !== "function")) return undefined;
  const targets: { linked?: WebAssembly.Imports } = {};
  const forwards: Record<string, Record<string, GuestFunction>> = {};
  for (const { module: namespace, name } of descriptors) (forwards[namespace] ??= {})[name] = forward(targets, namespace, name);
  try {
    const instance = new Instance(module, forwards);
    return { module, instance, link(imports) { targets.linked = imports; } };
  } catch {
    // The late path reports a real instantiation failure with the process's own diagnostics.
    return undefined;
  }
}

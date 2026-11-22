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
const create = Object.create;
const hasOwn = Object.hasOwn;
const moduleImports = WebAssembly.Module.imports;
const Instance = WebAssembly.Instance;

type GuestFunction = (...args: unknown[]) => unknown;
/** One import of the guest: where its calls go once the process is linked. */
interface Slot { readonly namespace: string; readonly name: string; target: GuestFunction | undefined }

/** The start requests whose guest is one module that the loader found to have no start function. */
function eligibleModule(request: unknown): WebAssembly.Module | undefined {
  if (typeof request !== "object" || request === null) return undefined;
  const { module, linkPlan, memoryGroup, adapter, startless } = request as Record<string, unknown>;
  if (!(module instanceof WebAssembly.Module)) return undefined;
  // Instantiating runs a start function, and nothing has checked the process yet. Only the
  // loader, which read the module's bytes, can say there is none.
  if (startless !== true) return undefined;
  // A link plan instantiates several modules itself, a group member imports its memory, and a
  // Preview 1 program is arbitrary user code.
  if (linkPlan || memoryGroup || adapter === "preview1") return undefined;
  return module;
}

function forward(slot: Slot): GuestFunction {
  return (...args) => {
    const target = slot.target;
    if (!target) throw new Error(`Guest import ${slot.namespace}.${slot.name} was called before the process linked it`);
    return apply(target, undefined, args);
  };
}

/** The linked import itself, never a property the imports object or a namespace inherits. */
function linkedImport(linked: WebAssembly.Imports, { namespace, name }: Slot): GuestFunction | undefined {
  if (!hasOwn(linked, namespace)) return undefined;
  const members = linked[namespace]!;
  const value: unknown = hasOwn(members, name) ? members[name] : undefined;
  return typeof value === "function" ? value as GuestFunction : undefined;
}

/** The guest instance for a start request, or undefined when the ordinary late path must run. */
export function earlyInstance(request: unknown): EarlyInstance | undefined {
  const module = eligibleModule(request);
  if (!module) return undefined;
  const descriptors = moduleImports(module);
  // Memories, tables and globals cannot be forwarded: their values must exist at instantiation.
  if (descriptors.some(entry => entry.kind !== "function")) return undefined;
  const slots: Slot[] = [];
  // Import names are the guest's: no prototype, so a name like `constructor` is only a key.
  const forwards: Record<string, Record<string, GuestFunction>> = create(null);
  for (const { module: namespace, name } of descriptors) {
    const slot: Slot = { namespace, name, target: undefined };
    slots.push(slot);
    (forwards[namespace] ??= create(null))[name] = forward(slot);
  }
  try {
    const instance = new Instance(module, forwards);
    // Imports resolve once, at linking, as they do for an ordinary instantiation.
    return { module, instance, link(imports) { for (const slot of slots) slot.target = linkedImport(imports, slot); } };
  } catch {
    // The late path reports a real instantiation failure with the process's own diagnostics.
    return undefined;
  }
}

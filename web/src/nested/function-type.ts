// The JS API does not reflect a function's type, and a function read from a table has no export
// name to look one up by. Linking does compare the type, exactly and without calling anything: a
// WebAssembly function supplied for an import of another type is a LinkError. That check is the
// authority here, so a type is never guessed.
import { compileSections, section, unsigned, utf8Name } from "./binary.js";
import type { FunctionType, ValueName } from "./module-info.js";

/** A WebAssembly function as the JS API hands it out: one object per function. */
export type WasmFunction = (...args: unknown[]) => unknown;

const CODES: Record<ValueName, number> = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c, v128: 0x7b, funcref: 0x70, externref: 0x6f };
const IMPORT = utf8Name("f").concat(utf8Name("f"), [0, 0]);

function signatureKey(type: FunctionType): string { return `${type.params.join()}>${type.results.join()}`; }

function values(names: readonly ValueName[]): number[] {
  return unsigned(names.length).concat(names.map(item => CODES[item]));
}

/** A module that is one function import of `type` and nothing else: no code, memory or start. */
function importer(type: FunctionType): WebAssembly.Module {
  const signature = [1, 0x60].concat(values(type.params), values(type.results));
  return compileSections(section(1, signature), section(2, [1].concat(IMPORT)));
}

/** One member's type checks. An importer is compiled once per signature and kept for the session. */
export class FunctionTypes {
  private readonly importers = new Map<string, WebAssembly.Module>();

  private links(fn: WasmFunction, key: string, type: FunctionType): boolean {
    let module = this.importers.get(key);
    if (!module) this.importers.set(key, module = importer(type));
    try {
      new WebAssembly.Instance(module, { f: { f: fn } });
      return true;
    } catch (error) {
      if (error instanceof WebAssembly.LinkError) return false;
      throw error;
    }
  }

  /** The first candidate `fn` links as. Candidates may repeat: each signature is tried once. */
  find(fn: WasmFunction, candidates: Iterable<FunctionType>): FunctionType | undefined {
    const tried = new Set<string>();
    for (const type of candidates) {
      const key = signatureKey(type);
      // A WebAssembly function's length is its parameter count.
      if (type.params.length !== fn.length || tried.has(key)) continue;
      tried.add(key);
      if (this.links(fn, key, type)) return type;
    }
    return undefined;
  }
}

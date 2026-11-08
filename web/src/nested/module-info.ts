// Types the JS API does not reflect: a regionized module's import and export signatures. The
// core already validated these bytes, so this reads only what the host must report.

export type ValueName = "i32" | "i64" | "f32" | "f64" | "v128" | "ref";

export interface FunctionType {
  readonly params: readonly ValueName[];
  readonly results: readonly ValueName[];
}

export type ImportInfo =
  | { readonly kind: "function"; readonly module: string; readonly name: string; readonly type: FunctionType }
  | { readonly kind: "global"; readonly module: string; readonly name: string; readonly value: ValueName; readonly mutable: boolean }
  | { readonly kind: "other"; readonly module: string; readonly name: string };

export interface ModuleInfo {
  readonly imports: readonly ImportInfo[];
  readonly exports: ReadonlyMap<string, FunctionType>;
}

const SECTION_TYPE = 1, SECTION_IMPORT = 2, SECTION_FUNCTION = 3, SECTION_EXPORT = 7;
const decoder = new TextDecoder();

class Reader {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  done() { return this.at >= this.bytes.length; }
  byte(): number {
    const value = this.bytes[this.at++];
    if (value === undefined) throw new TypeError("Truncated nested module");
    return value;
  }
  u32(): number {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw new TypeError("Invalid nested module integer");
  }
  name(): string {
    const length = this.u32();
    this.at += length;
    return decoder.decode(this.bytes.subarray(this.at - length, this.at));
  }
  section(size: number): Reader {
    const section = new Reader(this.bytes.subarray(this.at, this.at + size));
    this.at += size;
    return section;
  }
}

function valueType(reader: Reader): ValueName {
  const byte = reader.byte();
  if (byte === 0x7f) return "i32";
  if (byte === 0x7e) return "i64";
  if (byte === 0x7d) return "f32";
  if (byte === 0x7c) return "f64";
  if (byte === 0x7b) return "v128";
  if (byte === 0x70 || byte === 0x6f) return "ref";
  throw new TypeError(`Unsupported nested value type 0x${byte.toString(16)}`);
}

function valueList(reader: Reader): ValueName[] {
  return Array.from({ length: reader.u32() }, () => valueType(reader));
}

function readTypes(reader: Reader): FunctionType[] {
  return Array.from({ length: reader.u32() }, () => {
    if (reader.byte() !== 0x60) throw new TypeError("Nested module has an unsupported type form");
    return { params: valueList(reader), results: valueList(reader) };
  });
}

function skipLimits(reader: Reader): void {
  const flags = reader.byte();
  reader.u32();
  if (flags & 1) reader.u32();
}

function functionType(types: readonly FunctionType[], index: number): FunctionType {
  const type = types[index];
  if (!type) throw new TypeError("Nested module function type index is out of range");
  return type;
}

function readImport(reader: Reader, types: readonly FunctionType[], functions: FunctionType[]): ImportInfo {
  const module = reader.name(), name = reader.name(), kind = reader.byte();
  if (kind === 0) {
    const type = functionType(types, reader.u32());
    functions.push(type);
    return { kind: "function", module, name, type };
  }
  if (kind === 3) {
    const value = valueType(reader);
    return { kind: "global", module, name, value, mutable: reader.byte() === 1 };
  }
  if (kind === 1) reader.byte();
  if (kind !== 1 && kind !== 2) throw new TypeError("Nested module has an unsupported import form");
  skipLimits(reader);
  return { kind: "other", module, name };
}

function readExports(reader: Reader, functions: readonly FunctionType[], exports: Map<string, FunctionType>): void {
  for (let count = reader.u32(); count > 0; count--) {
    const name = reader.name(), kind = reader.byte(), index = reader.u32();
    if (kind !== 0) continue;
    const type = functions[index];
    if (!type) throw new TypeError("Nested module exports an unknown function");
    exports.set(name, type);
  }
}

export function readModuleInfo(bytes: Uint8Array): ModuleInfo {
  const module = new Reader(bytes);
  module.at = 8;
  let types: FunctionType[] = [];
  const functions: FunctionType[] = [];
  const imports: ImportInfo[] = [];
  const exports = new Map<string, FunctionType>();
  while (!module.done()) {
    const id = module.byte();
    const section = module.section(module.u32());
    if (id === SECTION_TYPE) types = readTypes(section);
    if (id === SECTION_IMPORT) for (let count = section.u32(); count > 0; count--) imports.push(readImport(section, types, functions));
    if (id === SECTION_FUNCTION) for (let count = section.u32(); count > 0; count--) functions.push(functionType(types, section.u32()));
    if (id === SECTION_EXPORT) readExports(section, functions, exports);
  }
  return { imports, exports };
}

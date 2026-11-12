// Types the JS API does not reflect: a regionized module's import and export signatures. The
// core already validated these bytes, so this reads only what the host must report.

export type ReferenceName = "funcref" | "externref";
export type ValueName = "i32" | "i64" | "f32" | "f64" | "v128" | ReferenceName;

export interface FunctionType {
  readonly params: readonly ValueName[];
  readonly results: readonly ValueName[];
}

export interface GlobalType {
  readonly value: ValueName;
  readonly mutable: boolean;
}

export function isReference(name: ValueName): name is ReferenceName {
  return name === "funcref" || name === "externref";
}

export type ImportInfo =
  | { readonly kind: "function"; readonly module: string; readonly name: string; readonly type: FunctionType }
  | { readonly kind: "global"; readonly module: string; readonly name: string; readonly value: ValueName; readonly mutable: boolean }
  | { readonly kind: "other"; readonly module: string; readonly name: string };

/** A table's element type. `undefined` is a form this reader does not decode. */
type TableElement = ReferenceName | undefined;

export interface ModuleInfo {
  readonly imports: readonly ImportInfo[];
  readonly exports: ReadonlyMap<string, FunctionType>;
  /** The type section: every signature a function of this module can have. */
  readonly types: readonly FunctionType[];
  /** The function index space, imports first. */
  readonly functions: readonly FunctionType[];
  /** Each exported table's element type, by export name. */
  readonly tables: ReadonlyMap<string, TableElement>;
  /** Each exported global's declared type; `undefined` is a form this reader does not decode. */
  readonly globals: ReadonlyMap<string, GlobalType | undefined>;
}

const SECTION_TYPE = 1, SECTION_IMPORT = 2, SECTION_FUNCTION = 3, SECTION_TABLE = 4, SECTION_GLOBAL = 6, SECTION_EXPORT = 7;
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
  const value = valueName(byte);
  if (value) return value;
  throw new TypeError(`Unsupported nested value type 0x${byte.toString(16)}`);
}

function valueName(byte: number): ValueName | undefined {
  if (byte === 0x7f) return "i32";
  if (byte === 0x7e) return "i64";
  if (byte === 0x7d) return "f32";
  if (byte === 0x7c) return "f64";
  if (byte === 0x7b) return "v128";
  return referenceType(byte);
}

function referenceType(byte: number): TableElement {
  if (byte === 0x70) return "funcref";
  return byte === 0x6f ? "externref" : undefined;
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

/** The index spaces an export names, in declaration order: imports first. */
interface Spaces {
  types: FunctionType[];
  readonly functions: FunctionType[];
  readonly tables: TableElement[];
  readonly globals: (GlobalType | undefined)[];
}

function readImport(reader: Reader, spaces: Spaces): ImportInfo {
  const module = reader.name(), name = reader.name(), kind = reader.byte();
  if (kind === 0) {
    const type = functionType(spaces.types, reader.u32());
    spaces.functions.push(type);
    return { kind: "function", module, name, type };
  }
  if (kind === 3) {
    const value = valueType(reader);
    const mutable = reader.byte() === 1;
    spaces.globals.push({ value, mutable });
    return { kind: "global", module, name, value, mutable };
  }
  if (kind === 1) spaces.tables.push(referenceType(reader.byte()));
  if (kind !== 1 && kind !== 2) throw new TypeError("Nested module has an unsupported import form");
  skipLimits(reader);
  return { kind: "other", module, name };
}

/** An entry in another form has an unknown length, so it and every later table stay undecoded. */
function readTables(reader: Reader, tables: TableElement[]): void {
  for (let count = reader.u32(); count > 0; count--) {
    const element = referenceType(reader.byte());
    if (!element) return;
    tables.push(element);
    skipLimits(reader);
  }
}

/** Signed i64 immediates need up to ten bytes; their value is irrelevant to traversal. */
function skipLeb(reader: Reader): void {
  while (reader.byte() & 0x80) { /* consume the whole immediate */ }
}

function skipInitializer(reader: Reader): boolean {
  while (!reader.done()) {
    const opcode = reader.byte();
    if (opcode === 0x0b) return true;
    if (opcode === 0x41 || opcode === 0x42 || opcode === 0x23 || opcode === 0xd0 || opcode === 0xd2) skipLeb(reader);
    else if (opcode === 0x43) reader.at += 4;
    else if (opcode === 0x44) reader.at += 8;
    else if (opcode === 0xfd && reader.u32() === 12) reader.at += 16;
    else return false;
  }
  return false;
}

/** Unknown declaration lengths or initializers leave every later global undecoded. */
function readGlobals(reader: Reader, globals: (GlobalType | undefined)[]): void {
  for (let count = reader.u32(); count > 0; count--) {
    const value = valueName(reader.byte());
    if (!value) return;
    globals.push({ value, mutable: reader.byte() === 1 });
    if (!skipInitializer(reader)) return;
  }
}

function readExports(reader: Reader, spaces: Spaces, exports: Map<string, FunctionType>, tables: Map<string, TableElement>, globals: Map<string, GlobalType | undefined>): void {
  for (let count = reader.u32(); count > 0; count--) {
    const name = reader.name(), kind = reader.byte(), index = reader.u32();
    if (kind === 1) tables.set(name, spaces.tables[index]);
    if (kind === 3) globals.set(name, spaces.globals[index]);
    if (kind !== 0) continue;
    const type = spaces.functions[index];
    if (!type) throw new TypeError("Nested module exports an unknown function");
    exports.set(name, type);
  }
}

export function readModuleInfo(bytes: Uint8Array): ModuleInfo {
  const module = new Reader(bytes);
  module.at = 8;
  const spaces: Spaces = { types: [], functions: [], tables: [], globals: [] };
  const imports: ImportInfo[] = [];
  const exports = new Map<string, FunctionType>();
  const tables = new Map<string, TableElement>();
  const globals = new Map<string, GlobalType | undefined>();
  while (!module.done()) {
    const id = module.byte();
    const section = module.section(module.u32());
    if (id === SECTION_TYPE) spaces.types = readTypes(section);
    if (id === SECTION_IMPORT) for (let count = section.u32(); count > 0; count--) imports.push(readImport(section, spaces));
    if (id === SECTION_FUNCTION) for (let count = section.u32(); count > 0; count--) spaces.functions.push(functionType(spaces.types, section.u32()));
    if (id === SECTION_TABLE) readTables(section, spaces.tables);
    if (id === SECTION_GLOBAL) readGlobals(section, spaces.globals);
    if (id === SECTION_EXPORT) readExports(section, spaces, exports, tables, globals);
  }
  return { imports, exports, types: spaces.types, functions: spaces.functions, tables, globals };
}

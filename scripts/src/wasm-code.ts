// Reads one function's instructions from a wasm module, for checks that inspect linked code.
// Anything this reader does not know is an error, never skipped: its callers are safety gates.

export class WasmShapeError extends Error {}

export interface WasmFunction {
  readonly index: number;
  readonly name: string;
  readonly parameters: number;
  /** Declared locals, excluding parameters. */
  readonly locals: number;
  readonly localBytes: number;
  /** First instruction and one past the function's final `end`. */
  readonly code: { readonly start: number; readonly end: number };
}

export interface WasmModule {
  readonly bytes: Uint8Array;
  readonly importedGlobals: readonly string[];
  readonly exportedGlobals: ReadonlyMap<string, number>;
  readonly functions: readonly WasmFunction[];
}

export interface Instruction {
  readonly at: number;
  readonly opcode: number;
  /** The operator after a 0xfc, 0xfd or 0xfe prefix, otherwise 0. */
  readonly extended: number;
  /** A local, global, function or label index, or a signed i32 constant. */
  readonly operand: number;
}

const valueBytes = new Map([[0x7f, 4], [0x7e, 8], [0x7d, 4], [0x7c, 8], [0x7b, 16], [0x70, 4], [0x6f, 4]]);

class Cursor {
  constructor(readonly bytes: Uint8Array, public at: number, readonly end: number) {}
  byte(): number {
    if (this.at >= this.end) throw new WasmShapeError("truncated wasm");
    return this.bytes[this.at++]!;
  }
  unsigned(): number {
    let value = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      const byte = this.byte();
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
    throw new WasmShapeError("overlong LEB128");
  }
  signed32(): number {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      value |= (byte & 0x7f) << shift;
      if (byte & 0x80) continue;
      return shift < 28 && byte & 0x40 ? value | (-1 << (shift + 7)) : value;
    }
    throw new WasmShapeError("overlong LEB128");
  }
  skip(count: number): void {
    if (this.at + count > this.end) throw new WasmShapeError("truncated wasm");
    this.at += count;
  }
  text(): string {
    const length = this.unsigned();
    const start = this.at;
    this.skip(length);
    return new TextDecoder().decode(this.bytes.subarray(start, this.at));
  }
  within(length: number): Cursor {
    const start = this.at;
    this.skip(length);
    return new Cursor(this.bytes, start, this.at);
  }
}

function skipLimits(cursor: Cursor): void {
  const flags = cursor.byte();
  cursor.unsigned();
  if (flags & 1) cursor.unsigned();
}

function skipImport(cursor: Cursor, kind: number): void {
  if (kind === 0) cursor.unsigned();
  else if (kind === 1) { cursor.byte(); skipLimits(cursor); }
  else if (kind === 2) skipLimits(cursor);
  else if (kind === 3) cursor.skip(2);
  else if (kind === 4) { cursor.byte(); cursor.unsigned(); }
  else throw new WasmShapeError(`unknown import kind ${kind}`);
}

interface Imports { readonly functions: number; readonly globals: string[] }

function readImports(cursor: Cursor): Imports {
  const imports: Imports = { functions: 0, globals: [] };
  let functions = 0;
  for (let count = cursor.unsigned(); count > 0; count--) {
    const name = `${cursor.text()}.${cursor.text()}`;
    const kind = cursor.byte();
    if (kind === 0) functions++;
    if (kind === 3) imports.globals.push(name);
    skipImport(cursor, kind);
  }
  return { functions, globals: imports.globals };
}

function readParameterCounts(cursor: Cursor): number[] {
  const counts: number[] = [];
  for (let count = cursor.unsigned(); count > 0; count--) {
    if (cursor.byte() !== 0x60) throw new WasmShapeError("unsupported type form");
    const parameters = cursor.unsigned();
    cursor.skip(parameters);
    cursor.skip(cursor.unsigned());
    counts.push(parameters);
  }
  return counts;
}

function readVector(cursor: Cursor): number[] {
  return Array.from({ length: cursor.unsigned() }, () => cursor.unsigned());
}

function readGlobalExports(cursor: Cursor): Map<string, number> {
  const globals = new Map<string, number>();
  for (let count = cursor.unsigned(); count > 0; count--) {
    const name = cursor.text();
    const kind = cursor.byte();
    const index = cursor.unsigned();
    if (kind === 3) globals.set(name, index);
  }
  return globals;
}

function readFunctionNames(cursor: Cursor): Map<number, string> {
  const names = new Map<number, string>();
  while (cursor.at < cursor.end) {
    const id = cursor.byte();
    const subsection = cursor.within(cursor.unsigned());
    if (id !== 1) continue;
    for (let count = subsection.unsigned(); count > 0; count--) names.set(subsection.unsigned(), subsection.text());
  }
  return names;
}

interface Body { readonly locals: number; readonly localBytes: number; readonly start: number; readonly end: number }

function readBodies(cursor: Cursor): Body[] {
  const bodies: Body[] = [];
  for (let count = cursor.unsigned(); count > 0; count--) {
    const body = cursor.within(cursor.unsigned());
    let locals = 0;
    let localBytes = 0;
    for (let groups = body.unsigned(); groups > 0; groups--) {
      const size = body.unsigned();
      const bytes = valueBytes.get(body.byte());
      if (bytes === undefined) throw new WasmShapeError("unknown local type");
      locals += size;
      localBytes += size * bytes;
    }
    bodies.push({ locals, localBytes, start: body.at, end: body.end });
  }
  return bodies;
}

export function readWasmModule(bytes: Uint8Array): WasmModule {
  if (bytes.length < 8 || bytes.subarray(0, 8).join() !== "0,97,115,109,1,0,0,0") throw new WasmShapeError("not a wasm module");
  const cursor = new Cursor(bytes, 8, bytes.length);
  let imports: Imports = { functions: 0, globals: [] };
  let parameterCounts: number[] = [];
  let types: number[] = [];
  let exportedGlobals = new Map<string, number>();
  let bodies: Body[] = [];
  let names = new Map<number, string>();
  while (cursor.at < cursor.end) {
    const id = cursor.byte();
    const section = cursor.within(cursor.unsigned());
    if (id === 1) parameterCounts = readParameterCounts(section);
    else if (id === 2) imports = readImports(section);
    else if (id === 3) types = readVector(section);
    else if (id === 7) exportedGlobals = readGlobalExports(section);
    else if (id === 10) bodies = readBodies(section);
    else if (id === 0 && section.text() === "name") names = readFunctionNames(section);
  }
  if (types.length !== bodies.length) throw new WasmShapeError("function and code sections disagree");
  const functions = bodies.map((body, position) => {
    const index = imports.functions + position;
    const parameters = parameterCounts[types[position]!];
    if (parameters === undefined) throw new WasmShapeError(`function ${index} has no type`);
    return { index, name: names.get(index) ?? "", parameters, locals: body.locals, localBytes: body.localBytes, code: { start: body.start, end: body.end } };
  });
  return { bytes, importedGlobals: imports.globals, exportedGlobals, functions };
}

const valueTypeOrEmpty = new Set([0x40, 0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f]);

function skipBlockType(cursor: Cursor): void {
  if (valueTypeOrEmpty.has(cursor.bytes[cursor.at] ?? -1)) cursor.at++;
  else cursor.signed32();
}

function skipMemoryArgument(cursor: Cursor): void {
  if (cursor.unsigned() & 0x40) cursor.unsigned();
  cursor.unsigned();
}

// Bulk memory and saturating conversions (0xfc).
function skipMiscellaneous(cursor: Cursor, operator: number): void {
  if (operator <= 7) return;
  if (operator === 8 || operator === 12 || operator === 14) { cursor.unsigned(); cursor.unsigned(); }
  else if (operator === 10) cursor.skip(2);
  else if (operator === 11) cursor.skip(1);
  else if (operator === 9 || operator === 13 || (operator >= 15 && operator <= 17)) cursor.unsigned();
  else throw new WasmShapeError(`unknown 0xfc operator ${operator}`);
}

// Fixed-width SIMD (0xfd).
function skipVector(cursor: Cursor, operator: number): void {
  if (operator <= 11 || operator === 92 || operator === 93) skipMemoryArgument(cursor);
  else if (operator === 12 || operator === 13) cursor.skip(16);
  else if (operator >= 21 && operator <= 34) cursor.skip(1);
  else if (operator >= 84 && operator <= 91) { skipMemoryArgument(cursor); cursor.skip(1); }
  else if (operator > 275) throw new WasmShapeError(`unknown 0xfd operator ${operator}`);
}

// Threads (0xfe).
function skipAtomic(cursor: Cursor, operator: number): void {
  if (operator <= 2 || (operator >= 0x10 && operator <= 0x4e)) skipMemoryArgument(cursor);
  else if (operator === 3) cursor.skip(1);
  else throw new WasmShapeError(`unknown 0xfe operator ${operator}`);
}

const indexOperand = new Set([0x0c, 0x0d, 0x10, 0x12, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0xd2]);
const noOperand = (opcode: number) => opcode <= 0x01 || opcode === 0x05 || opcode === 0x0b || opcode === 0x0f || opcode === 0x1a
  || opcode === 0x1b || (opcode >= 0x45 && opcode <= 0xc4) || opcode === 0xd1;

function readOperand(cursor: Cursor, opcode: number): { extended: number; operand: number } {
  let extended = 0;
  let operand = 0;
  if (noOperand(opcode)) return { extended, operand };
  if (indexOperand.has(opcode)) operand = cursor.unsigned();
  else if (opcode === 0x41) operand = cursor.signed32();
  else if (opcode >= 0x02 && opcode <= 0x04) skipBlockType(cursor);
  else if (opcode === 0x0e) { for (let count = cursor.unsigned(); count >= 0; count--) cursor.unsigned(); }
  else if (opcode === 0x11 || opcode === 0x13) { cursor.unsigned(); cursor.unsigned(); }
  else if (opcode === 0x1c) cursor.skip(cursor.unsigned());
  else if (opcode >= 0x28 && opcode <= 0x3e) skipMemoryArgument(cursor);
  else if (opcode === 0x3f || opcode === 0x40 || opcode === 0xd0) cursor.skip(1);
  else if (opcode === 0x42) cursor.unsigned();
  else if (opcode === 0x43) cursor.skip(4);
  else if (opcode === 0x44) cursor.skip(8);
  else if (opcode === 0xfc) skipMiscellaneous(cursor, extended = cursor.unsigned());
  else if (opcode === 0xfd) skipVector(cursor, extended = cursor.unsigned());
  else if (opcode === 0xfe) skipAtomic(cursor, extended = cursor.unsigned());
  else throw new WasmShapeError(`unknown opcode 0x${opcode.toString(16)}`);
  return { extended, operand };
}

/** Every instruction of the function, in order, including its final `end`. */
export function readInstructions(module: WasmModule, target: WasmFunction): Instruction[] {
  const cursor = new Cursor(module.bytes, target.code.start, target.code.end);
  const instructions: Instruction[] = [];
  while (cursor.at < cursor.end) {
    const at = cursor.at;
    const opcode = cursor.byte();
    instructions.push({ at, opcode, ...readOperand(cursor, opcode) });
  }
  return instructions;
}

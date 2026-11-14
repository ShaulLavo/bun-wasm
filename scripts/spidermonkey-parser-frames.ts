// Static recursion-frame facts for SpiderMonkey's parser in a linked wasm module.
//
// A wasm host stack pays one frame for every C++ function in a parser recursion cycle. The WASI
// patch merges the statement and expression cycles with inline attributes
// (docs/bun-patches/spidermonkey-frontend-frames.md). A lost inline is silent, so this check
// reads the module's name section and call graph and asserts, for each of the four parser
// instantiations, that the merged members are gone and the surviving cycle calls itself.
//   bun scripts/spidermonkey-parser-frames.ts <module.wasm>...
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

type Cursor = { offset: number };
type FunctionType = { params: number; results: number };
type Block = { base: number; params: number; results: number };

type FunctionFacts = {
  index: number;
  name: string;
  params: number;
  locals: number;
  stack: number;
  slots: number;
  shadow: number;
  bytes: number;
  calls: Set<number>;
};

class Reader {
  constructor(readonly bytes: Uint8Array) {}

  byte(cursor: Cursor): number {
    const value = this.bytes[cursor.offset++];
    if (value === undefined) throw new Error("truncated wasm module");
    return value;
  }

  u32(cursor: Cursor): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const value = this.byte(cursor);
      result += (value & 127) * 2 ** shift;
      if (!(value & 128)) return result;
      shift += 7;
    }
  }

  skipLeb(cursor: Cursor): void {
    while (this.byte(cursor) & 128);
  }

  text(cursor: Cursor): string {
    const length = this.u32(cursor);
    const value = Buffer.from(this.bytes.subarray(cursor.offset, cursor.offset + length)).toString();
    cursor.offset += length;
    return value;
  }

  limits(cursor: Cursor): void {
    const flags = this.u32(cursor);
    this.u32(cursor);
    if (flags & 1) this.u32(cursor);
  }
}

type Module = {
  reader: Reader;
  types: FunctionType[];
  functionTypes: number[];
  imports: number;
  names: Map<number, string>;
  bodies: { start: number; end: number }[];
};

function readTypes(reader: Reader, cursor: Cursor, types: FunctionType[]): void {
  const count = reader.u32(cursor);
  for (let i = 0; i < count; i++) {
    const form = reader.byte(cursor);
    if (form !== 0x60) throw new Error(`unsupported type form ${form}`);
    const params = reader.u32(cursor);
    cursor.offset += params;
    const results = reader.u32(cursor);
    cursor.offset += results;
    types.push({ params, results });
  }
}

// Returns 1 for a function import, 0 for any other import.
function readImport(reader: Reader, cursor: Cursor, functionTypes: number[]): number {
  reader.text(cursor);
  reader.text(cursor);
  const kind = reader.byte(cursor);
  if (kind === 0) {
    functionTypes.push(reader.u32(cursor));
    return 1;
  }
  if (kind === 1) {
    cursor.offset++;
    reader.limits(cursor);
  } else if (kind === 2) {
    reader.limits(cursor);
  } else if (kind === 3) {
    cursor.offset += 2;
  } else {
    cursor.offset++;
    reader.u32(cursor);
  }
  return 0;
}

function readNames(reader: Reader, cursor: Cursor, end: number, names: Map<number, string>): void {
  while (cursor.offset < end) {
    const id = reader.byte(cursor);
    const size = reader.u32(cursor);
    const next = cursor.offset + size;
    if (id === 1) {
      const count = reader.u32(cursor);
      for (let i = 0; i < count; i++) names.set(reader.u32(cursor), reader.text(cursor));
    }
    cursor.offset = next;
  }
}

function readSection(module: Module, id: number, cursor: Cursor, end: number): void {
  const { reader } = module;
  if (id === 1) return readTypes(reader, cursor, module.types);
  if (id === 2) {
    const count = reader.u32(cursor);
    for (let i = 0; i < count; i++) module.imports += readImport(reader, cursor, module.functionTypes);
    return;
  }
  if (id === 3) {
    const count = reader.u32(cursor);
    for (let i = 0; i < count; i++) module.functionTypes.push(reader.u32(cursor));
    return;
  }
  if (id === 10) {
    const count = reader.u32(cursor);
    for (let i = 0; i < count; i++) {
      const size = reader.u32(cursor);
      module.bodies.push({ start: cursor.offset, end: cursor.offset + size });
      cursor.offset += size;
    }
    return;
  }
  if (id === 0 && reader.text(cursor) === "name") readNames(reader, cursor, end, module.names);
}

function readModule(bytes: Uint8Array): Module {
  const reader = new Reader(bytes);
  assert.deepEqual(Array.from(bytes.subarray(0, 8)), [0, 97, 115, 109, 1, 0, 0, 0], "expected a wasm module");
  const module: Module = { reader, types: [], functionTypes: [], imports: 0, names: new Map(), bodies: [] };
  const cursor = { offset: 8 };
  while (cursor.offset < bytes.length) {
    const id = reader.byte(cursor);
    const size = reader.u32(cursor);
    const end = cursor.offset + size;
    readSection(module, id, cursor, end);
    cursor.offset = end;
  }
  assert(module.names.size > 0, "the module has no function names");
  return module;
}

// The prologue of a function with a shadow-stack frame is `global.get sp; i32.const N; i32.sub`.
function shadowFrame(reader: Reader, start: number, end: number): number {
  const { bytes } = reader;
  const limit = Math.min(end, start + 24);
  for (let at = start; at < limit - 3; at++) {
    if (bytes[at] !== 0x23) continue;
    const probe = { offset: at + 1 };
    reader.u32(probe);
    if (bytes[probe.offset] !== 0x41) continue;
    probe.offset++;
    const size = reader.u32(probe);
    if (bytes[probe.offset] === 0x6b) return size;
  }
  return 0;
}

function blockType(module: Module, code: Cursor): FunctionType {
  const value = module.reader.bytes[code.offset];
  assert(value !== undefined, "truncated block type");
  if (value === 0x40) {
    code.offset++;
    return { params: 0, results: 0 };
  }
  if (value >= 0x6f && value <= 0x7f) {
    code.offset++;
    return { params: 0, results: 1 };
  }
  const type = module.types[module.reader.u32(code)];
  assert(type, "invalid block type index");
  return type;
}

function miscEffect(reader: Reader, code: Cursor): [number, number] {
  const sub = reader.u32(code);
  if (sub <= 7) return [1, 1];
  if (sub === 8) return reader.skipLeb(code), code.offset++, [3, 0];
  if (sub === 9 || sub === 13) return reader.skipLeb(code), [0, 0];
  if (sub === 10) return (code.offset += 2), [3, 0];
  if (sub === 11) return code.offset++, [3, 0];
  if (sub === 12 || sub === 14) return reader.skipLeb(code), reader.skipLeb(code), [3, 0];
  if (sub === 15) return reader.skipLeb(code), [2, 1];
  if (sub === 16) return reader.skipLeb(code), [0, 1];
  if (sub === 17) return reader.skipLeb(code), [3, 0];
  throw new Error(`unsupported 0xfc opcode ${sub}`);
}

function memoryEffect(reader: Reader, op: number, code: Cursor): [number, number] | undefined {
  if (op >= 0x28 && op <= 0x35) return reader.skipLeb(code), reader.skipLeb(code), [1, 1];
  if (op >= 0x36 && op <= 0x3e) return reader.skipLeb(code), reader.skipLeb(code), [2, 0];
  if (op === 0x3f) return code.offset++, [0, 1];
  if (op === 0x40) return code.offset++, [1, 1];
  return undefined;
}

function numericEffect(op: number): [number, number] {
  if (op === 0x45 || op === 0x50) return [1, 1];
  if (op >= 0x46 && op <= 0x66) return [2, 1];
  if ((op >= 0x67 && op <= 0x69) || (op >= 0x79 && op <= 0x7b)) return [1, 1];
  if ((op >= 0x6a && op <= 0x78) || (op >= 0x7c && op <= 0x8a)) return [2, 1];
  if ((op >= 0x8b && op <= 0x91) || (op >= 0x99 && op <= 0x9f)) return [1, 1];
  if ((op >= 0x92 && op <= 0x98) || (op >= 0xa0 && op <= 0xa6)) return [2, 1];
  if (op >= 0xa7 && op <= 0xc4) return [1, 1];
  throw new Error(`unsupported opcode 0x${op.toString(16)}`);
}

// Operand-stack effect of one non-control opcode as [pops, pushes], consuming its immediates.
function plainEffect(reader: Reader, op: number, code: Cursor): [number, number] {
  if (op === 0x01) return [0, 0];
  if (op === 0x1a) return [1, 0];
  if (op === 0x1b) return [3, 1];
  if (op === 0x1c) return (code.offset += reader.u32(code)), [3, 1];
  if (op === 0x20 || op === 0x23) return reader.skipLeb(code), [0, 1];
  if (op === 0x21 || op === 0x24) return reader.skipLeb(code), [1, 0];
  if (op === 0x22 || op === 0x25) return reader.skipLeb(code), [1, 1];
  if (op === 0x26) return reader.skipLeb(code), [2, 0];
  const memory = memoryEffect(reader, op, code);
  if (memory) return memory;
  if (op === 0x41 || op === 0x42) return reader.skipLeb(code), [0, 1];
  if (op === 0x43) return (code.offset += 4), [0, 1];
  if (op === 0x44) return (code.offset += 8), [0, 1];
  if (op === 0xd0) return code.offset++, [0, 1];
  if (op === 0xd1) return [1, 1];
  if (op === 0xd2) return reader.skipLeb(code), [0, 1];
  if (op === 0xfc) return miscEffect(reader, code);
  return numericEffect(op);
}

class BodyWalk {
  readonly blocks: Block[];
  height = 0;
  deepest = 0;
  dead = false;
  readonly calls = new Set<number>();

  constructor(readonly module: Module, readonly code: Cursor, results: number) {
    this.blocks = [{ base: 0, params: 0, results }];
  }

  push(pops: number, pushes: number): void {
    if (this.dead) return;
    this.height += pushes - pops;
    this.deepest = Math.max(this.deepest, this.height);
  }

  enter(op: number): void {
    if (op === 0x04) this.push(1, 0);
    const type = blockType(this.module, this.code);
    this.blocks.push({ base: this.height - type.params, params: type.params, results: type.results });
  }

  // Returns false when the function's outermost block ends.
  control(op: number): boolean {
    const block = op === 0x05 ? this.blocks.at(-1) : this.blocks.pop();
    if (!block) return false;
    this.height = block.base + (op === 0x05 ? block.params : block.results);
    this.dead = false;
    return true;
  }

  call(indirect: boolean): void {
    const { reader, types, functionTypes } = this.module;
    const target = reader.u32(this.code);
    if (indirect) reader.skipLeb(this.code);
    const typeIndex = indirect ? target : functionTypes[target];
    const type = typeIndex === undefined ? undefined : types[typeIndex];
    assert(type, "invalid call target");
    if (!indirect) this.calls.add(target);
    this.push(type.params + (indirect ? 1 : 0), type.results);
  }

  branch(op: number): void {
    const { reader } = this.module;
    if (op === 0x0d) {
      reader.skipLeb(this.code);
      this.push(1, 0);
      return;
    }
    if (op === 0x0e) {
      const count = reader.u32(this.code);
      for (let i = 0; i <= count; i++) reader.skipLeb(this.code);
    } else if (op === 0x0c) {
      reader.skipLeb(this.code);
    }
    this.dead = true;
  }

  // Returns false at the end of the body.
  step(op: number): boolean {
    if (op === 0x02 || op === 0x03 || op === 0x04) return this.enter(op), true;
    if (op === 0x05 || op === 0x0b) return this.control(op);
    if (op === 0x00 || op === 0x0f) return (this.dead = true), true;
    if (op === 0x0c || op === 0x0d || op === 0x0e) return this.branch(op), true;
    if (op === 0x10 || op === 0x11) return this.call(op === 0x11), true;
    const [pops, pushes] = plainEffect(this.module.reader, op, this.code);
    this.push(pops, pushes);
    return true;
  }
}

function functionFacts(module: Module, position: number): FunctionFacts {
  const body = module.bodies[position];
  assert(body);
  const { reader } = module;
  const index = position + module.imports;
  const code = { offset: body.start };
  const groups = reader.u32(code);
  let locals = 0;
  for (let group = 0; group < groups; group++) {
    locals += reader.u32(code);
    code.offset++;
  }
  const typeIndex = module.functionTypes[index];
  const type = typeIndex === undefined ? undefined : module.types[typeIndex];
  assert(type, `function ${index} has no type`);
  const walk = new BodyWalk(module, code, type.results);
  const shadow = shadowFrame(reader, code.offset, body.end);
  while (code.offset < body.end && walk.step(reader.byte(code)));
  const slots = type.params + locals + walk.deepest;
  return {
    index, name: module.names.get(index) ?? `#${index}`, params: type.params, locals, stack: walk.deepest,
    slots, shadow, bytes: body.end - body.start, calls: walk.calls,
  };
}

function moduleFunctions(bytes: Uint8Array, filter: (name: string) => boolean): Map<number, FunctionFacts> {
  const module = readModule(bytes);
  const functions = new Map<number, FunctionFacts>();
  module.bodies.forEach((_, position) => {
    const name = module.names.get(position + module.imports);
    if (name && filter(name)) functions.set(position + module.imports, functionFacts(module, position));
  });
  return functions;
}

// The smoke's name section keeps mangled names; the linked engine side keeps demangled ones.
export const parserInstantiations = [
  { label: "full parser, UTF-8", handler: "FullParseHandler", unit: "mozilla::Utf8Unit", mangledUnit: "N7mozilla8Utf8UnitE" },
  { label: "full parser, two-byte", handler: "FullParseHandler", unit: "char16_t", mangledUnit: "Ds" },
  { label: "syntax parser, UTF-8", handler: "SyntaxParseHandler", unit: "mozilla::Utf8Unit", mangledUnit: "N7mozilla8Utf8UnitE" },
  { label: "syntax parser, two-byte", handler: "SyntaxParseHandler", unit: "char16_t", mangledUnit: "Ds" },
] as const;
type Instantiation = (typeof parserInstantiations)[number];

// Members merged into their callers; a separate function would cost a frame per nesting level.
const mergedMembers = [
  "statementListItem", "blockStatement", "consequentOrAlternative",
  "optionalExpr", "primaryExpr", "exprInParens", "orExpr", "condExpr",
] as const;

// The cycles that remain, as caller and callee edges every instantiation must contain.
const survivingEdges = [
  ["statementList", "statementList"], ["statementList", "ifStatement"], ["ifStatement", "statementList"],
  ["ifStatement", "statement"], ["ifStatement", "unbracedFunctionConsequent"],
  ["assignExpr", "unaryExpr"], ["unaryExpr", "memberExpr"], ["memberExpr", "expr"], ["expr", "assignExpr"],
] as const;

const reported = ["statementList", "ifStatement", "statement", "assignExpr", "unaryExpr", "memberExpr", "expr"];

function memberName(symbol: string, instantiation: Instantiation): string | undefined {
  const demangled = `js::frontend::GeneralParser<js::frontend::${instantiation.handler}, ${instantiation.unit}>::`;
  if (symbol.startsWith(demangled)) return /^(\w+)\(/.exec(symbol.slice(demangled.length))?.[1];
  const mangled = `_ZN2js8frontend13GeneralParserINS0_${instantiation.handler.length}${instantiation.handler}E${instantiation.mangledUnit}E`;
  if (!symbol.startsWith(mangled)) return undefined;
  const match = /^(\d+)/.exec(symbol.slice(mangled.length));
  if (!match?.[1]) return undefined;
  const start = mangled.length + match[1].length;
  return symbol.slice(start, start + Number(match[1]));
}

export type InstantiationReport = { label: string; frames: Record<string, { slots: number; shadow: number; bytes: number }> };

function checkInstantiation(functions: ReadonlyMap<number, FunctionFacts>, instantiation: Instantiation): InstantiationReport {
  const members = new Map<string, FunctionFacts>();
  for (const facts of functions.values()) {
    const member = memberName(facts.name, instantiation);
    if (member) members.set(member, facts);
  }
  for (const merged of mergedMembers) {
    assert(!members.has(merged), `${instantiation.label}: ${merged} is still a separate function`);
  }
  for (const [caller, callee] of survivingEdges) {
    const from = members.get(caller);
    const to = members.get(callee);
    assert(from && to, `${instantiation.label}: missing ${from ? callee : caller}`);
    assert(from.calls.has(to.index), `${instantiation.label}: ${caller} does not call ${callee}`);
  }
  const frames = Object.fromEntries(reported.map(name => {
    const facts = members.get(name);
    assert(facts);
    return [name, { slots: facts.slots, shadow: facts.shadow, bytes: facts.bytes }];
  }));
  return { label: instantiation.label, frames };
}

export function checkParserFrames(bytes: Uint8Array): InstantiationReport[] {
  const functions = moduleFunctions(bytes, name => name.includes("GeneralParser"));
  return parserInstantiations.map(instantiation => checkInstantiation(functions, instantiation));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const path of process.argv.slice(2)) {
    for (const report of checkParserFrames(readFileSync(path))) console.log(path, JSON.stringify(report));
  }
}

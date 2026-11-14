// A fail-closed floor under the guarded stack frame of JSC's C-loop interpreter function in a
// linked JSC side (docs/stack-limits.md, "The interpreter frame floor").
//
//   bun scripts/jsc-cloop-frame.ts check <jsc-engine.wasm>...
//
// JSC's native recursion guard counts shadow-stack bytes. Every reentry path (Proxy traps,
// `toString`, numeric-index getters) starts a new `CLoop::execute`, and the bytes that function holds
// are what stops those paths before a small host stack runs out. A build that holds fewer bytes
// would admit more levels than the host has room for, with no source change of ours.
//
// The check follows every path through the function and tracks how far the stack pointer is
// below its value at entry. It knows two ways to write the stack pointer:
//   allocate:  sp = sp - N, with the new value kept in a local
//   release:   sp = L + N, where L is a local that still holds an allocation's value
// At every call out of the function the pointer must be at least the floor below entry, on
// every path that reaches the call. Any other write to the stack pointer, a release through a
// local with no known value, a tail call or an instruction the reader does not know is an
// error, not a smaller measurement.
import { readInstructions, readWasmModule, WasmShapeError, type Instruction, type WasmFunction } from "./src/wasm-code.ts";

/** Bytes `CLoop::execute` held when every reentry path's depth was measured (November 11, 2026). */
export const cloopFrameFloor = 4896;
/**
 * Wasm parameters and locals of `CLoop::execute`. A first-tier wasm interpreter keeps each on
 * the host stack, so they bound what one reentry costs there. 293 when measured, plus 12%.
 */
export const cloopValueSlotCeiling = 328;
const interpreterName = "JSC::LLInt::CLoop::execute(";
const stackPointerExport = "__stack_pointer";
const stackPointerImport = "env.__stack_pointer";
const loopPassLimit = 16;

const op = {
  unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b, br: 0x0c, brIf: 0x0d, brTable: 0x0e, return: 0x0f,
  call: 0x10, callIndirect: 0x11, returnCall: 0x12, returnCallIndirect: 0x13,
  localGet: 0x20, localSet: 0x21, localTee: 0x22, globalGet: 0x23, globalSet: 0x24, i32Const: 0x41, i32Add: 0x6a, i32Sub: 0x6b,
} as const;

export interface CLoopFrame {
  /** The fewest guarded bytes held at any call out of the function. */
  readonly retainedBytes: number;
  /** The most held at any call, where inlined callees add their own frames. */
  readonly deepestBytes: number;
  readonly calls: number;
  readonly parameters: number;
  readonly locals: number;
  readonly valueSlots: number;
  readonly localBytes: number;
  readonly instructions: number;
}

/**
 * What is known on one path: the stack pointer is at least `depth` bytes below its entry
 * value, and each listed local is at least that many bytes below it. Never mutated.
 */
interface PathState { readonly depth: number; readonly locals: ReadonlyMap<number, number> }
interface Label { readonly loop: boolean; readonly arrivals: PathState[] }
interface Structured { readonly at: number; readonly body: Node[]; readonly otherwise: Node[] | null }
type Node = number | Structured;

function stackPointerGlobal(exported: ReadonlyMap<string, number>, imported: readonly string[]): number {
  const index = exported.get(stackPointerExport);
  if (index === undefined) throw new WasmShapeError(`the module does not export ${stackPointerExport}`);
  const importIndex = imported.indexOf(stackPointerImport);
  if (importIndex >= 0 && importIndex !== index) throw new WasmShapeError("the exported and imported stack pointers are different globals");
  return index;
}

function frameFunction(functions: readonly WasmFunction[], name: string): WasmFunction {
  const matches = functions.filter(candidate => candidate.name.startsWith(name));
  if (matches.length !== 1) throw new WasmShapeError(`expected one ${name}...) function, found ${matches.length}`);
  return matches[0]!;
}

function is(instruction: Instruction | undefined, opcode: number, operand?: number): boolean {
  return instruction?.opcode === opcode && (operand === undefined || instruction.operand === operand);
}

/** The function's instructions as nested blocks. A node is an instruction index or a block, loop or if. */
function structure(code: readonly Instruction[]): Node[] {
  let at = 0;
  function sequence(): { nodes: Node[]; closedBy: number } {
    const nodes: Node[] = [];
    while (at < code.length) {
      const index = at++;
      const opcode = code[index]!.opcode;
      if (opcode === op.end || opcode === op.else) return { nodes, closedBy: opcode };
      if (opcode !== op.block && opcode !== op.loop && opcode !== op.if) { nodes.push(index); continue; }
      const body = sequence();
      const otherwise = body.closedBy === op.else ? sequence() : null;
      if (otherwise ? otherwise.closedBy !== op.end || opcode !== op.if : body.closedBy !== op.end) throw new WasmShapeError("unbalanced blocks");
      nodes.push({ at: index, body: body.nodes, otherwise: otherwise?.nodes ?? null });
    }
    throw new WasmShapeError("the function does not end with `end`");
  }
  const outer = sequence();
  if (outer.closedBy !== op.end || at !== code.length) throw new WasmShapeError("the function does not end with `end`");
  return outer.nodes;
}

function join(states: readonly (PathState | null)[]): PathState | null {
  const reachable = Array.from(new Set(states.filter(state => state !== null)));
  const first = reachable[0];
  if (!first || reachable.length === 1) return first ?? null;
  const locals = new Map<number, number>();
  for (const [local, depth] of first.locals) {
    const depths = reachable.map(state => state.locals.get(local));
    if (depths.every(value => value !== undefined)) locals.set(local, Math.min(depth, ...depths.filter(value => value !== undefined)));
  }
  return { depth: Math.min(...reachable.map(state => state.depth)), locals };
}

function sameState(left: PathState | null, right: PathState | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.depth !== right.depth || left.locals.size !== right.locals.size) return false;
  return Array.from(left.locals).every(([local, depth]) => right.locals.get(local) === depth);
}

class FrameWalk {
  /** The lowest depth any pass saw at any call. A loop's later passes only see lower ones. */
  fewest = Infinity;
  /** Each call's depth on the last pass that reached it. */
  readonly depthAtCall = new Map<number, number>();
  private readonly labels: Label[] = [];
  constructor(private readonly code: readonly Instruction[], private readonly stackPointer: number) {}

  /** The state after the nodes, or null when no path falls out of them. */
  run(nodes: readonly Node[], entry: PathState | null): PathState | null {
    let state = entry;
    for (const node of nodes) {
      if (!state) return null;
      state = typeof node === "number" ? this.step(node, state) : this.enter(node, state);
    }
    return state;
  }

  private enter(node: Structured, state: PathState): PathState | null {
    const opcode = this.code[node.at]!.opcode;
    if (opcode === op.loop) return this.loop(node, state);
    const label: Label = { loop: false, arrivals: [] };
    this.labels.push(label);
    const exits = [this.run(node.body, state), opcode === op.if ? this.run(node.otherwise ?? [], state) : null];
    this.labels.pop();
    return join(exits.concat(label.arrivals));
  }

  /** A loop's entry state has to hold for every later pass too, so its body runs until it does. */
  private loop(node: Structured, entry: PathState): PathState | null {
    let head: PathState | null = entry;
    for (let pass = 0; pass < loopPassLimit; pass++) {
      const label: Label = { loop: true, arrivals: [] };
      this.labels.push(label);
      const exit = this.run(node.body, head);
      this.labels.pop();
      const next = join([entry as PathState | null].concat(label.arrivals));
      if (sameState(head, next)) return exit;
      head = next;
    }
    throw new WasmShapeError("a loop's stack state did not settle");
  }

  private branch(depth: number, state: PathState): void {
    // A branch past every label leaves the function.
    this.labels[this.labels.length - 1 - depth]?.arrivals.push(state);
  }

  private step(index: number, state: PathState): PathState | null {
    const instruction = this.code[index]!;
    switch (instruction.opcode) {
      case op.call:
      case op.callIndirect:
        this.fewest = Math.min(this.fewest, state.depth);
        this.depthAtCall.set(index, state.depth);
        return state;
      case op.returnCall:
      case op.returnCallIndirect:
        throw new WasmShapeError("the function makes a tail call");
      case op.br:
        this.branch(instruction.operand, state);
        return null;
      case op.brIf:
        this.branch(instruction.operand, state);
        return state;
      case op.brTable:
        for (const depth of new Set(instruction.targets)) this.branch(depth, state);
        return null;
      case op.return:
      case op.unreachable:
        return null;
      case op.localSet:
      case op.localTee:
        return this.writeLocal(index, state);
      case op.globalSet:
        return instruction.operand === this.stackPointer ? this.writeStackPointer(index, state) : state;
      default:
        return state;
    }
  }

  private writeLocal(index: number, state: PathState): PathState {
    const local = this.code[index]!.operand;
    const previous = this.code[index - 1];
    const held = is(previous, op.localGet) ? state.locals.get(previous!.operand) : undefined;
    if (held !== undefined) return { depth: state.depth, locals: new Map(state.locals).set(local, held) };
    return state.locals.has(local) ? { depth: state.depth, locals: without(state.locals, local) } : state;
  }

  private writeStackPointer(index: number, state: PathState): PathState {
    const { code, stackPointer } = this;
    const [first, second, third, fourth] = [code[index - 4], code[index - 3], code[index - 2], code[index - 1]];
    if (is(first, op.globalGet, stackPointer) && is(second, op.i32Const) && is(fourth, op.localTee)) {
      const bytes = -added(second!, third);
      if (!(bytes > 0) || bytes % 16 !== 0) throw new WasmShapeError(`unexpected stack allocation of ${bytes} bytes`);
      const depth = state.depth + bytes;
      return { depth, locals: new Map(state.locals).set(fourth!.operand, depth) };
    }
    if (is(second, op.localGet) && is(third, op.i32Const)) {
      const held = state.locals.get(second!.operand);
      if (held === undefined) throw new WasmShapeError(`the stack pointer is released through local ${second!.operand}, which holds no known allocation`);
      return { depth: held - added(third!, fourth), locals: state.locals };
    }
    throw new WasmShapeError("the stack pointer is written in an unrecognized way");
  }
}

/** What `i32.const C` followed by `i32.add` or `i32.sub` adds. Compilers write `- 64` as `+ -64`. */
function added(constant: Instruction, operator: Instruction | undefined): number {
  if (is(operator, op.i32Add)) return constant.operand;
  if (is(operator, op.i32Sub)) return -constant.operand;
  throw new WasmShapeError("the stack pointer is written in an unrecognized way");
}

function without(locals: ReadonlyMap<number, number>, local: number): Map<number, number> {
  const rest = new Map(locals);
  rest.delete(local);
  return rest;
}

/** The frame `CLoop::execute` holds at its calls. Throws on anything the walk cannot prove. */
export function cloopFrame(bytes: Uint8Array): CLoopFrame {
  return wasmFrame(bytes, interpreterName);
}

/** The retained shadow frame of one named function, using the same checked walk as JSC. */
export function wasmFrame(bytes: Uint8Array, name: string): CLoopFrame {
  const module = readWasmModule(bytes);
  const stackPointer = stackPointerGlobal(module.exportedGlobals, module.importedGlobals);
  const target = frameFunction(module.functions, name);
  const code = readInstructions(module, target);
  const walk = new FrameWalk(code, stackPointer);
  walk.run(structure(code), { depth: 0, locals: new Map() });
  if (walk.depthAtCall.size === 0) throw new WasmShapeError("the function makes no call");
  return {
    retainedBytes: walk.fewest, deepestBytes: Math.max(...walk.depthAtCall.values()), calls: walk.depthAtCall.size,
    parameters: target.parameters, locals: target.locals, valueSlots: target.parameters + target.locals,
    localBytes: target.localBytes, instructions: code.length,
  };
}

export interface CLoopFrameLimits { readonly floor: number; readonly valueSlotCeiling: number }

/** Reasons the frame fails the limits; empty when it passes. */
export function cloopFrameFindings(frame: CLoopFrame, limits: CLoopFrameLimits = { floor: cloopFrameFloor, valueSlotCeiling: cloopValueSlotCeiling }): string[] {
  const findings: string[] = [];
  if (frame.retainedBytes < limits.floor) findings.push(`CLoop::execute holds ${frame.retainedBytes} guarded bytes at one of its calls, below the ${limits.floor}-byte floor`);
  if (frame.valueSlots > limits.valueSlotCeiling) findings.push(`CLoop::execute has ${frame.valueSlots} wasm parameters and locals, above the ceiling of ${limits.valueSlotCeiling}`);
  return findings;
}

async function checkFile(path: string): Promise<boolean> {
  const bytes = await Bun.file(path).bytes();
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  try {
    const frame = cloopFrame(bytes);
    const findings = cloopFrameFindings(frame);
    console.log(JSON.stringify({ file: path, sha256, floor: cloopFrameFloor, valueSlotCeiling: cloopValueSlotCeiling, ...frame, findings }));
    return findings.length === 0;
  } catch (error) {
    if (!(error instanceof WasmShapeError)) throw error;
    console.log(JSON.stringify({ file: path, sha256, findings: [`unrecognized shape: ${error.message}`] }));
    return false;
  }
}

if (import.meta.main) {
  const [command, ...files] = process.argv.slice(2);
  if (command !== "check" || files.length === 0) {
    console.error("Usage: jsc-cloop-frame.ts check <jsc-engine.wasm>...");
    process.exit(2);
  }
  let passed = true;
  for (const file of files) passed = (await checkFile(file)) && passed;
  if (!passed) {
    console.error("error: the JSC interpreter frame gate failed (docs/stack-limits.md)");
    process.exit(1);
  }
}

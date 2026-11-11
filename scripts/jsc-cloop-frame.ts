// A fail-closed floor under the guarded stack frame of JSC's C-loop interpreter function in a
// linked JSC side (docs/stack-limits.md, "The interpreter frame floor").
//
//   bun scripts/jsc-cloop-frame.ts check <jsc-engine.wasm>...
//
// JSC's native recursion guard counts shadow-stack bytes. Every reentry path (Proxy traps,
// `toString`, computed getters) starts a new `CLoop::execute`, and the bytes that function keeps
// are what stops those paths before a small host stack runs out. A build that keeps fewer bytes
// would admit more levels than the host has room for, with no source change of ours.
//
// The check reads the function from the final module and accepts one shape only:
//   - it opens with allocations `sp = sp - N`, each kept in a local that is never written again;
//   - it ends with the matching releases, immediately before the function's final `end`;
//   - nothing else in the function writes or reads the stack pointer.
// So the whole frame is held from the first instruction to the last, across every opcode and
// every call out of the loop. Any other shape is an error, not a smaller measurement.
import { readInstructions, readWasmModule, WasmShapeError, type Instruction, type WasmFunction } from "./src/wasm-code.ts";

/** Bytes `CLoop::execute` kept when every reentry path's depth was measured (November 11, 2026). */
export const cloopFrameFloor = 4896;
/**
 * Wasm parameters and locals of `CLoop::execute`. A first-tier wasm interpreter keeps each on
 * the host stack, so they bound what one reentry costs there. 293 when measured, plus 12%.
 */
export const cloopValueSlotCeiling = 328;
const interpreterName = "JSC::LLInt::CLoop::execute(";
const stackPointerExport = "__stack_pointer";
const stackPointerImport = "env.__stack_pointer";

const op = { end: 0x0b, localGet: 0x20, localSet: 0x21, localTee: 0x22, globalGet: 0x23, globalSet: 0x24, i32Const: 0x41, i32Add: 0x6a, i32Sub: 0x6b } as const;

export interface CLoopFrame {
  readonly retainedBytes: number;
  readonly allocations: readonly number[];
  readonly parameters: number;
  readonly locals: number;
  readonly valueSlots: number;
  readonly localBytes: number;
  readonly instructions: number;
}

interface Allocation { readonly bytes: number; readonly local: number }

function stackPointerGlobal(exported: ReadonlyMap<string, number>, imported: readonly string[]): number {
  const index = exported.get(stackPointerExport);
  if (index === undefined) throw new WasmShapeError(`the module does not export ${stackPointerExport}`);
  const importIndex = imported.indexOf(stackPointerImport);
  if (importIndex >= 0 && importIndex !== index) throw new WasmShapeError("the exported and imported stack pointers are different globals");
  return index;
}

function interpreterFunction(functions: readonly WasmFunction[]): WasmFunction {
  const matches = functions.filter(candidate => candidate.name.startsWith(interpreterName));
  if (matches.length !== 1) throw new WasmShapeError(`expected one ${interpreterName}...) function, found ${matches.length}`);
  return matches[0]!;
}

function matches(instruction: Instruction | undefined, opcode: number, operand?: number): boolean {
  return instruction?.opcode === opcode && (operand === undefined || instruction.operand === operand);
}

/** `global.get sp; i32.const N; i32.sub; local.tee L; global.set sp` at |at|, or null. */
function allocationAt(code: readonly Instruction[], at: number, stackPointer: number): Allocation | null {
  const shape = matches(code[at], op.globalGet, stackPointer) && matches(code[at + 1], op.i32Const) && matches(code[at + 2], op.i32Sub)
    && matches(code[at + 3], op.localTee) && matches(code[at + 4], op.globalSet, stackPointer);
  if (!shape) return null;
  const bytes = code[at + 1]!.operand;
  if (bytes <= 0 || bytes % 16 !== 0) throw new WasmShapeError(`unexpected stack allocation of ${bytes} bytes`);
  return { bytes, local: code[at + 3]!.operand };
}

function entryAllocations(code: readonly Instruction[], stackPointer: number): Allocation[] {
  const allocations: Allocation[] = [];
  for (let next = allocationAt(code, 0, stackPointer); next; next = allocationAt(code, allocations.length * 5, stackPointer)) allocations.push(next);
  if (allocations.length === 0) throw new WasmShapeError("the function does not open with a stack allocation");
  return allocations;
}

/** The releases, last allocation first, must be the function's final instructions before `end`. */
function requireExitReleases(code: readonly Instruction[], allocations: readonly Allocation[], stackPointer: number): void {
  if (!matches(code.at(-1), op.end)) throw new WasmShapeError("the function does not end with `end`");
  allocations.forEach((allocation, order) => {
    const at = code.length - 1 - 4 * (order + 1);
    const released = matches(code[at], op.localGet, allocation.local) && matches(code[at + 1], op.i32Const, allocation.bytes)
      && matches(code[at + 2], op.i32Add) && matches(code[at + 3], op.globalSet, stackPointer);
    if (!released) throw new WasmShapeError(`the ${allocation.bytes}-byte allocation is not released at the function's end`);
  });
}

function count(code: readonly Instruction[], accept: (instruction: Instruction) => boolean): number {
  return code.reduce((total, instruction) => total + (accept(instruction) ? 1 : 0), 0);
}

function requireNoOtherStackPointerUse(code: readonly Instruction[], allocations: readonly Allocation[], stackPointer: number): void {
  const writes = count(code, instruction => matches(instruction, op.globalSet, stackPointer));
  const reads = count(code, instruction => matches(instruction, op.globalGet, stackPointer));
  if (writes !== allocations.length * 2) throw new WasmShapeError(`the stack pointer is written ${writes} times, not once per allocation and release`);
  if (reads !== allocations.length) throw new WasmShapeError(`the stack pointer is read ${reads} times, not once per allocation`);
  for (const { local } of allocations) {
    const assignments = count(code, instruction => matches(instruction, op.localSet, local) || matches(instruction, op.localTee, local));
    if (assignments !== 1) throw new WasmShapeError(`frame local ${local} is assigned ${assignments} times`);
  }
  if (new Set(allocations.map(allocation => allocation.local)).size !== allocations.length) throw new WasmShapeError("two allocations share a frame local");
}

/** The frame `CLoop::execute` holds for its whole activation. Throws on any unrecognized shape. */
export function cloopFrame(bytes: Uint8Array): CLoopFrame {
  const module = readWasmModule(bytes);
  const stackPointer = stackPointerGlobal(module.exportedGlobals, module.importedGlobals);
  const target = interpreterFunction(module.functions);
  const code = readInstructions(module, target);
  const allocations = entryAllocations(code, stackPointer);
  requireExitReleases(code, allocations, stackPointer);
  requireNoOtherStackPointerUse(code, allocations, stackPointer);
  const sizes = allocations.map(allocation => allocation.bytes);
  return {
    retainedBytes: sizes.reduce((total, size) => total + size, 0), allocations: sizes,
    parameters: target.parameters, locals: target.locals, valueSlots: target.parameters + target.locals,
    localBytes: target.localBytes, instructions: code.length,
  };
}

export interface CLoopFrameLimits { readonly floor: number; readonly valueSlotCeiling: number }

/** Reasons the frame fails the limits; empty when it passes. */
export function cloopFrameFindings(frame: CLoopFrame, limits: CLoopFrameLimits = { floor: cloopFrameFloor, valueSlotCeiling: cloopValueSlotCeiling }): string[] {
  const findings: string[] = [];
  if (frame.retainedBytes < limits.floor) findings.push(`CLoop::execute keeps ${frame.retainedBytes} guarded bytes, below the ${limits.floor}-byte floor`);
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

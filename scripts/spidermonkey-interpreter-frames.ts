import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readInstructions, readWasmModule } from "./src/wasm-code.ts";

export function interpreterFrames(bytes: Uint8Array) {
  const module = readWasmModule(bytes);
  const stack = module.importedGlobals.indexOf("env.__stack_pointer");
  const stackPointer = module.exportedGlobals.get("__stack_pointer") ?? stack;
  assert(stackPointer >= 0, "missing shadow stack pointer");
  const functions = module.functions.filter(fn =>
    fn.name.startsWith("js::Interpret(") || fn.name.startsWith("js::RunScript(") ||
    fn.name.startsWith("js::pbl::ICInterpretOps(") || fn.name.includes("js::pbl::PortableBaselineInterpret<"));
  assert.equal(functions.length, 5, "expected interpreter, RunScript, IC and both PBL instantiations");
  return functions.map(fn => {
    const code = readInstructions(module, fn);
    assert.equal(code[0]?.opcode, 0x23, `${fn.name}: prologue must read a global`);
    assert.equal(code[0]?.operand, stackPointer, `${fn.name}: prologue must read the shadow stack`);
    assert.equal(code[1]?.opcode, 0x41, `${fn.name}: missing constant frame size`);
    assert.equal(code[2]?.opcode, 0x6b, `${fn.name}: missing frame subtraction`);
    const write = code.findIndex(instruction => instruction.opcode === 0x24);
    assert(write >= 3 && write < 10, `${fn.name}: unrecognized frame publication`);
    assert.equal(code[write]?.operand, stackPointer, `${fn.name}: frame must update the shadow stack`);
    assert(code.slice(3, write).every(instruction => [0x20, 0x21, 0x22].includes(instruction.opcode)),
      `${fn.name}: unrecognized instructions before frame publication`);
    const frame = code[1];
    assert(frame && frame.operand > 0, `${fn.name}: missing frame allocation`);
    return { name: fn.name, shadowBytes: frame.operand, parameters: fn.parameters, locals: fn.locals, localBytes: fn.localBytes };
  });
}

if (import.meta.main) {
  assert(process.argv.length >= 3, "usage: spidermonkey-interpreter-frames.ts ENGINE.wasm...");
  for (const path of process.argv.slice(2)) console.log(JSON.stringify({ path, frames: interpreterFrames(readFileSync(path)) }));
}

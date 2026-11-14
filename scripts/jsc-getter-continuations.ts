import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computedReaderSource, computedWidths } from "../tests/fixtures/getter-dispatch/computed-widths";

const continuation = "llint_cloop_did_return_from_js_\\d+";
const widths = [
  { suffix: "", bytes: 1, prefix: 1 },
  { suffix: "_wide16", bytes: 2, prefix: 2 },
  { suffix: "_wide32", bytes: 4, prefix: 2 },
] as const;

function requireMatch(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function uniqueNames(text: string, pattern: RegExp): string[] {
  const names = Array.from(text.matchAll(pattern), match => match[1]!);
  requireMatch(new Set(names).size === names.length, `Duplicate continuations in ${pattern}`);
  return names.sort();
}

function section(text: string, label: string): string {
  const marker = new RegExp(`^OFFLINE_ASM_(?:OPCODE|GLUE)_LABEL\\(${label}\\)\\n`, "m");
  const at = text.search(marker);
  requireMatch(at >= 0, `Missing generated entry ${label}`);
  return text.slice(at).split(/\nOFFLINE_ASM_OPCODE_LABEL\(/, 1)[0]!;
}

function getterReturn(assembly: string, label: string, slowPath: string): { name: string; before: string; after: string } {
  const block = section(assembly, label);
  const at = block.indexOf(`UGPRPair result = ${slowPath}(`);
  requireMatch(at >= 0, `${label} does not call ${slowPath}`);
  const body = block.slice(at);
  const call = new RegExp(`lr = getOpcode\\((${continuation})\\);`).exec(body);
  requireMatch(call?.[1] && call.index >= 0, `${label} has no getter continuation`);
  const definition = `OFFLINE_ASM_GLUE_LABEL(${call[1]})\n`;
  const returnAt = body.indexOf(definition);
  requireMatch(returnAt > call.index, `${label} return is not after its reference`);
  return { name: call[1], before: body.slice(0, call.index), after: body.slice(returnAt + definition.length).split("DISPATCH_OPCODE();", 1)[0]! };
}

function opcodeLayout(list: string, opcode: string) {
  const body = list.split(`op :${opcode},\n`)[1]?.split(/^op |^end_section/m)[0];
  const args = body?.split("args: {")[1]?.split("}")[0];
  requireMatch(args && body, `Missing operands for ${opcode}`);
  const fields = Array.from(args.matchAll(/^\s+(\w+): /gm), match => match[1]!);
  const dst = fields.indexOf("dst");
  const profile = fields.indexOf("valueProfile");
  requireMatch(dst >= 0 && profile >= 0, `Missing result fields for ${opcode}`);
  return { dst, profile, operands: fields.length + Number(body.includes("metadata:")) };
}

function checkRegularReturn(code: string, list: string, opcode: string, width: typeof widths[number]): void {
  const { dst, profile, operands } = opcodeLayout(list, opcode);
  const offset = (field: number) => `intptr_t(0x${(width.prefix + field * width.bytes).toString(16)})`;
  const increment = `pc = pc.i() + intptr_t(0x${(width.prefix + operands * width.bytes).toString(16)});`;
  const restore = code.indexOf("sp = t2.i64();");
  const loadPC = code.indexOf("pc = *CAST<uint32_t*>(cfr.i8p()");
  requireMatch(restore >= 0 && loadPC > restore, `${opcode}${width.suffix} restores its stack before PC`);
  const dstLoad = code.indexOf(`t1 = ${width.bytes < 4 ? "(int64_t)" : ""}*CAST<int${width.bytes * 8}_t*>(pcBase.i8p() + (pc.i() << 0) + ${offset(dst)})`);
  const store = code.indexOf("*CAST<int64_t*>(cfr.i8p() + (t1.i() << 3)) = t0.i64();");
  const profileLoad = code.indexOf(`t2 = *CAST<uint${width.bytes * 8}_t*>(pcBase.i8p() + (pc.i() << 0) + ${offset(profile)})`);
  const profileStore = code.indexOf("*CAST<int64_t*>(metadataTable.i8p()");
  requireMatch(dstLoad > loadPC && store > dstLoad && profileLoad > store && profileStore > profileLoad, `${opcode}${width.suffix} uses m_dst and m_valueProfile after restoring PC`);
  requireMatch(code.indexOf(increment) > profileStore && code.split(increment).length === 2, `${opcode}${width.suffix} advances exactly once by its encoded length`);
}

export function verifyGeneratedContinuations(assembly: string, list: string, bytecodes: string) {
  const declarations = uniqueNames(list, new RegExp(`^op :(${continuation})$`, "gm"));
  const definitions = uniqueNames(assembly, new RegExp(`^OFFLINE_ASM_GLUE_LABEL\\((${continuation})\\)$`, "gm"));
  const references = uniqueNames(assembly, new RegExp(`lr = getOpcode\\((${continuation})\\);`, "g"));
  const generated = uniqueNames(bytecodes, new RegExp(`^    macro\\((${continuation}), 0\\)`, "gm"));
  for (const names of [definitions, references, generated]) requireMatch(JSON.stringify(names) === JSON.stringify(declarations), "Continuation declarations, references and generated definitions differ");
  const mappings: { opcode: string; continuation: string }[] = [];
  for (const opcode of ["get_by_id", "get_by_id_with_this", "get_by_val"]) {
    for (const width of widths) mappings.push(checkGetter(assembly, list, opcode, width));
  }
  for (const width of widths) {
    const label = `op_call_direct_eval${width.suffix}`;
    const body = getterReturn(assembly, label, `llint_slow_path_call_direct_eval${width.suffix}`);
    checkRegularReturn(body.after.replace(/^\s*OFFLINE_ASM_GLUE_LABEL\([^\n]+\)\n/m, ""), list, "call_direct_eval", width);
    mappings.push({ opcode: label, continuation: body.name });
  }
  const bound = getterReturn(assembly, "llint_bound_function_call_trampoline", "llint_set_up_bound_function_call");
  const boundException = bound.before.indexOf("if (t1.i() == intptr_t(-1))");
  requireMatch(boundException >= 0 && boundException < bound.before.indexOf("sp = t1.i64();"), "Bound calls test the exception before changing sp");
  requireMatch(bound.after.includes("sp = cfr.i64();") && !bound.after.includes("sp = t2.i64();"), "Bound calls restore sp from their code-block-free frame");
  mappings.push({ opcode: "llint_bound_function_call_trampoline", continuation: bound.name });
  return { continuations: declarations.length, mappings };
}

function checkGetter(assembly: string, list: string, opcode: string, width: typeof widths[number]) {
  const label = `op_${opcode}${width.suffix}`;
  const body = getterReturn(assembly, label, `llint_slow_path_${opcode}`);
  const exception = body.before.indexOf("if (t1.i() == intptr_t(-1))");
  const completed = body.before.indexOf("if (t1.i() != 0)");
  const enter = body.before.indexOf("sp = t1.i64();");
  requireMatch(exception >= 0 && completed > exception && enter > completed, `${label} does not preserve the three outcomes`);
  requireMatch(body.before.includes("goto llint_throw_from_slow_path_trampoline;"), `${label} loses exceptions`);
  checkRegularReturn(body.after, list, opcode, width);
  return { opcode: label, continuation: body.name };
}

export function verifyComputedBytecode(dump: string) {
  return computedWidths.map(({ name, width }) => {
    const body = dump.split(`${name}#`)[1]?.split(/\n\S[^\n]*#.*instructions/)[0];
    const reads = Array.from((body ?? "").matchAll(/^\[\s*\d+\] (\*{0,2})get_by_val\s+dst:(\w+), base:arg1, property:arg2,/gm));
    requireMatch(reads.length === 1, `${name} must have exactly one actual computed read`);
    const read = reads[0]!;
    const actual = ["narrow", "wide16", "wide32"][read[1]!.length];
    requireMatch(actual === width, `${name} computed read is ${actual}, expected ${width}`);
    return { name, width, instruction: read[0] };
  });
}

if (import.meta.main) {
  const [command, path, source] = process.argv.slice(2);
  requireMatch(path, "Usage: jsc-getter-continuations.ts generated BUILD_DIR WEBKIT_DIR | source OUTPUT | bytecode DUMP");
  if (command === "source") {
    const code = computedWidths.map(({ name, count }) => `const ${name} = new Function(${JSON.stringify(`return (${computedReaderSource(count, name)});`)})();\nif (${name}({ get value() { return 17; } }, "value") !== ${(count * (count - 1)) / 2 + 17}) throw new Error("${name}");`).join("\n");
    writeFileSync(path, code);
  } else if (command === "bytecode") console.log(JSON.stringify(verifyComputedBytecode(readFileSync(path, "utf8"))));
  else if (command === "generated" && source) {
    const derived = join(path, "JavaScriptCore/DerivedSources");
    console.log(JSON.stringify(verifyGeneratedContinuations(readFileSync(join(derived, "LLIntAssembly.h"), "utf8"), readFileSync(join(source, "Source/JavaScriptCore/bytecode/BytecodeList.rb"), "utf8"), readFileSync(join(derived, "Bytecodes.h"), "utf8"))));
  } else throw new Error(`Unknown command ${command}`);
}

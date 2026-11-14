import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { verifyComputedBytecode, verifyGeneratedContinuations } from "./jsc-getter-continuations";

const dump = `computedNarrow#id: 3 instructions
[   1] get_by_val dst:loc12, base:arg1, property:arg2, valueProfile:1
computedWide16#id: 6000 instructions
[  24] *get_by_val dst:loc2004, base:arg1, property:arg2, valueProfile:1
computedWide32#id: 99000 instructions; 33000 callee registers
[  48] **get_by_val dst:loc33004, base:arg1, property:arg2, valueProfile:1
`;

test("computed widths come from the actual read instruction, not local or wide-instruction counts", () => {
  expect(verifyComputedBytecode(dump).map(row => row.width)).toEqual(["narrow", "wide16", "wide32"]);
  expect(() => verifyComputedBytecode(dump.replace("**get_by_val", "*get_by_val"))).toThrow("computed read is wide16, expected wide32");
  expect(() => verifyComputedBytecode(dump.replace("**get_by_val", "**get_by_id"))).toThrow("exactly one actual computed read");
  expect(() => verifyComputedBytecode(dump.concat("[  99] **get_by_val dst:loc33004, base:arg1, property:arg2, valueProfile:1\n"))).toThrow("exactly one actual computed read");
});

test("generated continuation checks reject missing and duplicate definitions before mapping sites", () => {
  const list = "op :llint_cloop_did_return_from_js_99\n";
  const reference = "lr = getOpcode(llint_cloop_did_return_from_js_99);\n";
  const definition = "OFFLINE_ASM_GLUE_LABEL(llint_cloop_did_return_from_js_99)\n";
  expect(() => verifyGeneratedContinuations(reference, list, "")).toThrow("differ");
  expect(() => verifyGeneratedContinuations(reference.concat(definition, definition), list, "")).toThrow("Duplicate continuations");
});

test("both normal JSC profile producers check full generated output", () => {
  const producer = readFileSync(new URL("./build-jsc.sh", import.meta.url), "utf8");
  const command = 'bun "$REPO/scripts/jsc-getter-continuations.ts" generated "$JSC_OBJ" "$WEBKIT_DIR"';
  expect(producer.indexOf(command)).toBeGreaterThan(producer.indexOf('"$jsc/build.sh"'));
  expect(producer.indexOf(command)).toBeLessThan(producer.indexOf('if [[ "$JSC_PROFILE" == split ]]'));
});

import { expect, test } from "bun:test";
import { compileArguments, parseCommands } from "../spidermonkey/rebuild-g2.ts";

test("G2 compiler replay changes only source, output and the embed macro", () => {
  const entry = { directory: "/obj", file: "/source/vm.cpp", arguments: ["clang++", "--sysroot", "/sysroot", "-fPIC", "-fno-exceptions", "-o", "/dev/null", "-c", "/source/vm.cpp"] };
  expect(compileArguments(entry, "/obj/Unified_vm.cpp", "/g2/Unified_vm.o"))
    .toEqual(["--sysroot", "/sysroot", "-fPIC", "-fno-exceptions", "-o", "/g2/Unified_vm.o", "-c", "/obj/Unified_vm.cpp", "-DBUNWASM_EMBED=1"]);
  expect(entry.arguments).toContain("/dev/null");
  expect(() => compileArguments({ ...entry, arguments: ["clang++", "-c", entry.file] }, entry.file, "/g2/vm.o")).toThrow(/incomplete/);
});
test("G2 rejects incomplete or non-string compiler inputs before executing", () => {
  for (const value of [null, {}, [null], [{ directory: "/obj", file: "vm.cpp", arguments: ["clang++", 7] }]]) {
    expect(() => parseCommands(value)).toThrow();
  }
  expect(parseCommands([{ directory: "/obj", file: "vm.cpp", arguments: ["clang++"] }])).toHaveLength(1);
});

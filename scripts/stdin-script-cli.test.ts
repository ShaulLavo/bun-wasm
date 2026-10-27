import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";

test("run accepts only the lone dash as stdin and preserves script arguments and flags", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-stdin-cli-"));
  try {
    const source = readFileSync(new URL("../crates/bunwasm-cli/src/main.rs", import.meta.url), "utf8");
    const start = source.indexOf("enum Command {");
    const end = source.indexOf("// Referenced so the linker", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const definitions = `
      mod bunwasm_runtime { pub const BUN_VERSION: &str = "test"; pub const BUN_REVISION: &str = "test"; }
      enum Entry { File(String), Eval(String), Test(Vec<String>) }
      mod tool_args { pub fn before_command(_: &[String]) -> Option<()> { None } }
      const HELP: &str = "help";
    `;
    const controls = `
      fn args(values: &[&str]) -> Vec<String> { values.iter().map(|value| value.to_string()).collect() }
      fn main() {
        for argv in [args(&["run", "-"]), args(&["run", "--", "-"])] {
          assert!(matches!(parse(argv, "bun"), Command::Run(Entry::File(file), tail, _, _) if file == "-" && tail.is_empty()));
        }
        assert!(matches!(parse(args(&["--conditions=custom", "run", "--smol", "-", "--help", "--unknown", "tail"]), "bun"),
          Command::Run(Entry::File(file), tail, conditions, exec_argv) if file == "-" && tail == args(&["--help", "--unknown", "tail"]) && conditions == args(&["custom"]) && exec_argv == args(&["--conditions=custom"])));
        for flag in ["--unknown", "-x", "-stdin"] {
          assert!(matches!(parse(args(&["run", flag]), "bun"), Command::Exit(1)));
        }
        assert!(matches!(parse(args(&["run", "--help"]), "bun"), Command::Exit(0)));
        assert!(matches!(parse(args(&["run"]), "bun"), Command::Exit(1)));
        assert!(matches!(parse(args(&["run", "--eval"]), "bun"), Command::Exit(1)));
        assert!(matches!(parse(args(&["run", "file.ts", "-"]), "bun"), Command::Run(Entry::File(file), tail, _, _) if file == "file.ts" && tail == args(&["-"])));
        assert!(matches!(parse(args(&["run", "./-", "tail"]), "bun"), Command::Run(Entry::File(file), tail, _, _) if file == "./-" && tail == args(&["tail"])));
      }
    `;
    const input = join(scratch, "parser.rs");
    const executable = join(scratch, "parser");
    writeFileSync(input, definitions + source.slice(start, end) + controls);
    const compiled = Bun.spawnSync(["rustc", "--edition=2024", "--cap-lints=allow", input, "-o", executable], { stdout: "pipe", stderr: "pipe" });
    expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);
    const result = Bun.spawnSync([executable], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("stdin main bypasses package aliases and files while ordinary runtime commands still dispatch", () => {
  const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/bootstrap.js", import.meta.url), "utf8");
  const start = source.indexOf("  internal.runMain =");
  const end = source.indexOf("  internal.getMainModule", start);
  const scripts = { resolve: () => ({ kind: "runtime" }), run: () => "package-command" };
  const internal = { require: () => scripts, runMain: (_path: string): unknown => undefined };
  const loaded: string[] = [];
  const native = {
    mainArg: () => "-",
    exists() { throw new Error("stdin is not a file"); },
    moduleFormat: () => "esm",
    importModule(path: string) { loaded.push(path); return "stdin-source"; },
  };
  runInNewContext(source.slice(start, end), { internal, native });
  expect(internal.runMain("/project/[stdin]")).toBe("stdin-source");
  expect(loaded).toEqual(["/project/[stdin]"]);
  expect(internal.runMain("/project/start")).toBe("package-command");
  native.mainArg = () => "./[stdin]";
  expect(internal.runMain("/project/[stdin]")).toBe("package-command");
});

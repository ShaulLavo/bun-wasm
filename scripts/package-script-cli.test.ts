import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Compile the exact production argument parser without building Bun's native dependencies.
test("CLI dispatch distinguishes Node files, Bun commands, run aliases and eval operands", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-script-cli-"));
  try {
    const source = readFileSync(new URL("../crates/bunwasm-cli/src/main.rs", import.meta.url), "utf8");
    const start = source.indexOf("enum Command {");
    const end = source.indexOf("// Referenced so the linker", start);
    const definitions = `
      mod bunwasm_runtime { pub const BUN_VERSION: &str = "test"; pub const BUN_REVISION: &str = "test"; }
      enum Entry { File(String), Eval(String), Test(Vec<String>) }
      mod tool_args { pub fn before_command(_: &[String]) -> Option<()> { None } }
      const HELP: &str = "help";
    `;
    const controls = `
      fn args(values: &[&str]) -> Vec<String> { values.iter().map(|value| value.to_string()).collect() }
      fn main() {
        assert!(matches!(parse(args(&["test", "./sample.test.ts"]), "bun"), Command::Run(Entry::Test(values), _) if values == args(&["./sample.test.ts"])));
        assert!(matches!(parse(args(&["-e", "console.log(42)", "tail"]), "node"), Command::Run(Entry::Eval(code), values) if code == "console.log(42)" && values == args(&["tail"])));
        assert!(matches!(parse(args(&["-p", "21 * 2"]), "nodejs"), Command::Print(code) if code == "21 * 2"));
        for name in ["test", "build", "run", "help", "alias", "app.js"] {
          assert!(matches!(parse(args(&[name, "tail"]), "/bin/node"), Command::Run(Entry::File(file), values) if std::path::Path::new(&file).is_absolute() && file.ends_with(name) && values == args(&["tail"])));
        }
        assert!(matches!(parse(args(&["app.js"]), "bun"), Command::Run(Entry::File(file), _) if std::path::Path::new(&file).is_absolute()));
        assert!(matches!(parse(args(&["run", "app.js"]), "bun"), Command::Run(Entry::File(file), _) if file == "app.js"));
        assert!(matches!(parse(args(&["run", "test"]), "bun"), Command::Run(Entry::File(file), _) if file == "test"));
        assert!(matches!(parse(args(&["build", "app.js", "--outdir", "out"]), "bun"), Command::Build(values) if values == args(&["app.js", "--outdir", "out"])));
        assert!(matches!(parse(args(&["install", "--frozen-lockfile"]), "bun"), Command::Install(command, values) if command == "install" && values == args(&["--frozen-lockfile"])));
        assert!(matches!(parse(args(&["--no-install", "--smol", "run", "-e", "42"]), "bun"), Command::Run(Entry::Eval(code), _) if code == "42"));
        assert!(matches!(parse(args(&["-e"]), "node"), Command::Exit(1)));
        assert!(matches!(parse(args(&["--unknown"]), "bun"), Command::Exit(1)));
      }
    `;
    const input = join(scratch, "parser.rs");
    const executable = join(scratch, "parser");
    writeFileSync(input, definitions + source.slice(start, end) + controls);
    const compiled = Bun.spawnSync(["rustc", "--edition=2024", "--cap-lints=allow", input, "-o", executable], { stdout: "pipe", stderr: "pipe" });
    expect(compiled.exitCode).toBe(0);
    if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString());
    writeFileSync(join(scratch, "app.js"), "");
    const result = Bun.spawnSync([executable], { cwd: scratch, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

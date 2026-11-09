import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/work/tmp", "bun-wasm-hot-args-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const source = readFileSync(new URL("../crates/bunwasm-cli/src/main.rs", import.meta.url), "utf8");
const parser = source.slice(source.indexOf("enum Command {"), source.indexOf("// Referenced so the linker"));
const tool = readFileSync(new URL("../crates/bunwasm-cli/src/tool_args.rs", import.meta.url), "utf8");
const file = join(scratch, "args.rs");
writeFileSync(file, `#![allow(dead_code)]
#[derive(Debug, PartialEq)] enum RunMode { Once, Hot }
enum Entry { File(String), Eval(String), Test(Vec<String>) }
mod bunwasm_runtime { pub const BUN_VERSION: &str = "test"; pub const BUN_REVISION: &str = "test"; }
const HELP: &str = "help";
mod tool_args { ${tool} }
${parser.replace("mod tool_args;", "")}
#[test] fn hot_forms() {
    for argv in [vec!["--hot", "run", "entry.ts"], vec!["run", "--hot", "entry.ts"], vec!["--hot", "entry.ts"], vec!["--hot", "--hot", "entry.ts"]] {
        let expected: Vec<_> = argv.iter().filter(|arg| **arg == "--hot").map(|arg| arg.to_string()).collect();
        let Command::Run(Entry::File(_), _, _, flags, mode) = parse_command(argv.into_iter().map(String::from).collect(), false) else { panic!("not file"); };
        assert_eq!(mode, RunMode::Hot); assert_eq!(flags, expected);
    }
}
#[test] fn operands_and_conditions() {
    let Command::Run(_, args, conditions, flags, mode) = parse_command(vec!["run", "--conditions", "custom", "--hot", "--", "entry.ts", "--hot"].into_iter().map(String::from).collect(), false) else { panic!(); };
    assert_eq!(mode, RunMode::Hot); assert_eq!(args, ["--hot"]); assert_eq!(conditions, ["custom"]); assert_eq!(flags, ["--conditions", "custom", "--hot"]);
    let Command::Run(_, args, _, flags, mode) = parse_command(vec!["run", "entry.ts", "--hot"].into_iter().map(String::from).collect(), false) else { panic!(); };
    assert_eq!(mode, RunMode::Once); assert_eq!(args, ["--hot"]); assert!(flags.is_empty());
    let Command::Run(_, _, conditions, _, mode) = parse_command(vec!["--conditions", "--hot", "entry.ts"].into_iter().map(String::from).collect(), false) else { panic!(); };
    assert_eq!(mode, RunMode::Once); assert_eq!(conditions, ["--hot"]);
}
#[test] fn unsupported() {
    for argv in [vec!["--hot", "-e", "1"], vec!["--hot", "test"], vec!["--hot", "run", "-"], vec!["--watch", "entry.ts"], vec!["--hot", "build", "entry.ts"]] {
        assert!(matches!(parse_command(argv.into_iter().map(String::from).collect(), false), Command::Exit(1)));
    }
}
`);

test("real CLI parser carries hot mode independently from execArgv", () => {
  execFileSync("rustc", ["--edition=2024", "--test", file, "-o", join(scratch, "args")]);
  const result = spawnSync(join(scratch, "args"), [], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("test result: ok");
});

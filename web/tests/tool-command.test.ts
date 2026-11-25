import { expect, test } from "bun:test";
import { isToolCommand } from "../src/tool-command";

test("only a CLI lint, fmt or check subcommand selects the tools artifact", () => {
  for (const args of [["lint"], ["fmt", "x.ts"], ["--cwd", "lint", "fmt"], ["--cwd=project", "lint"], ["--config=custom.toml", "--silent", "fmt"],
    ["check"], ["--cwd", "app", "check", "-p", "tsconfig.json"], ["--conditions", "dev", "check"], ["-b", "check"], ["-ptsconfig.json", "check"], ["--", "check"], ["--title=check", "check"], ["--tsconfig-override", "app/tsconfig.json", "check"], ["--project=app", "check"], ["--help", "check"], ["-bpapp", "check", "app"]]) {
    expect(isToolCommand(args)).toBe(true);
  }
  for (const args of [[], ["run", "lint"], ["test", "fmt"], ["build", "fmt"], ["--eval", "lint"], ["-p", "fmt"], ["--cwd", "lint"], ["index.ts", "fmt"],
    ["run", "check"], ["test", "check"], ["--conditions", "check", "run", "./entry.ts"], ["-r", "check", "entry.ts"], ["-brcheck", "entry.ts"],
    ["--print", "1", "check"], ["--", "--entry.ts", "check"], ["-", "check"], ["--project", "app", "check"]]) {
    expect(isToolCommand(args)).toBe(false);
  }
});

test("node runs files, never subcommands", () => {
  for (const executable of ["/bin/node", "nodejs", "/usr/bin/node.wasm"]) expect(isToolCommand(["check"], executable)).toBe(false);
  expect(isToolCommand(["check"], "/bin/bun")).toBe(true);
});

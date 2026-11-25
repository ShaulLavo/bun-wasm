import { expect, test } from "bun:test";
import { isToolCommand } from "../src/tool-command";

test("only a CLI lint, fmt or check subcommand selects the tools artifact", () => {
  for (const args of [["lint"], ["fmt", "x.ts"], ["--cwd", "lint", "fmt"], ["--cwd=project", "lint"], ["--config=custom.toml", "--silent", "fmt"], ["check"], ["--cwd", "app", "check", "-p", "tsconfig.json"]]) expect(isToolCommand(args)).toBe(true);
  for (const args of [[], ["run", "lint"], ["test", "fmt"], ["build", "fmt"], ["--eval", "lint"], ["-p", "fmt"], ["--cwd", "lint"], ["index.ts", "fmt"], ["run", "check"], ["test", "check"]]) expect(isToolCommand(args)).toBe(false);
});

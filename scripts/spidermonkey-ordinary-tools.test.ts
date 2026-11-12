import { expect, test } from "bun:test";
import { nativeGeneration, ordinaryToolVersions } from "./spidermonkey-ordinary-ci.ts";

function generation(changedTool: string, changedVersion: string): string {
  return nativeGeneration(ordinaryToolVersions((tool, args) => {
    expect(args).toEqual(tool === "rustc" ? ["-vV"] : ["--version"]);
    return tool === changedTool ? changedVersion : `${tool} unchanged`;
  }));
}

test("Git updates do not invalidate the pinned ordinary SpiderMonkey build", () => {
  expect(generation("git", "git version 2.56.1")).toBe(generation("git", "git version 2.56.0"));
});

test("compiler and build-tool updates still invalidate ordinary SpiderMonkey", () => {
  const tools = ["/usr/bin/clang", "/usr/bin/clang++", "rustc", "cargo", "llvm-readobj", "python3", "autoconf2.13", "make"];
  expect(ordinaryToolVersions(tool => tool).map(entry => entry.tool)).toEqual(tools);
  for (const tool of tools) expect(generation(tool, "updated")).not.toBe(generation(tool, "original"));
});

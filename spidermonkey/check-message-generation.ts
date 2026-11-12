import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const parser = `import ast, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
script = root / "js/src/builtin/embedjs.py"
module = ast.parse(script.read_text(), filename=str(script))
functions = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "messages"]
assert len(functions) == 1, "missing unique upstream messages function"
context = {"re": re}
exec(compile(ast.Module(body=functions, type_ignores=[]), str(script), "exec"), context)
print(context["messages"](root / "js/public/friend/ErrorNumbers.msg"))
`;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export function checkMessageGeneration(source: string) {
  const definitions = execFileSync("python3", ["-c", parser, source], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  const names = definitions.trimEnd().split("\n").map((line, index) => {
    const match = /^#define (JSMSG_\w+) (\d+)$/.exec(line);
    assert(match && match[1] && Number(match[2]) === index, "invalid generated error definition");
    return match[1];
  });
  assert.equal(new Set(names).size, names.length, "duplicate generated error message");
  return { messages: names.length, definitionsSha256: hash(definitions),
    parserSha256: hash(readFileSync(join(source, "js/src/builtin/embedjs.py"))),
    messageInputSha256: hash(readFileSync(join(source, "js/public/friend/ErrorNumbers.msg"))) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.argv[2];
  assert(source, "usage: node spidermonkey/check-message-generation.ts FIREFOX_SOURCE");
  process.stdout.write(JSON.stringify(checkMessageGeneration(resolve(source))) + "\n");
}

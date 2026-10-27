import type { Fixture } from "./model";

// Bun.$ cases. Each value is checked against SHELL_API_EXPECTED by the browser driver.
const shellApi = `import { $ } from "bun";
const tricky = "it's a \\"quoted\\" $(nope) \`nope\` value";
const results: Record<string, unknown> = {};
await $\`echo SHELL_VISIBLE\`;
results.text = await $\`echo \${tricky}\`.text();
results.json = await $\`echo \${JSON.stringify({ a: 1 })}\`.json();
const lines: string[] = [];
for await (const line of $\`printf '%s\\n' one two\`.lines()) lines.push(line);
results.lines = lines;
results.array = await $\`printf '[%s]' \${["a b", "c"]}\`.text();
results.nothrow = (await $\`exit 3\`.nothrow().quiet()).exitCode;
try {
  await $\`echo boom 1>&2; exit 4\`.quiet();
  results.thrown = "none";
} catch (error) {
  const failure = error as InstanceType<typeof $.ShellError>;
  results.thrown = { name: failure.name, exitCode: failure.exitCode, stderr: failure.stderr.toString() };
}
results.cwd = (await $\`pwd\`.cwd("/tmp").text()).trim();
results.env = (await $\`echo $SHELL_API_VALUE\`.env({ ...process.env, SHELL_API_VALUE: "from-env" }).text()).trim();
results.pipe = await $\`printf 'x\\ny\\nx\\n' | grep x\`.text();
results.redirect = await $\`cat < \${new Response("piped from js\\n")}\`.text();
results.escape = $.escape("a b$c");
results.braces = $.braces("{a,b}{1..2}");
results.raw = await $\`echo \${{ raw: "'raw   quoted'  word" }}\`.text();
console.log("SHELL_API:" + JSON.stringify(results));
`;

export const SHELL_API_EXPECTED = {
  text: "it's a \"quoted\" $(nope) `nope` value\n",
  json: { a: 1 },
  lines: ["one", "two", ""],
  array: "[a b][c]",
  nothrow: 3,
  thrown: { name: "ShellError", exitCode: 4, stderr: "boom\n" },
  cwd: "/tmp",
  env: "from-env",
  pipe: "x\nx\n",
  redirect: "piped from js\n",
  escape: "\"a b\\$c\"",
  braces: ["a{1..2}", "b{1..2}"],
  raw: "raw   quoted word\n",
};

export const bunShellFixture: Fixture = {
  id: "bun-shell",
  files: { "shell-api.ts": shellApi },
  dependencies: {},
  selector: "",
  text: "",
  tool: "",
  buildOutputs: [],
  scripts: {},
};

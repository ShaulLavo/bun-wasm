import assert from "node:assert/strict";
import type { Page } from "playwright";
import { run, terminalText, writeFile } from "./playground.mjs";
import { stopForeground } from "./foreground.ts";

type TerminalPage = typeof globalThis & {
  playground: {
    shell: { submit(command: string): Promise<void>; input(text: string): void; running: boolean };
    term: { buffer: { active: { length: number; getLine(index: number): { translateToString(trim: boolean): string } | undefined } } };
  };
};
const probe = `const label = process.env.STDIN_CASE;
if (process.stdin.isTTY) process.stdin.setRawMode(false);
console.log('OPEN:' + label + ':' + process.stdin.isTTY);
process.stdin.on('data', chunk => console.log('DATA:' + label + ':' + chunk.toString().trim()));
process.stdin.on('end', () => console.log('END:' + label));
`;

async function contains(page: Page, text: string): Promise<void> {
  await page.waitForFunction(text => {
    const buffer = (globalThis as TerminalPage).playground.term.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true)).join("\n").includes(text);
  }, text, { timeout: 15000 });
}

async function interactive(page: Page, name: string, command: string): Promise<void> {
  await page.evaluate(command => { void (globalThis as TerminalPage).playground.shell.submit(command); }, `STDIN_CASE=${name} ${command}`);
  try {
    await contains(page, `OPEN:${name}:true`);
    await page.evaluate(() => (globalThis as TerminalPage).playground.shell.input("hello\r"));
    await contains(page, `DATA:${name}:hello`);
    assert.ok(!((await terminalText(page)).includes(`END:${name}`)), "empty terminal input must not be EOF");
    await page.evaluate(() => (globalThis as TerminalPage).playground.shell.input("again\r"));
    await contains(page, `DATA:${name}:again`);
    await page.evaluate(() => (globalThis as TerminalPage).playground.shell.input("\x04"));
    await contains(page, `END:${name}`);
    await page.waitForFunction(() => !(globalThis as TerminalPage).playground.shell.running, undefined, { timeout: 15000 });
  } finally { await stopForeground(page); }
}

/** The same live terminal must survive env, package scripts and a Node shebang. */
export async function checkPlaygroundStdin(page: Page): Promise<void> {
  await writeFile(page, "/home/user/stdin-probe.ts", probe);
  await writeFile(page, "/home/user/stdin-tool", "#!/usr/bin/env bun\n" + probe);
  const permissions = await run(page, `bun -e 'require("node:fs").chmodSync("stdin-tool", 0o755)'`);
  assert.equal(permissions.code, 0, permissions.output);
  await interactive(page, "direct", "bun run stdin-probe.ts");
  await interactive(page, "env", "env bun run stdin-probe.ts");
  await writeFile(page, "/home/user/stdin-script/package.json", JSON.stringify({ scripts: { probe: "env bun run ../stdin-probe.ts" } }));
  await interactive(page, "package", "sh -c 'cd stdin-script && bun run probe'");
  await interactive(page, "shebang", "./stdin-tool");
  const piped = await run(page, "printf 'pipe\\n' | env STDIN_CASE=pipe bun run stdin-probe.ts");
  assert.equal(piped.code, 0, piped.output);
  for (const text of ["OPEN:pipe:false", "DATA:pipe:pipe", "END:pipe"]) assert.ok(piped.output.includes(text), piped.output);
  await writeFile(page, "/home/user/stdin-input.txt", "file\n");
  const redirected = await run(page, "env STDIN_CASE=file bun run stdin-probe.ts < stdin-input.txt");
  assert.equal(redirected.code, 0, redirected.output);
  for (const text of ["OPEN:file:false", "DATA:file:file", "END:file"]) assert.ok(redirected.output.includes(text), redirected.output);
}

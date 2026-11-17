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
  await contains(page, `OPEN:${name}:true`);
  await page.evaluate(() => (globalThis as TerminalPage).playground.shell.input("hello\r"));
  await contains(page, `DATA:${name}:hello`);
  assert.ok(!((await terminalText(page)).includes(`END:${name}`)), "empty terminal input must not be EOF");
  await page.evaluate(() => (globalThis as TerminalPage).playground.shell.input("again\r"));
  await contains(page, `DATA:${name}:again`);
  await page.evaluate(() => (globalThis as TerminalPage).playground.shell.input("\x04"));
  await contains(page, `END:${name}`);
  await page.waitForFunction(() => !(globalThis as TerminalPage).playground.shell.running, undefined, { timeout: 15000 });
}

export const stdinCaseNames = ["direct bun run stdin-probe.ts", "env bun run stdin-probe.ts", "package sh -c cd stdin-script and bun run probe", "shebang ./stdin-tool", "printf pipe via env", "file redirection via env"] as const;
export interface StdinCaseRecord {
  name: typeof stdinCaseNames[number];
  status: "planned" | "passed" | "failed" | "not-run";
  error?: string;
  cleanup: { safe: boolean; error?: string };
}
export function stdinCaseRecords(): StdinCaseRecord[] {
  return stdinCaseNames.map(name => ({ name, status: "planned", cleanup: { safe: true } }));
}

export async function runStdinCases(actions: readonly (() => Promise<void>)[], cleanup: () => Promise<void>, record: (rows: readonly StdinCaseRecord[]) => void = () => {}): Promise<void> {
  assert.equal(actions.length, stdinCaseNames.length, "all six same-terminal commands");
  const rows = stdinCaseRecords();
  record(rows);
  for (const [index, action] of actions.entries()) {
    const row = rows[index]!;
    try { await action(); row.status = "passed"; }
    catch (error) { row.status = "failed"; row.error = String(error); }
    try { await cleanup(); }
    catch (error) { row.status = "failed"; row.cleanup = { safe: false, error: String(error) }; }
    record(rows);
    if (!row.cleanup.safe) break;
  }
  for (const row of rows) if (row.status === "planned") row.status = "not-run";
  record(rows);
  assert.ok(rows.every(row => row.status === "passed"), JSON.stringify(rows));
}

/** The same live terminal must survive env, package scripts and a Node shebang. */
export async function checkPlaygroundStdin(page: Page, record?: (rows: readonly StdinCaseRecord[]) => void): Promise<void> {
  await writeFile(page, "/home/user/stdin-probe.ts", probe);
  await writeFile(page, "/home/user/stdin-tool", "#!/usr/bin/env bun\n" + probe);
  const permissions = await run(page, `bun -e 'require("node:fs").chmodSync("stdin-tool", 0o755)'`);
  assert.equal(permissions.code, 0, permissions.output);
  await runStdinCases([
    () => interactive(page, "direct", "bun run stdin-probe.ts"),
    () => interactive(page, "env", "env bun run stdin-probe.ts"),
    async () => {
      await writeFile(page, "/home/user/stdin-script/package.json", JSON.stringify({ scripts: { probe: "env bun run ../stdin-probe.ts" } }));
      await interactive(page, "package", "sh -c 'cd stdin-script && bun run probe'");
    },
    () => interactive(page, "shebang", "./stdin-tool"),
    async () => {
      const piped = await run(page, "printf 'pipe\\n' | env STDIN_CASE=pipe bun run stdin-probe.ts");
      assert.equal(piped.code, 0, piped.output);
      for (const text of ["OPEN:pipe:false", "DATA:pipe:pipe", "END:pipe"]) assert.ok(piped.output.includes(text), piped.output);
    },
    async () => {
      await writeFile(page, "/home/user/stdin-input.txt", "file\n");
      const redirected = await run(page, "env STDIN_CASE=file bun run stdin-probe.ts < stdin-input.txt");
      assert.equal(redirected.code, 0, redirected.output);
      for (const text of ["OPEN:file:false", "DATA:file:file", "END:file"]) assert.ok(redirected.output.includes(text), redirected.output);
    },
  ], () => stopForeground(page), record);
}

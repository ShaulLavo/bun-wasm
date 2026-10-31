import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { Runtime } from "waffle";

type ReadFile = Runtime["filesystem"]["readFile"];

export interface PromptReadBarrier {
  readonly entered: Promise<void>;
  release(): void;
  restore(): void;
}

export function armPromptReadBarrier(filesystem: Pick<Runtime["filesystem"], "readFile">, path: string): PromptReadBarrier {
  const original: ReadFile = filesystem.readFile;
  let resolveEntered!: () => void;
  let resolveReleased!: () => void;
  let released = false;
  let restored = false;
  const entered = new Promise<void>(resolve => { resolveEntered = resolve; });
  const releasedRead = new Promise<void>(resolve => { resolveReleased = resolve; });
  const intercepted = async function(this: Runtime["filesystem"], ...args: Parameters<ReadFile>): ReturnType<ReadFile> {
    if (restored || args[0] !== path) return original.apply(this, args);
    resolveEntered();
    await releasedRead;
    return original.apply(this, args);
  };
  filesystem.readFile = intercepted;
  return {
    entered,
    release() {
      if (released) return;
      released = true;
      resolveReleased();
    },
    restore() {
      if (restored) return;
      restored = true;
      resolveReleased();
      filesystem.readFile = original;
    },
  };
}

interface TerminalSnapshot {
  readonly rows: readonly string[];
  readonly cursorLine: string;
  readonly cursorX: number;
  readonly promptRows: number;
}

export async function checkPrompt(page: Page, browser: string, engine: string): Promise<void> {
  assert.equal(new URL(page.url()).searchParams.get("prompt"), null, `${browser}/${engine}: prompt check must use the default provider arm`);
  await page.waitForFunction(() => {
    const shell = Reflect.get(Reflect.get(globalThis, "playground"), "shell");
    return shell.state === "ready" && shell.lastPrompt !== undefined && !shell.running;
  });
  const initial = await terminalSnapshot(page);
  assert.ok(initial.rows.some(line => line.includes("~")), `${browser}/${engine}: initial prompt shows the home directory`);
  assert.ok(initial.rows.some(line => line.includes("❯")), `${browser}/${engine}: initial prompt shows the character segment`);

  await submit(page, "mkdir -p prompt-check && cd prompt-check");
  const directory = await terminalSnapshot(page);
  assert.ok(directory.rows.some(line => line.includes("prompt-check")), `${browser}/${engine}: prompt follows the current directory`);
  await submit(page, "cd ..");

  await submit(page, "false");
  const failed = await characterColor(page);
  await submit(page, "true");
  const passed = await characterColor(page);
  assert.notEqual(failed, passed, `${browser}/${engine}: prompt character color follows the last exit status`);

  await checkLateRedraw(page, browser, engine);
  console.log(`ok ${browser}/${engine}: prompt provider, public readiness, directory, status color and late redraw controls`);
}

async function submit(page: Page, command: string): Promise<void> {
  await page.evaluate(commandText => Reflect.get(Reflect.get(globalThis, "playground"), "shell").submit(commandText), command);
  await page.waitForFunction(() => {
    const shell = Reflect.get(Reflect.get(globalThis, "playground"), "shell");
    return shell.state === "ready" && shell.lastPrompt !== undefined && !shell.running;
  });
}

async function terminalSnapshot(page: Page): Promise<TerminalSnapshot> {
  return page.evaluate(() => {
    const term = Reflect.get(Reflect.get(globalThis, "playground"), "term");
    const buffer = term.buffer.active;
    const rows = Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? "");
    const cursorLine = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? "";
    return { rows, cursorLine, cursorX: buffer.cursorX, promptRows: rows.filter(line => line.includes("❯")).length };
  });
}

async function characterColor(page: Page): Promise<number> {
  return page.evaluate(() => {
    const term = Reflect.get(Reflect.get(globalThis, "playground"), "term");
    const buffer = term.buffer.active;
    for (let row = buffer.length - 1; row >= 0; row--) {
      const line = buffer.getLine(row);
      if (!line) continue;
      for (let column = buffer.cols - 1; column >= 0; column--) {
        const cell = line.getCell(column);
        if (cell?.getChars() === "❯") return cell.getFgColor();
      }
    }
    throw new Error("Prompt character cell was not found");
  });
}

async function checkLateRedraw(page: Page, browser: string, engine: string): Promise<void> {
  const path = "/home/user/prompt-check/tracked.txt";
  await submit(page, "rm -rf /home/user/prompt-check && mkdir -p /home/user/prompt-check && git -C /home/user/prompt-check init && printf base > /home/user/prompt-check/tracked.txt && git -C /home/user/prompt-check add tracked.txt && git -C /home/user/prompt-check -c user.name=test -c user.email=test@example.test commit -m base >/dev/null && printf modified > /home/user/prompt-check/tracked.txt && cd /home/user/prompt-check");
  const barrier = await page.evaluate(() => {
    const state = Reflect.get(globalThis, "playground");
    const filesystem = state.runtime.filesystem;
    const original = filesystem.readFile;
    let resolveEntered!: () => void;
    let resolveReleased!: () => void;
    let released = false;
    const entered = new Promise<void>(resolve => { resolveEntered = resolve; });
    const releasedRead = new Promise<void>(resolve => { resolveReleased = resolve; });
    filesystem.readFile = async function(...args: Parameters<typeof original>) {
      if (args[0] !== "/home/user/prompt-check/tracked.txt") return original.apply(this, args);
      resolveEntered();
      await releasedRead;
      return original.apply(this, args);
    };
    const barrier = { entered, release() { if (released) return; released = true; resolveReleased(); }, restore() { filesystem.readFile = original; resolveReleased(); } };
    Reflect.set(globalThis, "promptReadBarrier", barrier);
    return true;
  });
  assert.equal(barrier, true);
  try {
    const submission = page.evaluate(() => Reflect.get(Reflect.get(globalThis, "playground"), "shell").submit("printf turn"));
    await page.evaluate(() => Reflect.get(globalThis, "promptReadBarrier").entered);
    await page.evaluate(() => Reflect.get(Reflect.get(globalThis, "playground"), "shell").input("echo typed"));
    await page.evaluate(() => new Promise<void>(resolve => Reflect.get(Reflect.get(globalThis, "playground"), "term").write("", resolve)));
    const before = await terminalSnapshot(page);
    assert.ok(before.cursorLine.endsWith("echo typed"), `${browser}/${engine}: typed draft is visible before the delayed prompt read is released`);
    Reflect.get(await page.evaluate(() => Reflect.get(globalThis, "promptReadBarrier")), "release")();
    await submission;
    await page.waitForFunction(() => {
      const shell = Reflect.get(Reflect.get(globalThis, "playground"), "shell");
      return shell.state === "ready" && shell.lastPrompt !== undefined && !shell.running;
    });
    const after = await terminalSnapshot(page);
    assert.equal(after.cursorLine, before.cursorLine, `${browser}/${engine}: delayed prompt update preserves the draft`);
    assert.equal(after.cursorX, before.cursorX, `${browser}/${engine}: delayed prompt update preserves the caret`);
    assert.equal(after.promptRows, before.promptRows, `${browser}/${engine}: delayed prompt update does not duplicate prompt rows`);
  } finally {
    await page.evaluate(() => {
      const barrier = Reflect.get(globalThis, "promptReadBarrier");
      barrier.restore();
      Reflect.deleteProperty(globalThis, "promptReadBarrier");
    });
  }
}

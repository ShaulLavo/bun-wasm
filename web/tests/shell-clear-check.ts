import assert from "node:assert/strict";
import type { Page } from "playwright";

async function prompt(page: Page, command: string): Promise<void> {
  const generation = await page.evaluate(() => String(Reflect.get(globalThis, "playground").shell.bridge.readPrompt().generation));
  await page.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
  await page.waitForFunction(previous => {
    const { shell } = Reflect.get(globalThis, "playground");
    return String(shell.bridge.readPrompt()?.generation) !== previous && !shell.running;
  }, generation);
}

async function visibleInput(page: Page, text: string): Promise<void> {
  await page.waitForFunction(expected => {
    const { term } = Reflect.get(globalThis, "playground");
    const buffer = term.buffer.active;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    if (!line?.translateToString(true).endsWith(expected)) return false;
    if (!document.querySelector(".xterm-rows")?.textContent?.includes(expected)) return false;
    const start = buffer.cursorX - expected.length;
    return Array.from({ length: expected.length }, (_, index) => line.getCell(start + index)).every(cell => cell && !cell.isInvisible());
  }, text);
}

export async function checkClearTyping(page: Page, screenshot?: string): Promise<void> {
  await prompt(page, "seq 1 100");
  await prompt(page, "clear");
  await page.keyboard.type("echo CLEAR_4x");
  await visibleInput(page, "echo CLEAR_4x");
  if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
  await page.keyboard.press("Backspace");
  await page.keyboard.type("2");
  await visibleInput(page, "echo CLEAR_42");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const { term, shell } = Reflect.get(globalThis, "playground");
    const buffer = term.buffer.active;
    return !shell.running && Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true)).includes("CLEAR_42");
  });
  assert.equal(await page.evaluate(() => Reflect.get(globalThis, "playground").shell.lastExit), 0);
}

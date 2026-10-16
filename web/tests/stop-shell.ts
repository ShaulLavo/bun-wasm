import type { Page } from "playwright";

export async function stopShell(page: Page): Promise<void> {
  await page.click(".xterm");
  await page.keyboard.press("Control+c");
}

import { expect, test } from "bun:test";
import { chromium, webkit, type BrowserType, type Page } from "playwright";
import { armIphoneClick } from "./iphone-browser";
import { withHeldPreview, type Hold } from "./iphone-load-fixture";

// Shaped like the executor's terminal read: an owner-page promise that settles on a later task.
const diagnostic = 'new Promise(resolve => setTimeout(() => resolve(document.querySelector("#editor").id), 0))';
const arm = `(${armIphoneClick.toString()})("button", "button")`;
const armedType = (page: Page): Promise<string> => page.frameLocator("iframe").locator("button").evaluate(() => typeof Reflect.get(globalThis, "__goalsIphoneClick"));
const frameActive = (page: Page) => page.waitForFunction(() => document.activeElement?.id === "__goalsIphonePreview", undefined, { timeout: 2000 });

async function diagnosticsWhileHeld(engine: BrowserType, hold: Hold): Promise<void> {
  await withHeldPreview(engine, hold, 5000, async ({ page, bus, transport, preview, requested, presented, deviceCommands, release }) => {
    let outcome = "pending";
    const opening = transport.openPreview(preview).then(() => { outcome = "presented"; }, (error: unknown) => { outcome = String(error); });
    await requested;
    // Allow the presentation command to return. If it never does, the reads below report the owner as busy.
    await Promise.race([presented, Bun.sleep(1000)]);
    for (let read = 0; read < 5; read++) {
      await transport.useHost();
      expect(await transport.evaluate<string>(diagnostic)).toBe("editor");
    }
    expect(outcome).toBe("pending");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("editor");
    if (hold === "document") expect(bus.state("preview")).toEqual({ url: preview, nonce: expect.any(String), visible: false });
    else expect(await armedType(page)).toBe("undefined");
    release();
    await opening;
    expect(outcome).toBe("presented");
    await frameActive(page);
    expect(await transport.evaluate(arm)).toMatchObject({ ready: true, before: "Count 0" });
    expect(await transport.evaluate("document.hasFocus()")).toBe(false);
    expect(deviceCommands()).toEqual([]);
    await transport.closePreview();
    expect(await page.locator("iframe").count()).toBe(0);
  });
}

async function expiredLoadRefusesInput(engine: BrowserType): Promise<void> {
  await withHeldPreview(engine, "document", 1000, async ({ page, transport, preview, deviceCommands, release }) => {
    const failure = await transport.openPreview(preview).then(() => "presented", (error: unknown) => String(error));
    expect(failure).not.toBe("presented");
    await transport.useHost();
    expect(await transport.evaluate<string>(diagnostic)).toBe("editor");
    expect(failure).toContain("iPhone preview document did not finish within 1000 ms");
    expect(failure).toContain('"visible":false');
    expect(failure).not.toContain("timeOrigin");
    release();
    // The late load still focuses the frame it belongs to, but the expired opening never arms or presses.
    await frameActive(page);
    await expect(transport.nativeClick!("button", "button", 500)).rejects.toThrow("not focused after load");
    expect(await armedType(page)).toBe("undefined");
    expect(deviceCommands()).toEqual([]);
  });
}

async function closingCancelsHeldLoad(engine: BrowserType): Promise<void> {
  await withHeldPreview(engine, "resource", 5000, async ({ page, transport, preview, requested, deviceCommands, release, controllerRequests }) => {
    const opening = transport.openPreview(preview).then(() => "presented", (error: unknown) => String(error));
    await requested;
    await transport.close();
    expect(await opening).toContain("iPhone transport closing");
    const settled = controllerRequests();
    release();
    await frameActive(page);
    await Bun.sleep(250);
    expect(controllerRequests()).toBe(settled);
    await expect(transport.nativeClick!("button", "button", 500)).rejects.toThrow();
    expect(controllerRequests()).toBe(settled);
    expect(await armedType(page)).toBe("undefined");
    expect(deviceCommands()).toEqual([]);
  });
}

for (const engine of [chromium, webkit]) {
  for (const hold of ["document", "resource"] satisfies Hold[]) {
    test(`owner diagnostics stay available while the preview ${hold} never finishes loading in ${engine.name()}`, () => diagnosticsWhileHeld(engine, hold), 20000);
  }
  test(`an expired preview load frees the owner channel and refuses late native input in ${engine.name()}`, () => expiredLoadRefusesInput(engine), 20000);
  test(`closing the transport cancels a held preview load without later control traffic or input in ${engine.name()}`, () => closingCancelsHeldLoad(engine), 20000);
}

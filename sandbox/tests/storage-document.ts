import assert from "node:assert/strict";
import type { Page } from "playwright";
import { storageStep, type StorageObservation } from "../../scripts/storage-browser-evidence";

export async function assertPreviewDocumentPreserved(page: Page, update: () => Promise<void>, observer?: StorageObservation): Promise<void> {
  // A parent-realm object survives preview reloads without Playwright adopting a detached DOM handle.
  const capture = () => page.evaluateHandle(() => {
    const frame = document.querySelector("#preview");
    if (!(frame instanceof HTMLIFrameElement) || !frame.contentDocument) throw new Error("Preview document is unavailable");
    return { document: frame.contentDocument };
  });
  const acquired = observer ? await observer.acquire("vanilla.document-before-hmr", capture, identity => identity.dispose()) : undefined;
  const identity = acquired ? acquired.value : await capture();
  try {
    await update();
    observer?.event("assert", { phase: "vanilla.hmr-document" });
    const same = await storageStep(observer, "vanilla.document-after-hmr", () => page.evaluate(previous => {
      const frame = document.querySelector("#preview");
      return frame instanceof HTMLIFrameElement && frame.contentDocument === previous.document;
    }, identity));
    assert.equal(same, true, "restored source HMR replaced the document");
  } finally {
    if (acquired) await acquired.release();
    else await identity.dispose();
  }
}

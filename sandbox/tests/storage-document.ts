import assert from "node:assert/strict";
import type { Page } from "playwright";
import { storageStep, type StorageObservation } from "../../scripts/storage-browser-evidence";

export async function assertPreviewDocumentPreserved(page: Page, update: () => Promise<void>, observer?: StorageObservation): Promise<void> {
  // Hold the Document in the parent realm so preview reloads leave it comparable.
  const capture = () => page.locator("#preview").evaluateHandle(frame => {
    if (!(frame instanceof HTMLIFrameElement) || !frame.contentDocument) throw new Error("Preview document is unavailable");
    return frame.contentDocument;
  });
  const acquired = observer ? await observer.acquire("vanilla.document-before-hmr", capture, document => document.dispose()) : undefined;
  const document = acquired ? acquired.value : await capture();
  try {
    await update();
    observer?.event("assert", { phase: "vanilla.hmr-document" });
    const same = await storageStep(observer, "vanilla.document-after-hmr", () => page.locator("#preview").evaluate(
      (frame, previous) => frame instanceof HTMLIFrameElement && frame.contentDocument === previous, document,
    ));
    assert.equal(same, true, "restored source HMR replaced the document");
  } finally {
    if (acquired) await acquired.release();
    else await document.dispose();
  }
}

// Bun's registration policy; routing and socket transport are guest-independent.
import { PreviewRouter } from "waffle/browser/preview";
import { activated } from "waffle/browser/service-worker";
import { PREVIEW_DIR } from "./preview-protocol";

export { activated } from "waffle/browser/service-worker";
export type PreviewState = "ready" | "unsupported" | "failed";

export class Previews extends PreviewRouter {
  private registration: Promise<PreviewState> | undefined;

  /** First preview use registers its scope; module loading owns its separate eager scope. */
  get ready(): Promise<PreviewState> {
    return this.registration ??= this.registerWorker();
  }

  constructor() {
    super({ baseURL: location.href, prefix: PREVIEW_DIR });
  }

  private async registerWorker(): Promise<PreviewState> {
    const container = navigator.serviceWorker;
    if (!container) return "unsupported";
    container.addEventListener("message", event => this.onMessage(event));
    container.startMessages();
    try {
      // Keep the playground itself outside this worker's scope (and COOP/COEP untouched).
      const registration = await container.register("./sw.js", { scope: `./${PREVIEW_DIR}/` });
      await activated(registration);
      return "ready";
    } catch (err) {
      console.warn("preview service worker registration failed:", err);
      return "failed";
    }
  }
}

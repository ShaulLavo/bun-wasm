import { on, ref, type Handle } from "@remix-run/component";
import type { Playground } from "./playground";
import { copy } from "./showcase-copy";

type Props = { playground: Playground };
type FrameState = "waiting" | "loaded" | "failed";

/** How often a preview origin's frame is loaded again after its service worker reported a passing failure. */
const ORIGIN_RETRIES = 4;

/**
 * The preview service worker first serves a same-origin loading page while the server
 * answers. Its status element carries `data-preview-loading` with its waiting text, and the
 * page rewrites that text only when the preview request fails. A frame without the marker
 * (the real page, or one that cannot be read) counts as loaded.
 */
function loadingStatus(frame: HTMLIFrameElement): HTMLElement | undefined {
  try {
    return frame.contentDocument?.querySelector<HTMLElement>("[data-preview-loading]") ?? undefined;
  } catch {
    return undefined;
  }
}

function loadingFailed(status: HTMLElement): boolean {
  return status.textContent !== status.dataset.previewLoading;
}

/**
 * A server from the examples workspace, shown above the terminal while it listens. The frame
 * stays hidden on the page's own ground until its page loads, so no blank document flashes;
 * when the preview request fails the dock says so instead of spinning.
 * Restart appears only when the playground started the server (Run or a demo).
 *
 * A preview on its own origin cannot be read from here, and its frame's `load` event fires for
 * error pages too, so the playground reports what that frame says about itself.
 */
export function PreviewDock(handle: Handle<Props>) {
  let state: FrameState = "waiting";
  let watch: MutationObserver | undefined;
  let ownOrigin = false;
  handle.signal.addEventListener("abort", () => watch?.disconnect());
  const settle = (next: FrameState) => {
    if (state !== "waiting") return;
    state = next;
    watch?.disconnect();
    void handle.update();
  };
  const restart = on<HTMLButtonElement>("click", () => {
    const { playground } = handle.props;
    void playground.restartPreview().catch(playground.report);
  });
  const close = on<HTMLButtonElement>("click", () => handle.props.playground.closePreview());
  const observe = ref((node, signal) => {
    const frame = node as HTMLIFrameElement;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = handle.props.playground.watchPreviewFrame(frame, {
      loaded: () => settle("loaded"),
      failed(transient) {
        if (!transient || retries >= ORIGIN_RETRIES) { settle("failed"); return; }
        clearTimeout(timer);
        timer = setTimeout(() => { frame.src = handle.props.playground.dockedPreview?.url ?? frame.src; }, 250 * ++retries);
      },
    });
    ownOrigin = stop !== undefined;
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      stop?.();
    });
  });
  const load = on<HTMLIFrameElement>("load", (event) => {
    if (ownOrigin) return;
    const status = loadingStatus(event.currentTarget);
    if (!status) return settle("loaded");
    watch?.disconnect();
    // The request may already have failed before this load event ran.
    if (loadingFailed(status)) return settle("failed");
    watch = new MutationObserver(() => { if (loadingFailed(status)) settle("failed"); });
    watch.observe(status, { childList: true, characterData: true, subtree: true });
  });
  return () => {
    const { playground } = handle.props;
    const preview = playground.dockedPreview;
    if (!preview) return null;
    const label = `localhost:${preview.port}/`;
    return (
      <section class="pane preview-dock" aria-label={copy.preview.aria} data-frame={state}>
        <div class="bar">
          <span class="live" aria-hidden="true" />
          <span class="preview-address" title={preview.url}>{label}</span>
          {preview.launch
            ? <button type="button" class="control" title={copy.preview.restartTitle} disabled={!playground.canStartDemo} mix={restart}>{copy.preview.restart}</button>
            : null}
          <a class="control" href={preview.link} target="_blank" rel="noopener" title={copy.preview.openTitle}>{copy.preview.open}</a>
          <button type="button" class="control" title={copy.preview.closeTitle} mix={close}>{copy.preview.close}</button>
        </div>
        <div class="preview-frame">
          {state === "waiting" ? <p class="preview-waiting" role="status"><span class="spinner" aria-hidden="true" />{copy.preview.waiting}</p> : null}
          {state === "failed" ? <p class="preview-waiting preview-failed" role="alert">{copy.preview.failed}</p> : null}
          <iframe title={copy.preview.frameTitle} src={preview.url} mix={[observe, load]} />
        </div>
      </section>
    );
  };
}

import { on, type Handle } from "@remix-run/component";
import type { Playground } from "./playground";
import { copy } from "./showcase-copy";

type Props = { playground: Playground };
type FrameState = "waiting" | "loaded" | "failed";

/**
 * The preview service worker first serves a same-origin "Loading preview" page while the
 * server answers. Its status element is the only thing that page rewrites, and only when the
 * preview request fails, so a change there is the failure signal. A frame whose document
 * cannot be read counts as loaded.
 */
function loadingStatus(frame: HTMLIFrameElement): Element | null | undefined {
  try {
    const document = frame.contentDocument;
    if (document?.title !== "Loading preview") return undefined;
    return document.querySelector('[role="status"]');
  } catch {
    return undefined;
  }
}

/**
 * A server from the examples workspace, shown above the terminal while it listens. The frame
 * stays hidden on the page's own ground until its page loads, so no blank document flashes;
 * when the preview request fails the dock says so instead of spinning.
 * Restart appears only when the playground started the server (Run or a demo).
 */
export function PreviewDock(handle: Handle<Props>) {
  let state: FrameState = "waiting";
  let watch: MutationObserver | undefined;
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
  const load = on<HTMLIFrameElement>("load", (event) => {
    const status = loadingStatus(event.currentTarget);
    if (status === undefined) return settle("loaded");
    watch?.disconnect();
    if (!status) return;
    watch = new MutationObserver(() => settle("failed"));
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
          <a class="control" href={preview.url} target="_blank" rel="noopener" title={copy.preview.openTitle}>{copy.preview.open}</a>
          <button type="button" class="control" title={copy.preview.closeTitle} mix={close}>{copy.preview.close}</button>
        </div>
        <div class="preview-frame">
          {state === "waiting" ? <p class="preview-waiting" role="status"><span class="spinner" aria-hidden="true" />{copy.preview.waiting}</p> : null}
          {state === "failed" ? <p class="preview-waiting preview-failed" role="alert">{copy.preview.failed}</p> : null}
          <iframe title={copy.preview.frameTitle} src={preview.url} mix={load} />
        </div>
      </section>
    );
  };
}

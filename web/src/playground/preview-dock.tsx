import { on, type Handle } from "@remix-run/component";
import type { Playground } from "./playground";
import { copy } from "./showcase-copy";

type Props = { playground: Playground };

/**
 * The preview service worker first serves a same-origin "Loading preview" page while the
 * server answers. Keep waiting through it; a frame whose document cannot be read counts as loaded.
 */
function isLoadingDocument(frame: HTMLIFrameElement): boolean {
  try {
    return frame.contentDocument?.title === "Loading preview";
  } catch {
    return false;
  }
}

/**
 * A server from the examples workspace, shown above the terminal while it listens. The frame
 * stays hidden on the page's own ground until its first load, so no blank document flashes.
 * Restart appears only when the playground started the server (Run or a demo).
 */
export function PreviewDock(handle: Handle<Props>) {
  let loaded = false;
  const restart = on<HTMLButtonElement>("click", () => {
    const { playground } = handle.props;
    void playground.restartPreview().catch(playground.report);
  });
  const close = on<HTMLButtonElement>("click", () => handle.props.playground.closePreview());
  const load = on<HTMLIFrameElement>("load", (event) => {
    if (loaded || isLoadingDocument(event.currentTarget)) return;
    loaded = true;
    void handle.update();
  });
  return () => {
    const { playground } = handle.props;
    const preview = playground.dockedPreview;
    if (!preview) return null;
    const label = `localhost:${preview.port}/`;
    return (
      <section class="pane preview-dock" aria-label={copy.preview.aria} data-loaded={loaded ? "" : undefined}>
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
          {loaded ? null : <p class="preview-waiting" role="status"><span class="spinner" aria-hidden="true" />{copy.preview.waiting}</p>}
          <iframe title={copy.preview.frameTitle} src={preview.url} mix={load} />
        </div>
      </section>
    );
  };
}

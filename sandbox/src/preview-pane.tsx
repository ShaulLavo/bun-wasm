import { ref, type Handle } from "@remix-run/component";
import type { Sandbox } from "./sandbox";

export function PreviewPane(handle: Handle<{ sandbox: Sandbox }>) {
  // The sandbox navigates the frame itself: each dev server start reloads it, even at the same address.
  const attach = ref((node) => handle.props.sandbox.attachPreview(node as HTMLIFrameElement));
  return () => {
    const { serverState, previewLink } = handle.props.sandbox;
    const { state, text, url } = serverState;
    return (
      <section class="pane preview-pane" aria-label="Preview">
        <div class="bar">
          <span class="dot" id="server-dot" aria-hidden="true" data-state={state}></span>
          <a id="preview-url" href={url} target="_blank" rel="noopener" title="Open the preview in a new tab">{text}</a>
          <a
            id="open-preview" href={previewLink} target="_blank" rel="noopener" title="Open the preview in a new tab"
            aria-disabled={state === undefined ? undefined : state !== "up"}
          >↗</a>
        </div>
        <iframe id="preview" title="App preview" mix={attach}></iframe>
      </section>
    );
  };
}

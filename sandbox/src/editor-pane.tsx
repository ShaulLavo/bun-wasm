import { on, ref, type Handle } from "@remix-run/component";
import type { EditorView } from "@codemirror/view";
import type { Sandbox } from "./sandbox";

export function EditorPane(handle: Handle<{ sandbox: Sandbox }>) {
  return () => {
    const { sandbox } = handle.props;
    const { editor } = sandbox;
    const saveState = editor?.saveState;
    return (
      <section class="pane editor-pane" aria-label="Editor">
        <div class="bar">
          <select
            id="file-select" aria-label="File" disabled={sandbox.failure !== undefined}
            mix={on("change", (event) => void editor?.open(event.currentTarget.value).catch(sandbox.report))}
          >
            {sandbox.files.filter((path) => !path.startsWith("node_modules/")).map((path) => <option key={path} value={path} selected={path === editor?.path}>{path}</option>)}
          </select>
          <span id="file-name">{editor?.path}</span>
          <span id="save-state" aria-live="polite" data-kind={saveState?.kind}>{saveState?.text}</span>
        </div>
        {editor ? <EditorHost key="view" view={editor.view} /> : <div id="editor" />}
      </section>
    );
  };
}

/** Places the editor's CodeMirror view; the view, its documents and undo history belong to the editor. */
function EditorHost(handle: Handle<{ view: EditorView }>) {
  const place = ref((node, signal) => {
    const { view } = handle.props;
    node.append(view.dom);
    view.requestMeasure();
    signal.addEventListener("abort", () => view.dom.remove());
  });
  return () => <div id="editor" mix={place} />;
}

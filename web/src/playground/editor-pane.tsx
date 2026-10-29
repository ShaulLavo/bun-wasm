import { on, ref, type Handle } from "@remix-run/component";
import type { EditorView } from "@codemirror/view";
import { HOME } from "../examples";
import type { Editor } from "./editor";
import type { Playground } from "./playground";

type Props = { playground: Playground };

export function EditorPane(handle: Handle<Props>) {
  const newFile = on<HTMLButtonElement>("click", () => {
    const name = prompt("New file name (in ~):", "scratch.ts");
    if (!name) return;
    const { playground } = handle.props;
    void playground.newFile(name).catch(playground.report);
  });
  return () => {
    const { playground } = handle.props;
    const { editor, locked } = playground;
    return (
      <section class="pane editor-pane" aria-label="Editor">
        <div class="tabbar">
          <Tabs editor={editor} report={playground.report} />
          {/* Phones get a file dropdown instead of the tab strip, so nothing scrolls sideways. */}
          <select
            id="file-select" aria-label="File" disabled={locked}
            mix={on("change", (event) => void editor?.open(event.currentTarget.value).catch(playground.report))}
          >
            {editor?.files.map((path) => <option key={path} value={path} selected={path === editor.path}>{label(editor, path)}</option>)}
          </select>
          <button id="new-file" type="button" title="New file" aria-label="New file" disabled={locked} mix={newFile}>+</button>
        </div>
        {editor ? <EditorHost key="view" view={editor.view} /> : <div id="editor" />}
      </section>
    );
  };
}

function Tabs(handle: Handle<{ editor?: Editor; report(error: unknown): void }>) {
  let tabs: HTMLElement | undefined;
  return () => {
    const { editor, report } = handle.props;
    handle.queueTask(() => tabs?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }));
    return (
      <div id="tabs" role="tablist" mix={ref((node) => { tabs = node as HTMLElement; })}>
        {editor?.files.map((path) => (
          <button
            key={path} class="tab" type="button" role="tab" aria-selected={path === editor.path} title={path}
            mix={on("click", () => void editor.open(path).catch(report))}
          >
            {label(editor, path)}
          </button>
        ))}
      </div>
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

function label(editor: Editor, path: string): string {
  return path.slice(HOME.length + 1) + (editor.dirty(path) ? " •" : "");
}

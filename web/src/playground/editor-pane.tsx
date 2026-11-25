import { on, ref, type Handle } from "@remix-run/component";
import type { EditorView } from "@codemirror/view";
import { HOME } from "../examples";
import type { Editor } from "./editor";
import type { Playground } from "./playground";

type Props = { playground: Playground };

const BINARY = /\.(sqlite3?|db|wasm|png|jpe?g|gif|webp|ico|woff2?|ttf|zip|gz|br)$/i;
const GENERATED = /^(dist|out|build|node_modules)\//;

/**
 * Tab order: the active demo's file first, then sources alphabetically, then generated output
 * (dist/ and similar) last. Binary files are left out unless one is open.
 */
export function orderFiles(files: readonly string[], first: string | undefined, open: string): string[] {
  const relative = (path: string) => path.slice(HOME.length + 1);
  const shown = files.filter(path => path === open || !BINARY.test(path));
  const rank = (path: string) => (path === first ? 0 : GENERATED.test(relative(path)) ? 2 : 1);
  return shown.toSorted((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

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
    const demoFile = playground.activeDemo ? `${HOME}/${playground.activeDemo.file}` : undefined;
    const files = editor ? orderFiles(editor.files, demoFile, editor.path) : [];
    return (
      <section class="pane editor-pane" aria-label="Editor">
        <div class="tabbar">
          <Tabs editor={editor} files={files} report={playground.report} />
          {/* Phones get a file dropdown instead of the tab strip, so nothing scrolls sideways. */}
          <select
            id="file-select" aria-label="File" disabled={locked}
            mix={on("change", (event) => void editor?.open(event.currentTarget.value).catch(playground.report))}
          >
            {editor ? files.map((path) => <option key={path} value={path} selected={path === editor.path}>{label(editor, path)}</option>) : null}
          </select>
          <button id="new-file" type="button" title="New file" aria-label="New file" disabled={locked} mix={newFile}>+</button>
        </div>
        {editor ? <EditorHost key="view" view={editor.view} /> : <div id="editor" />}
      </section>
    );
  };
}

/** Marks which edges of the tab strip hide tabs, so CSS can fade only those edges. */
function markOverflow(tabs: HTMLElement): void {
  const { scrollLeft, scrollWidth, clientWidth } = tabs;
  tabs.toggleAttribute("data-more-left", scrollLeft > 1);
  tabs.toggleAttribute("data-more-right", scrollLeft + clientWidth < scrollWidth - 1);
}

function Tabs(handle: Handle<{ editor?: Editor; files: readonly string[]; report(error: unknown): void }>) {
  let tabs: HTMLElement | undefined;
  const attach = ref((node, signal) => {
    tabs = node as HTMLElement;
    const element = tabs;
    element.addEventListener("scroll", () => markOverflow(element), { passive: true, signal });
    const resize = new ResizeObserver(() => markOverflow(element));
    resize.observe(element);
    signal.addEventListener("abort", () => resize.disconnect());
  });
  return () => {
    const { editor, files, report } = handle.props;
    handle.queueTask(() => {
      tabs?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (tabs) markOverflow(tabs);
    });
    return (
      <div id="tabs" role="tablist" mix={attach}>
        {editor ? files.map((path) => (
          <button
            key={path} class="tab" type="button" role="tab" aria-selected={path === editor.path} title={path}
            data-generated={GENERATED.test(path.slice(HOME.length + 1)) ? "" : undefined}
            mix={on("click", () => void editor.open(path).catch(report))}
          >
            {label(editor, path)}
          </button>
        )) : null}
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

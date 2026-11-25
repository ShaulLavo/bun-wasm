import { on, type Handle } from "@remix-run/component";
import { EditorPane } from "./editor-pane";
import { FileTree } from "./file-tree";
import { PreviewPane } from "./preview-pane";
import type { Sandbox } from "./sandbox";
import { TerminalPane } from "./terminal-pane";
import { templates } from "./template-catalog";

/** The link to the playground's one-click Bun API demos (copy lives here so the sandbox page imports no playground module). */
const DEMOS_LINK = { text: "Bun API demos", title: "Bun.serve, bun:sqlite, bun test, Bun.build and Bun.$ in one click" };

type Props = { sandbox: Sandbox };

const ENGINE_OPTIONS = [["browser", "Browser (native)"], ["quickjs", "QuickJS"], ["jsc", "JSC"]] as const;
const RELOAD_TITLES = { construction: "Retry sandbox startup", startup: "Open the latest saved workspace", storage: "Retry saving and starting without leaving this page" };

export function App(handle: Handle<Props>) {
  const { sandbox } = handle.props;
  sandbox.addEventListener("change", () => void handle.update(), { signal: handle.signal });
  return () => (
    <>
      <Header sandbox={sandbox} />
      {sandbox.storageNotice && <p id="storage-status" role="status">{sandbox.storageNotice}</p>}
      <main>
        <FileTree sandbox={sandbox} />
        <EditorPane sandbox={sandbox} />
        <PreviewPane sandbox={sandbox} />
        <TerminalPane sandbox={sandbox} />
      </main>
    </>
  );
}

function Header(handle: Handle<Props>) {
  const { sandbox } = handle.props;
  const choose = (param: "engine" | "template") => on<HTMLSelectElement>("change", (event) => {
    void sandbox.navigate(param, event.currentTarget.value).catch(sandbox.report);
  });
  const reset = on<HTMLButtonElement>("click", () => {
    if (!confirm(`Reset the ${sandbox.template} workspace to its template? All changes in this workspace will be deleted.`)) return;
    void sandbox.reset();
  });
  const restart = on<HTMLButtonElement>("click", () => sandbox.restart());
  const startFresh = on<HTMLButtonElement>("click", () => {
    if (!confirm(`Delete this browser's saved ${sandbox.template} workspace and start again from its template? Its files cannot be opened and will be lost.`)) return;
    void sandbox.startFresh();
  });
  return () => {
    const { status, failure, resetting, navigating } = sandbox;
    const locked = resetting || navigating || failure !== undefined;
    return (
      <header>
        <h1><span class="logo" aria-hidden="true">🥟</span> bun<span class="dim">.wasm</span> <span class="product">sandbox</span></h1>
        <span id="status" role="status" aria-live="polite" data-kind={status.kind}>{status.text}</span>
        <a class="nav showcase-link" href="./playground/?demo=serve" title={DEMOS_LINK.title}>{DEMOS_LINK.text}</a>
        <label class="engine template-choice">
          <span class="label">Template</span>
          <select id="template" aria-label="App template" title="App template" disabled={locked} mix={choose("template")}>
            {templates.map(template => <option value={template.id} selected={sandbox.template === template.id}>{template.label}</option>)}
          </select>
        </label>
        <label class="engine">
          <span class="label">Engine</span>
          <select id="engine" aria-label="JavaScript engine" title="JavaScript engine (restarts the dev server)" disabled={locked} mix={choose("engine")}>
            {ENGINE_OPTIONS.map(([value, label]) => <option value={value} selected={value === sandbox.engine}>{label}</option>)}
          </select>
        </label>
        {sandbox.unreadable
          ? <button id="start-fresh" type="button" title="Delete the workspace that cannot be opened and start from the template" disabled={resetting || navigating} mix={startFresh}>Start fresh</button>
          : <button id="reset" type="button" title="Discard this workspace and restore its template" disabled={locked || !sandbox.workspaceInitialized} mix={reset}>Reset template</button>}
        {failure
          ? <button id="restart" type="button" title={RELOAD_TITLES[failure]} mix={restart}>{failure === "storage" ? "Retry" : "Reload"}</button>
          : <button id="restart" type="button" title="Restart the dev server" disabled={resetting || navigating} mix={restart}>↻ Restart</button>}
      </header>
    );
  };
}

import { on, type Handle } from "@remix-run/component";
import { EditorPane } from "./editor-pane";
import { FileTree } from "./file-tree";
import { PreviewPane } from "./preview-pane";
import type { Sandbox } from "./sandbox";
import { TerminalPane } from "./terminal-pane";

type Props = { sandbox: Sandbox };

const ENGINE_OPTIONS = [["browser", "Browser (native)"], ["quickjs", "QuickJS"], ["jsc", "JSC"]] as const;
const RELOAD_TITLES = { construction: "Retry sandbox startup", startup: "Open the latest saved workspace" };

export function App(handle: Handle<Props>) {
  const { sandbox } = handle.props;
  sandbox.addEventListener("change", () => void handle.update(), { signal: handle.signal });
  return () => (
    <>
      <Header sandbox={sandbox} />
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
  return () => {
    const { status, failure, resetting } = sandbox;
    const locked = resetting || failure !== undefined;
    return (
      <header>
        <h1><span class="logo" aria-hidden="true">🥟</span> bun<span class="dim">.wasm</span> <span class="product">sandbox</span></h1>
        <span id="status" role="status" aria-live="polite" data-kind={status.kind}>{status.text}</span>
        <a class="nav" href="./playground/" title="Terminal playground: bun test, bun build, bun:sqlite">Playground</a>
        <label class="engine template-choice">
          <span class="label">Template</span>
          <select id="template" aria-label="App template" title="App template" disabled={locked} mix={choose("template")}>
            <option value="react" selected={sandbox.template === "react"}>React</option>
            <option value="vanilla" selected={sandbox.template === "vanilla"}>Vanilla TS</option>
          </select>
        </label>
        <label class="engine">
          <span class="label">Engine</span>
          <select id="engine" aria-label="JavaScript engine" title="JavaScript engine (restarts the dev server)" disabled={locked} mix={choose("engine")}>
            {ENGINE_OPTIONS.map(([value, label]) => <option value={value} selected={value === sandbox.engine}>{label}</option>)}
          </select>
        </label>
        <button id="reset" type="button" title="Discard this workspace and restore its template" disabled={locked} mix={reset}>Reset template</button>
        {failure
          ? <button id="restart" type="button" title={RELOAD_TITLES[failure]} mix={restart}>Reload</button>
          : <button id="restart" type="button" title="Restart the dev server" disabled={resetting} mix={restart}>↻ Restart</button>}
      </header>
    );
  };
}

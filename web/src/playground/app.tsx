import { on, type Handle } from "@remix-run/component";
import { followVisualViewport } from "../viewport";
import { EditorPane } from "./editor-pane";
import type { Playground } from "./playground";
import { TerminalPane } from "./terminal-pane";

type Props = { playground: Playground };

const ENGINE_OPTIONS = [["browser", "Browser (native)"], ["quickjs", "QuickJS (9 MB)"], ["jsc", "JSC (43 MB)"]] as const;
const RUN_TITLE = "Save and run (Ctrl/Cmd-Enter)";
const RELOAD_TITLES = { startup: "Retry playground startup", ownership: "Open the latest saved workspace", shell: RUN_TITLE };

export function App(handle: Handle<Props>) {
  const { playground } = handle.props;
  playground.addEventListener("change", () => void handle.update(), { signal: handle.signal });
  followVisualViewport(handle.signal);
  return () => (
    <>
      <Header playground={playground} />
      <main>
        <EditorPane playground={playground} />
        <TerminalPane playground={playground} />
      </main>
    </>
  );
}

function Header(handle: Handle<Props>) {
  return () => {
    const { playground } = handle.props;
    const { status } = playground;
    return (
      <header>
        <h1><span class="logo" aria-hidden="true">🥟</span> bun<span class="dim">.wasm</span></h1>
        <span id="status" role="status" aria-live="polite" data-kind={status.kind}>{status.text}</span>
        <a class="nav" href="../" title="React sandbox with hot reload">Sandbox</a>
        <select
          id="engine" aria-label="JavaScript engine" title="JavaScript engine (reloads the page)"
          value={playground.engine} disabled={playground.locked}
          mix={on("change", (event) => playground.chooseEngine(event.currentTarget.value))}
        >
          {ENGINE_OPTIONS.map(([value, label]) => <option value={value}>{label}</option>)}
        </select>
        <RunButton playground={playground} />
      </header>
    );
  };
}

function RunButton(handle: Handle<Props>) {
  const click = on<HTMLButtonElement>("click", () => {
    const { playground } = handle.props;
    if (playground.failure) location.reload();
    else if (playground.ready) void playground.run().catch(playground.report);
  });
  return () => {
    const { failure, canRun } = handle.props.playground;
    if (failure) return <button id="run" type="button" title={RELOAD_TITLES[failure]} mix={click}>Reload</button>;
    return <button id="run" type="button" title={RUN_TITLE} disabled={!canRun} mix={click}>▶ Run</button>;
  };
}

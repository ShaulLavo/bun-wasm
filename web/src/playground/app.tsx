import { on, type Handle } from "@remix-run/component";
import { EditorPane } from "./editor-pane";
import type { Playground } from "./playground";
import { TerminalPane } from "./terminal-pane";
import { projectTemplates } from "./project-templates";
import { DemoBar } from "./demo-bar";
import { PreviewDock } from "./preview-dock";
import { copy } from "./showcase-copy";
import { engineUnavailable, type Engine } from "../engine-loader";

type Props = { playground: Playground };

const ENGINE_OPTIONS = Object.entries(copy.engineOptions) as [Engine, string][];
const RUN_TITLE = "Save and run (Ctrl/Cmd-Enter)";
const RELOAD_TITLES = { startup: "Retry playground startup", ownership: "Open the latest saved workspace", shell: RUN_TITLE };

function engineOption(engine: Engine, label: string, playground: Playground) {
  try {
    const unavailable = engineUnavailable(engine, playground.profileForEngine(engine));
    return { label: unavailable ? `${label} (not in this build)` : label, unavailable };
  } catch (error) { return { label: `${label} (unsupported profile)`, unavailable: String(error) }; }
}

export function App(handle: Handle<Props>) {
  const { playground } = handle.props;
  playground.addEventListener("change", () => void handle.update(), { signal: handle.signal });
  return () => (
    <>
      <Header playground={playground} />
      {playground.template ? null : <DemoBar playground={playground} />}
      <main>
        <EditorPane playground={playground} />
        <div class="output-column" data-preview={playground.dockedPreview ? "open" : undefined}>
          {playground.dockedPreview ? <PreviewDock key={playground.dockedPreview.key} playground={playground} /> : null}
          <TerminalPane playground={playground} />
        </div>
      </main>
    </>
  );
}

/** Opens a template workspace, keeping the chosen engine. */
function chooseProject(value: string): void {
  const next = new URL(location.href);
  next.searchParams.delete("demo");
  if (value) next.searchParams.set("template", value);
  else next.searchParams.delete("template");
  location.assign(next);
}

function Header(handle: Handle<Props>) {
  return () => {
    const { playground } = handle.props;
    const { status } = playground;
    return (
      <header>
        <h1><span class="logo" aria-hidden="true">🥟</span> bun<span class="dim">.wasm</span></h1>
        <span id="status" role="status" aria-live="polite" data-kind={status.kind}>{status.text}</span>
        <nav class="workspace-nav" aria-label="Projects">
          <a class="nav" href="../" title={copy.sandboxTitle}>{copy.sandboxLink}</a>
        </nav>
        <label class="field">
          <span class="label">{copy.projectLabel}</span>
          <select id="template" aria-label={copy.projectLabel} title={copy.projectTitle} disabled={playground.locked}
            mix={on("change", (event) => chooseProject(event.currentTarget.value))}
          >
            <option value="" selected={!playground.template}>{copy.examplesOption}</option>
            {projectTemplates.map(template => <option value={template.id} selected={template.id === playground.template?.id}>{template.label}</option>)}
          </select>
        </label>
        <label class="field">
          <span class="label">{copy.engineLabel}</span>
          <select
            id="engine" aria-label="JavaScript engine" title={copy.engineTitle}
            disabled={playground.locked}
            mix={on("change", (event) => playground.chooseEngine(event.currentTarget.value))}
          >
            {ENGINE_OPTIONS.map(([value, label]) => {
              const option = engineOption(value, label, playground);
              return <option value={value} selected={value === playground.engine}
                disabled={option.unavailable !== null} title={option.unavailable ?? undefined}
              >{option.label}</option>;
            })}
          </select>
        </label>
        {playground.unreadable ? <StartFreshButton playground={playground} /> : null}
        <RunButton playground={playground} />
      </header>
    );
  };
}

function StartFreshButton(handle: Handle<Props>) {
  const click = on<HTMLButtonElement>("click", () => {
    if (!confirm("Delete this browser's saved playground workspace and start a new one? Its files cannot be opened and will be lost.")) return;
    void handle.props.playground.startFresh();
  });
  return () => <button id="start-fresh" type="button" title="Delete the workspace that cannot be opened and start a new one" disabled={handle.props.playground.startingFresh} mix={click}>Start fresh</button>;
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

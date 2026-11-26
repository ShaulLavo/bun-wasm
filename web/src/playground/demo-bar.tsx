import { on, type Handle } from "@remix-run/component";
import { demos, type Demo } from "./demos";
import type { Playground } from "./playground";
import { copy } from "./showcase-copy";

type Props = { playground: Playground };

/** One-click Bun API demos, the engine that runs them, and the measured compatibility line. */
export function DemoBar(handle: Handle<Props>) {
  return () => {
    const { playground } = handle.props;
    const disabled = !playground.canStartDemo;
    return (
      <section class="demo-bar" aria-label={copy.demoBarAria}>
        <div class="demo-row">
          <span class="demo-label">{copy.demoBarLabel}</span>
          <ul class="demos">
            {demos.map(demo => (
              <li key={demo.id}>
                <DemoButton demo={demo} playground={playground} disabled={disabled} />
              </li>
            ))}
          </ul>
        </div>
        <p class="demo-meta">
          <span class="engine-note">{copy.engineNotes[playground.engine]}</span>
          <span class="compat" title={copy.compat.title}>
            {copy.compat.text}{" "}
            <a href={copy.compat.href} target="_blank" rel="noopener">{copy.compat.linkText}</a>
          </span>
        </p>
      </section>
    );
  };
}

function DemoButton(handle: Handle<{ demo: Demo; playground: Playground; disabled: boolean }>) {
  const click = on<HTMLButtonElement>("click", () => {
    const { demo, playground } = handle.props;
    void playground.runDemo(demo).catch(playground.report);
  });
  return () => {
    const { demo, playground, disabled } = handle.props;
    const active = playground.activeDemo?.id === demo.id;
    return (
      <button type="button" class="demo" data-demo={demo.id} title={demo.title}
        aria-pressed={active} disabled={disabled} mix={click}
      >{demo.label}</button>
    );
  };
}

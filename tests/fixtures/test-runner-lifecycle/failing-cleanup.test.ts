import { afterAll, onTestFinished, test } from "bun:test";

function registerCase(phase: string, bodyFails: boolean) {
  const label = `${phase}/${bodyFails ? "failing" : "successful"}`;
  test.failing(label, () => {
    const cleanup = async () => {
      console.log(`${label} cleanup`);
      throw new Error(`xfail cleanup ${label}`);
    };
    if (phase === "local") afterAll(cleanup);
    else onTestFinished(cleanup);
    if (bodyFails) throw new Error("expected body failure");
  });
}

for (const phase of ["local", "finished"]) {
  for (const bodyFails of [false, true]) registerCase(phase, bodyFails);
}

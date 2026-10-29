import assert from "node:assert/strict";
import type { Page } from "playwright";
import { ready, run, writeFile } from "./playground.mjs";
import { stopShell } from "./stop-shell";

export async function checkDelayedStop(page: Page, base: string, browser: string, engine: string): Promise<boolean> {
  await page.goto(`${base}?mode=memory&engine=${engine}`);
  assert.match(await ready(page), /ready/);
  await writeFile(page, "/home/user/forever.ts", 'const fs = require("node:fs"); process.on("SIGINT", () => { console.log("STOP_DELAYED"); setInterval(() => { if (fs.existsSync("/home/user/stop-release")) process.exit(130); }, 10); }); setInterval(() => {}, 1000); console.log("STOP_READY");');
  const done = page.evaluate(() => {
    const shell = Reflect.get(globalThis, "playground").shell;
    return shell.submit("bun run forever.ts").then(() => shell.lastExit);
  });
  await page.waitForFunction(() => {
    const buffer = Reflect.get(globalThis, "playground").term.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true)).join("\n").includes("STOP_READY");
  });
  const stopping = stopShell(page);
  await waitForMarker(page, "STOP_DELAYED");
  assert.equal(await page.evaluate(() => Reflect.get(globalThis, "playground").shell.running), true, "Ctrl-C waits for the guest's delayed shutdown");
  await writeFile(page, "/home/user/stop-release", "release");
  await stopping;
  const idle = await page.evaluate(() => !Reflect.get(globalThis, "playground").shell.running);
  const name = `${browser}/${engine}`;
  assert.equal(await done, 130);
  const result = await run(page, 'bun -e "console.log(42)"');
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trim(), "42");
  console.log(`${idle ? "ok" : "FAIL"} ${name} stop waits for delayed shutdown before the next command`);
  return idle;
}

async function waitForMarker(page: Page, marker: string): Promise<void> {
  await page.waitForFunction(value => {
    const buffer = Reflect.get(globalThis, "playground").term.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true)).join("\n").includes(value);
  }, marker);
}

export async function checkRootSignals(page: Page, base: string, browser: string, engine: string): Promise<void> {
  for (const mode of ["handled", "handled7", "default", "removed", "once"]) {
    await page.goto(`${base}?mode=memory&engine=${engine}`);
    assert.match(await ready(page), /ready/);
    await page.evaluate(async () => {
      const state = Reflect.get(globalThis, "playground");
      const supervisor = await (await state.runtime.processes()).ready();
      Reflect.set(globalThis, "shellSignalExits", []);
      supervisor.onChildExit((event: unknown) => Reflect.get(globalThis, "shellSignalExits").push(event));
    });
    const marker = `ROOT_${mode.toUpperCase()}_READY`;
    const handledStatus = mode === "handled7" ? 7 : 0;
    const source = mode === "once"
      ? 'process.once("SIGINT", () => console.log("ROOT_ONCE_HANDLED")); process.kill(process.pid, "SIGINT");'
      : mode === "default" ? ""
      : `const handler = () => { console.log("ROOT_HANDLED_EXIT${handledStatus}"); process.exit(${handledStatus}); }; process.on("SIGINT", handler);` +
        (mode === "removed" ? 'process.removeListener("SIGINT", handler);' : '');
    await writeFile(page, "/home/user/root-signal.ts", `${source} setInterval(() => {}, 1000); console.log(${JSON.stringify(marker)});`);
    const done = page.evaluate(() => {
      const shell = Reflect.get(globalThis, "playground").shell;
      return shell.submit("bun run root-signal.ts").then(() => shell.lastExit);
    });
    // This acknowledgement is emitted only after the real guest has installed/removed listeners.
    await waitForMarker(page, marker);
    if (mode === "once") {
      // The self-raised signal consumes the once listener before keyboard Ctrl-C.
      await waitForMarker(page, "ROOT_ONCE_HANDLED");
      assert.equal(await page.evaluate(() => Reflect.get(globalThis, "playground").shell.running), true, "self-raised INT is handled without default termination");
    }
    await stopShell(page);
    const code = await done;
    console.log(JSON.stringify({ signalDiagnostic: { browser, engine, mode, code, exits: await page.evaluate(() => Reflect.get(globalThis, "shellSignalExits")) } }));
    assert.equal(code, mode === "handled" || mode === "handled7" ? handledStatus : 130, `${browser}/${engine}/${mode}: guest-selected exit or restored default`);
    const next = await run(page, 'bun -e "console.log(42)"');
    assert.equal(next.code, 0, next.output);
    assert.equal(next.output.trim(), "42");
    console.log(`ok ${browser}/${engine} root ${mode}: Ctrl+C preserves handler exit and last-removal default`);
  }
}


export async function checkPipelineReader(page: Page, base: string, browser: string, engine: string): Promise<void> {
  await page.goto(`${base}?mode=memory&engine=${engine}`);
  assert.match(await ready(page), /ready/);
  await writeFile(page, "/home/user/pipe-left.ts", 'process.on("SIGINT", () => { console.error("PIPE_LEFT_EXIT0"); process.exit(0); }); setInterval(() => {}, 1000); console.error("PIPE_LEFT_READY");');
  await writeFile(page, "/home/user/pipe-right.ts", 'process.on("SIGINT", () => console.error("PIPE_RIGHT_HANDLED")); process.stdin.setEncoding("utf8"); let input = ""; process.stdin.on("data", data => { input += data; if (!input.includes(String.fromCharCode(10)) && !input.includes(String.fromCharCode(13))) return; console.log("PIPE_READER:" + input.trim()); process.exit(0); }); setInterval(() => {}, 1000); console.error("PIPE_RIGHT_READY");');
  await page.evaluate(async () => {
    const { runtime } = Reflect.get(globalThis, "playground");
    const supervisor = await (await runtime.processes()).ready();
    Reflect.set(globalThis, "pipelineChildExits", []);
    supervisor.onChildExit((event: unknown) => Reflect.get(globalThis, "pipelineChildExits").push(event));
  });
  const done = page.evaluate(() => {
    const { shell } = Reflect.get(globalThis, "playground");
    return shell.submit("exec 9<&0; bun run pipe-left.ts | bun run pipe-right.ts <&9").then(() => shell.lastExit);
  });
  void done.catch(() => {});
  await waitForMarker(page, "PIPE_LEFT_READY");
  await waitForMarker(page, "PIPE_RIGHT_READY");
  await page.click(".xterm");
  await page.keyboard.press("Control+c");
  await waitForMarker(page, "PIPE_LEFT_EXIT0");
  await waitForMarker(page, "PIPE_RIGHT_HANDLED");
  await page.waitForFunction(() => Reflect.get(globalThis, "pipelineChildExits").length === 1);
  assert.equal(await page.evaluate(() => Reflect.get(globalThis, "playground").shell.running), true, "Pipeline remains live after the first reader exits");
  await page.keyboard.type("reader-survived");
  await page.keyboard.press("Enter");
  await waitForMarker(page, "PIPE_READER:reader-survived");
  assert.equal(await done, 0, "Surviving pipeline reader receives keyboard input and exits normally");
  const next = await run(page, 'exec 9<&-; printf "PIPE_EDITOR_%s\\n" recovered');
  assert.equal(next.code, 0, next.output);
  assert.equal(next.output.trim(), "PIPE_EDITOR_recovered");
  console.log(JSON.stringify({ pipelineReader: { browser, engine, ok: true, exits: await page.evaluate(() => Reflect.get(globalThis, "pipelineChildExits")) } }));
}

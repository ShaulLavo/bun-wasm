import { expect, test } from "bun:test";
import { StartupOutput } from "../src/startup-output";

test("stdout streams incomplete lines and only buffers split startup records", () => {
  let text = "";
  const phases: string[] = [];
  const output = new StartupOutput((chunk) => { text += chunk; }, (line) => { phases.push(line); return true; });
  const write = (chunk: string) => output.write(new TextEncoder().encode(chunk));
  write("working…");
  expect(text).toBe("working…");
  write("\n[bunwasm:sta");
  expect(text).toBe("working…\n");
  write('rtup] {"phase":"bundling-react"}\nhello');
  expect(phases).toEqual(['{"phase":"bundling-react"}']);
  expect(text).toBe("working…\nhello");
  write("\n[bun");
  output.flush();
  expect(text).toBe("working…\nhello\n[bun");
});

test("unrecognized startup records remain ordinary output", () => {
  let text = "";
  const output = new StartupOutput((chunk) => { text += chunk; }, () => false);
  output.write(new TextEncoder().encode("[bunwasm:startup] nope\nnext line\n"));
  expect(text).toBe("[bunwasm:startup] nope\nnext line\n");
});

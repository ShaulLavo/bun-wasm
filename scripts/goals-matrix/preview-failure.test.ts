import { expect, test } from "bun:test";
import { frameworks } from "./catalog";
import { execute } from "./execute";
import { withPlayground } from "./test-fixture";

test.each([{ fail: false, unavailable: false }, { fail: true, unavailable: false }, { fail: true, unavailable: true }])("preview diagnostics survive failed terminal reads: %j", async ({ fail, unavailable }) => {
  const framework = frameworks.find(item => item.id === "angular");
  if (!framework) throw new Error("Angular fixture missing");
  await withPlayground(framework, 0, async transport => {
    let reads = 0;
    transport.previewFailure = async () => { reads++; return "retained preview failure"; };
    if (fail) transport.openPreview = async () => { throw new Error("Preview navigation failed"); };
    const evaluate = transport.evaluate.bind(transport);
    let transcripts = 0;
    transport.evaluate = (expression, admission, options) => {
      if (expression.includes("function transcript") && ++transcripts > 1 && unavailable) throw new Error("Terminal unavailable");
      return evaluate(expression, admission, options);
    };
    const logs: string[] = [];
    const result = await execute({ framework, box: { framework: "angular", browser: "chrome", engine: "browser" },
      url: "http://fixture/?engine=browser", timeoutMs: 500, startupTimeoutMs: 500, async createTransport() { return transport; }, async saveLog(text) { logs.push(text); } });
    expect(result.status).toBe(fail ? "fail" : "pass");
    expect(reads).toBe(fail ? 1 : 0);
    expect(logs.at(-1)?.includes("retained preview failure")).toBe(fail);
    expect(result.attempts[0]?.phases.at(-1)).toMatchObject({ phase: "cleanup", status: "pass" });
  });
});

test("saves preview evidence before cleanup when every later host evaluation fails", async () => {
  const framework = frameworks.find(item => item.id === "angular");
  if (!framework) throw new Error("Angular fixture missing");
  await withPlayground(framework, 0, async transport => {
    let hostUnavailable = false;
    const events: string[] = [];
    const evaluate = transport.evaluate.bind(transport);
    transport.openPreview = async () => { hostUnavailable = true; throw new Error("Preview navigation failed"); };
    transport.evaluate = (expression, admission, options) => {
      if (hostUnavailable) throw new Error("Host closed or unresponsive");
      return evaluate(expression, admission, options);
    };
    transport.previewFailure = async () => { events.push("preview"); return "retained independent preview evidence"; };
    const close = transport.close.bind(transport);
    transport.close = async () => { events.push("close"); await close(); };
    const logs: string[] = [];
    const result = await execute({ framework, box: { framework: "angular", browser: "chrome", engine: "browser" },
      url: "http://fixture/?engine=browser", timeoutMs: 500, startupTimeoutMs: 500, async createTransport() { return transport; },
      async saveLog(text) { events.push("save"); logs.push(text); } });
    expect(result.status).toBe("fail");
    expect(result.attempts[0]?.phases).toContainEqual(expect.objectContaining({ phase: "render", status: "fail" }));
    expect(result.attempts[0]?.phases.at(-1)).toMatchObject({ phase: "cleanup", status: "fail" });
    expect(events).toEqual(["preview", "save", "close"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Failure-time terminal observation unavailable");
    expect(logs[0]).toContain("Host closed or unresponsive");
    expect(logs[0]).toContain("retained independent preview evidence");
  });
});

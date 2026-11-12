import assert from "node:assert/strict";

export function productionTemplate(value: string | undefined) {
  if (value === undefined || value === "next") {
    return { id: "next", editorPath: "/home/user/pages/index.tsx", heading: "Next.js in your browser" } as const;
  }
  assert.equal(value, "next-app", "NEXT_PRODUCTION_TEMPLATE must be next or next-app");
  return { id: "next-app", editorPath: "/home/user/app/page.tsx", heading: "Next.js App Router" } as const;
}

function flightText(scripts: readonly string[]): string {
  const chunks: string[] = [];
  for (const script of scripts) {
    const body = script.trim();
    if (/^\(self\.__next_f=self\.__next_f\|\|\[\]\)\.push\(\[0\]\);?$/.test(body)) continue;
    const call = /^self\.__next_f\.push\((\[.*\])\);?$/.exec(body);
    if (!call) {
      assert.ok(!body.includes("__next_f"), "Unsupported Flight script body");
      continue;
    }
    const chunk: unknown = JSON.parse(call[1] ?? "null");
    assert.ok(Array.isArray(chunk));
    if (chunk[0] !== 1) continue;
    assert.ok(chunk.length === 2 && typeof chunk[1] === "string");
    chunks.push(chunk[1]);
  }
  return chunks.join("");
}

function jsonFlightRoot(text: string): unknown {
  let root: unknown;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const record = /^(0|[1-9a-f][0-9a-f]*):(.*)$/.exec(line);
    assert.ok(record, "Unsupported Flight record framing");
    const payload = record[2] ?? "";
    // This source-only fixture emits JSON and import records, never length-prefixed text or binary records.
    const value: unknown = JSON.parse(payload.startsWith("I") ? payload.slice(1) : payload);
    if (record[1] !== "0") continue;
    assert.equal(root, undefined, "Flight stream must not repeat its root record");
    root = value;
  }
  return root;
}

export function assertAppProductionBuildID(scripts: readonly string[], expectedBuildID: string): void {
  const data = jsonFlightRoot(flightText(scripts));
  assert.ok(data && typeof data === "object" && "b" in data, "App Router HTML must contain a streamed Flight root record");
  assert.equal(data.b, expectedBuildID, "Served Flight HTML must use the guest's production BUILD_ID");
}

type Teardown = {
  readTerminal(): Promise<string>;
  writeTerminal(text: string): void;
  stopForeground(): Promise<void>;
  close(): Promise<void>;
  readTimeoutMs?: number;
};

export function assertProductionBrowserEvents(events: readonly string[]): void {
  assert.deepEqual(events.filter(event => /^(?:playground|preview) (?:error|assert|pageerror|requestfailed):/.test(event)), []);
}

export async function finishProduction(options: Teardown): Promise<void> {
  const failures: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Production terminal read timed out")), options.readTimeoutMs ?? 5_000);
    });
    options.writeTerminal(await Promise.race([options.readTerminal(), expired]));
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timer);
  }
  try { await options.stopForeground(); } catch (error) { failures.push(error); }
  try { await options.close(); } catch (error) { failures.push(error); }
  if (failures.length > 0) throw failures[0];
}

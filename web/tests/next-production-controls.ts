import assert from "node:assert/strict";

export function productionTemplate(value: string | undefined) {
  if (value === undefined || value === "next") {
    return { id: "next", editorPath: "/home/user/pages/index.tsx", heading: "Next.js in your browser" } as const;
  }
  assert.equal(value, "next-app", "NEXT_PRODUCTION_TEMPLATE must be next or next-app");
  return { id: "next-app", editorPath: "/home/user/app/page.tsx", heading: "Next.js App Router" } as const;
}

export function assertAppProductionBuildID(scripts: readonly string[], expectedBuildID: string): void {
  const chunks: string[] = [];
  for (const script of scripts) {
    for (const match of script.matchAll(/self\.__next_f\.push\((\[1,"(?:\\.|[^"\\])*"\])\)/g)) {
      const chunk: unknown = JSON.parse(match[1] ?? "null");
      assert.ok(Array.isArray(chunk) && chunk[0] === 1 && typeof chunk[1] === "string");
      chunks.push(chunk[1]);
    }
  }
  const root = /^0:(.+)$/m.exec(chunks.join(""));
  assert.ok(root, "App Router HTML must contain a streamed Flight root record");
  const data: unknown = JSON.parse(root[1] ?? "null");
  assert.ok(data && typeof data === "object" && "b" in data);
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

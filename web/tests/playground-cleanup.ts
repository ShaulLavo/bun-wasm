import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
}

export async function cleanupPlayground(resources: {
  browsers: readonly { close(): Promise<void> }[];
  children: readonly ChildProcess[];
  scratch: string;
}): Promise<void> {
  const browsers = await Promise.allSettled(resources.browsers.map(browser => browser.close()));
  const children = await Promise.allSettled(resources.children.map(stopChild));
  const childFailures = children.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (childFailures.length) throw new AggregateError(childFailures, "Playground children did not stop");
  rmSync(resources.scratch, { recursive: true, force: true });
  const browserFailures = browsers.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (browserFailures.length) throw new AggregateError(browserFailures, "Playground browsers did not close");
}

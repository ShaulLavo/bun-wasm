import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { settleResources } from "./lifecycle";

function kill(child: ChildProcess) {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
  }
}
function stop(child: ChildProcess) {
  return new Promise<void>(resolve => { child.once("close", () => resolve()); kill(child); });
}

export class PreparationFlow {
  private reason: Error | undefined;
  private readonly children = new Set<ChildProcess>();
  get cancelled() { return this.reason !== undefined; }
  check() { if (this.reason) throw this.reason; }
  cancel(reason: Error) {
    this.reason ??= reason;
    for (const child of this.children) kill(child);
  }
  execute(command: string[], cwd: string, env = process.env) {
    this.check();
    const [program, ...args] = command;
    assert.ok(program);
    return new Promise<void>((resolve, reject) => {
      const child = spawn(program, args, { cwd, env, stdio: "inherit", detached: true });
      this.children.add(child);
      child.once("error", reject);
      child.once("close", code => this.complete(child, command, code, resolve, reject));
    });
  }
  private complete(child: ChildProcess, command: string[], code: number | null, resolve: () => void, reject: (error: Error) => void) {
    kill(child);
    this.children.delete(child);
    if (this.reason) reject(this.reason);
    else if (code === 0) resolve();
    else reject(new Error(`${command.join(" ")} exited ${code}`));
  }
  async run(main: () => Promise<void>, cleanup: () => Promise<void>) {
    try { await main(); this.check(); }
    finally { await settleResources([() => this.stop(), cleanup]); }
  }
  private async stop() {
    await Promise.all(Array.from(this.children, stop));
    assert.equal(this.children.size, 0, "Owned preparation processes stopped");
  }
}

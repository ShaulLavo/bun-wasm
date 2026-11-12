import { Wasi } from "waffle/core";
import { MemFS } from "waffle/fs/memory";
import { adoptLinkPlan, instantiateLinkPlan, type SharedLinkPlan } from "waffle/link";

export function linkedFixtureValue(shared: SharedLinkPlan | undefined): number {
  if (!shared) throw new Error("Fixture lost its shared link plan");
  const wasi = new Wasi({ args: [], env: {}, fs: new MemFS(), preopens: {}, stdout() {}, stderr() {}, sleep() {}, namespaces: { runtime_proc: { signal: () => 0 } } });
  const group = instantiateLinkPlan(adoptLinkPlan(shared), { wasi, checkActive() {} });
  try {
    group.initialize();
    const value = group.entry.exports.value;
    if (typeof value !== "function") throw new Error("Fixture value export missing");
    return value();
  } finally { group.dispose(); wasi.descriptors.dispose(); }
}

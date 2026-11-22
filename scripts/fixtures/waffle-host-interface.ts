import { join } from "node:path";
import { waffleRuntimeName, waffleRuntimePin } from "../waffle-release-inputs";
import release from "../waffle-release-inputs.json";

export async function writeInstalledWaffleFixture(root: string, selected = waffleRuntimePin) {
  const live = selected === waffleRuntimePin;
  const resolution = live ? `${waffleRuntimeName}@${release.version}` : `waffle@${selected}`;
  const packages: Record<string, unknown> = { waffle: [resolution, {}] };
  const names = ["waffle", "bash-web", "bun-wasm", "waffle-base", "waffle-coreutils", "@waffle/python", "waffle-relay"];
  for (const name of names) {
    const metadata = { name: name === "waffle" && live ? waffleRuntimeName : name, version: release.version, waffleHostInterface: release.hostInterface, ...(name === "waffle" ? {} : { peerDependencies: { waffle: "*" } }) };
    await Bun.write(join(root, "node_modules", name, "package.json"), JSON.stringify(metadata));
    if (name !== "waffle") packages[name] = [`${name}@https://example.invalid/${name}.tgz`, {}];
  }
  packages["isomorphic-git"] = ["isomorphic-git@git+https://example.invalid/third-party.git#" + "f".repeat(40), {}];
  const lock = { workspaces: { "": { dependencies: { waffle: selected } } }, packages };
  await Bun.write(join(root, "bun.lock"), JSON.stringify(lock));
  return { packages, lock };
}

import { expect } from "bun:test";
for (const [label, files, count] of [
  ["same-file snapshot lifetime", ["same-file.test.ts"], "3 pass"],
  ["cross-file snapshot lifetime", ["first.ts", "second.ts"], "8 pass"],
] as const) {
  const child = Bun.spawnSync([process.execPath, "test"].concat(files.map(file => import.meta.dir + "/" + file)), {
    env: { ...process.env, CI: "1" }, stdout: "pipe", stderr: "pipe",
  });
  const text = new TextDecoder().decode(child.stderr);
  if (child.exitCode !== 0) console.error(text);
  expect(child.exitCode).toBe(0);
  expect(text).toContain(count);
  console.log(label);
}

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lockedReleasePackages, stageReleasePackages, verifyStagedResolutions } from "./ci-stage-release-packages";

const url = "https://github.com/owner/project/releases/download/v1/input.tgz";
const bytes = Buffer.from("exact originally pinned bytes");
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const lock = (digest = integrity) => JSON.stringify({ packages: { example: [`example@${url}`, {}, digest], other: ["other@1.0.0", "", {}, "sha512-value"] } });

test("staged assets retain the entire locked URL and integrity identity", () => {
  expect(lockedReleasePackages(lock())).toEqual([{ name: "example", url, integrity }]);
  expect(() => lockedReleasePackages(lock(""))).toThrow("integrity");
});

test("staging verifies original bytes before publishing supported fixture-local overrides", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "bun-wasm-stage-packages-"));
  try {
    const manifest = JSON.stringify({ dependencies: { example: url } });
    await writeFile(join(fixture, "package.json"), manifest);
    await writeFile(join(fixture, "bun.lock"), lock());
    await expect(stageReleasePackages(fixture, fixture, async () => new Response("wrong bytes"))).rejects.toThrow("integrity mismatch");
    expect(await readFile(join(fixture, "package.json"), "utf8")).toBe(manifest);
    await stageReleasePackages(fixture, fixture, async input => { expect(input).toBe(url); return new Response(bytes); });
    const staged = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
    expect(staged.dependencies.example).toBe(url);
    expect(await readFile(staged.overrides.example)).toEqual(bytes);
    expect(await readFile(join(fixture, "bun.lock"), "utf8")).toBe(lock());
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("fixture lock resolution cannot change unrelated pinned packages", () => {
  expect(() => verifyStagedResolutions(lock(), lock())).not.toThrow();
  expect(() => verifyStagedResolutions(lock(), lock().replace("other@1.0.0", "other@2.0.0"))).toThrow("other");
});

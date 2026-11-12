import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { captureObjects, planObjects, pruneObjects } from "./ci-sccache-cache";

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-sccache-test-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function object(directory: string, character: string, contents = "compiled object"): Promise<string> {
  const hash = character.repeat(64);
  const path = join(directory, character, character, hash);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
  return path;
}

test("an absent cache captures an empty inventory and a new object learns an archive", async () => {
  await fixture(async directory => {
    const cache = join(directory, "objects");
    const snapshot = join(directory, "initial.json");
    expect(await captureObjects(cache, snapshot)).toEqual({ version: 1, objects: [] });
    expect(await planObjects(cache, snapshot)).toMatchObject({ changed: false, fits: true, bytes: 0 });
    await object(cache, "a");
    const plan = await planObjects(cache, snapshot);
    expect(plan.changed).toBe(true);
    expect(plan.fits).toBe(true);
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.bytes).toBeGreaterThan("compiled object".length);
  });
});

test("cache hits, access metadata and unrelated files do not learn a new archive", async () => {
  await fixture(async directory => {
    const cache = join(directory, "objects");
    const path = await object(cache, "b");
    const snapshot = join(directory, "initial.json");
    await captureObjects(cache, snapshot);
    const before = await planObjects(cache, snapshot);
    await utimes(path, new Date(1_000), new Date(2_000));
    await writeFile(join(cache, "metadata"), "new access statistics");
    await object(cache, "c");
    await rm(join(cache, "c"), { recursive: true });
    await writeFile(join(cache, "b", "b", "a".repeat(64)), "wrong shard");
    await symlink(path, join(cache, "object-link"));
    const after = await planObjects(cache, snapshot);
    expect(after.changed).toBe(false);
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.bytes).toBeGreaterThan(before.bytes);
  });
});

test("eviction alone does not save, while replaced and added object sizes do", async () => {
  await fixture(async directory => {
    const cache = join(directory, "objects");
    const first = await object(cache, "a");
    await object(cache, "b");
    const snapshot = join(directory, "initial.json");
    await captureObjects(cache, snapshot);
    await rm(first);
    expect((await planObjects(cache, snapshot)).changed).toBe(false);
    await object(cache, "b", "replacement has a new size");
    expect((await planObjects(cache, snapshot)).changed).toBe(true);
    await captureObjects(cache, snapshot);
    await object(cache, "c");
    expect((await planObjects(cache, snapshot)).changed).toBe(true);
  });
});

test("fingerprints ignore traversal order and cover all current object path and size facts", async () => {
  await fixture(async directory => {
    const cache = join(directory, "objects");
    const snapshot = join(directory, "initial.json");
    await object(cache, "c");
    await object(cache, "a");
    await captureObjects(cache, snapshot);
    const before = await planObjects(cache, snapshot);
    await rm(join(cache, "c"), { recursive: true });
    await object(cache, "c");
    expect((await planObjects(cache, snapshot)).fingerprint).toBe(before.fingerprint);
    await rm(join(cache, "a"), { recursive: true });
    const after = await planObjects(cache, snapshot);
    expect(after.changed).toBe(false);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});

test("the size cap includes unrelated files without reading sparse object contents", async () => {
  await fixture(async directory => {
    const cache = join(directory, "objects");
    const snapshot = join(directory, "initial.json");
    await captureObjects(cache, snapshot);
    const path = await object(cache, "a");
    await truncate(path, 603_979_777);
    expect(await planObjects(cache, snapshot)).toMatchObject({ changed: true, fits: false });
    await truncate(path, 1);
    const metadata = join(cache, "metadata");
    await writeFile(metadata, "");
    await truncate(metadata, 603_979_777);
    expect(await planObjects(cache, snapshot)).toMatchObject({ changed: true, fits: false });
  });
});

test("snapshot JSON is validated before planning", async () => {
  await fixture(async directory => {
    const snapshot = join(directory, "initial.json");
    const valid = { path: `a/a/${"a".repeat(64)}`, bytes: 1 };
    for (const invalid of [null, [], { version: 2, objects: [] }, { version: 1, objects: [{}] },
      { version: 1, objects: [{ ...valid, path: "../escape" }] }, { version: 1, objects: [{ ...valid, bytes: -1 }] },
      { version: 1, objects: [valid, valid] }]) {
      await writeFile(snapshot, JSON.stringify(invalid));
      await expect(planObjects(join(directory, "objects"), snapshot)).rejects.toThrow();
    }
  });
});

const dependency = "d".repeat(64);
function key(job = "rust", fingerprint = "a", os = "Linux", arch = "X64"): string {
  return `rust-objects-v3-${os}-${arch}-${job}-${dependency}-${fingerprint.repeat(64)}-12345-1`;
}

function entry(id: number, cacheKey: string, ref = "refs/heads/main") {
  return { id, key: cacheKey, ref, size_in_bytes: id * 100, created_at: new Date(id * 1_000).toISOString() };
}

const mainEnvironment = { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "owner/repository", GH_TOKEN: "fixture-token" };

function api(entries: unknown[], response?: unknown) {
  const requests: { url: string; method: string }[] = [];
  const request = async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    requests.push({ url, method });
    if (method === "DELETE") return new Response(null, { status: 204 });
    const page = Number(new URL(url).searchParams.get("page"));
    return Response.json(response ?? { total_count: entries.length, actions_caches: entries.slice((page - 1) * 100, page * 100) });
  };
  return { requests, request };
}

test.each(["rust", "rust-native-quality"])("pruning keeps the published %s snapshot and newest other snapshot only", async job => {
  const published = key(job, "f");
  const legacy = `rust-objects-v2-Linux-X64-${job}-${dependency}`;
  const entries = [entry(1, legacy), entry(2, key(job, "b")), entry(3, key(job, "c")), entry(4, published),
    entry(5, key(`${job}-other`)), entry(6, key(job, "a", "macOS")), entry(7, key(job, "a", "Linux", "ARM64")),
    entry(8, key(job), "refs/pull/1/merge"), entry(9, key(job), "refs/heads/feature"),
    entry(10, "rust-target-v3-Linux-X64-rust"), entry(11, `${key(job)}-junk`), entry(12, legacy.replace("v2", "v1"))];
  const mock = api(entries);
  const logs: string[] = [];
  const warnings: string[] = [];
  await pruneObjects(published, mainEnvironment, mock.request, message => logs.push(message), message => warnings.push(message));
  expect(warnings).toEqual([]);
  expect(mock.requests.filter(request => request.method === "DELETE").map(request => request.url)).toEqual([
    "https://api.github.com/repos/owner/repository/actions/caches/2",
  ]);
  expect(logs).toEqual([`Delete compiler-object snapshot id=2 key=${key(job, "b")} size=200`]);
});

test("a replacement absent from the listing preserves every archive", async () => {
  const mock = api([entry(1, key()), entry(2, key("rust", "b")), entry(3, key("rust", "c"))]);
  const warnings: string[] = [];
  await pruneObjects(key("rust", "f"), mainEnvironment, mock.request, () => {}, message => warnings.push(message));
  expect(mock.requests.every(request => request.method === "GET")).toBe(true);
  expect(warnings).toHaveLength(1);
});

test("all pages are validated before cleanup begins", async () => {
  const entries = Array.from({ length: 101 }, (_, index) => entry(index + 1, key("rust", "a")));
  const mock = api(entries);
  await pruneObjects(key(), mainEnvironment, mock.request, () => {}, () => {});
  expect(mock.requests.slice(0, 2).map(request => request.method)).toEqual(["GET", "GET"]);
  expect(mock.requests.filter(request => request.method === "DELETE")).toHaveLength(100);
  const calls: string[] = [];
  const request = async (_url: string, init: RequestInit) => {
    calls.push(init.method ?? "GET");
    return Response.json(calls.length === 1 ? { total_count: 101, actions_caches: entries.slice(0, 100) } : { total_count: 101, actions_caches: [{}] });
  };
  await pruneObjects(key(), mainEnvironment, request, () => {}, () => {});
  expect(calls).toEqual(["GET", "GET"]);
});

test("network errors are warning-only and request time is bounded", async () => {
  const warnings: string[] = [];
  const request = async (_url: string, init: RequestInit): Promise<Response> => {
    expect(init.signal).toBeInstanceOf(AbortSignal);
    throw new Error("fixture network failure");
  };
  await expect(pruneObjects(key(), mainEnvironment, request, () => {}, message => warnings.push(message))).resolves.toBeUndefined();
  expect(warnings).toHaveLength(1);
});

test("capture and plan CLI write the save decision to GITHUB_OUTPUT", async () => {
  await fixture(async directory => {
    const cache = join(directory, "objects");
    const snapshot = join(directory, "initial.json");
    const output = join(directory, "outputs");
    const script = new URL("./ci-sccache-cache.ts", import.meta.url).pathname;
    const capture = spawnSync(process.execPath, [script, "capture", cache, snapshot], { encoding: "utf8" });
    expect(capture.status, capture.stderr).toBe(0);
    await object(cache, "a");
    const plan = spawnSync(process.execPath, [script, "plan", cache, snapshot], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } });
    expect(plan.status, plan.stderr).toBe(0);
    expect(await readFile(output, "utf8")).toMatch(/^changed=true\nfits=true\nfingerprint=[a-f0-9]{64}\n$/);
    const refused = spawnSync(process.execPath, [script, "prune", key()], { encoding: "utf8", env: { ...mainEnvironment, GITHUB_EVENT_NAME: "pull_request" } });
    expect(refused.status).toBe(0);
    expect(refused.stderr).toContain("restricted to main pushes");
  });
});

test("a published key on a PR ref cannot authorize deletion of main snapshots", async () => {
  const published = key("rust", "f");
  const mock = api([entry(1, key()), entry(2, key("rust", "b")), entry(3, published, "refs/pull/1/merge")]);
  await pruneObjects(published, mainEnvironment, mock.request, () => {}, () => {});
  expect(mock.requests).toHaveLength(1);
});

test.each(["pull_request", "pull_request_target", "workflow_dispatch"])("%s cleanup refuses before any network access", async event => {
  const mock = api([]);
  await pruneObjects(key(), { ...mainEnvironment, GITHUB_EVENT_NAME: event }, mock.request, () => {}, () => {});
  expect(mock.requests).toEqual([]);
});

test("feature branch pushes and malformed published keys refuse before network access", async () => {
  const mock = api([]);
  await pruneObjects(key(), { ...mainEnvironment, GITHUB_REF: "refs/heads/feature" }, mock.request, () => {}, () => {});
  await pruneObjects(`rust-objects-v2-Linux-X64-rust-${dependency}`, mainEnvironment, mock.request, () => {}, () => {});
  await pruneObjects(`${key()}-junk`, mainEnvironment, mock.request, () => {}, () => {});
  await pruneObjects(key().replace(/-12345-1$/, ""), mainEnvironment, mock.request, () => {}, () => {});
  expect(mock.requests).toEqual([]);
});

test.each([[], { total_count: -1, actions_caches: [] }, { total_count: 1001, actions_caches: [] },
  { total_count: 3, actions_caches: [entry(1, key())] }, { total_count: 1, actions_caches: [{ ...entry(1, key()), size_in_bytes: "100" }] },
  { total_count: 1, actions_caches: [{ ...entry(1, key()), created_at: "invalid" }] },
  { total_count: 2, actions_caches: [entry(1, key()), entry(1, key("rust", "b"))] },
])("malformed or unbounded API data preserves every snapshot: %#", async response => {
  const mock = api([], response);
  const warnings: string[] = [];
  await pruneObjects(key(), mainEnvironment, mock.request, () => {}, message => warnings.push(message));
  expect(mock.requests).toHaveLength(1);
  expect(mock.requests[0]?.method).toBe("GET");
  expect(warnings).toHaveLength(1);
});

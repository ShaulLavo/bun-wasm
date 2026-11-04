import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Runtime } from "waffle";

const execFile = promisify(execFileCallback);
export type PromptRepositoryFixture = {
  readonly step: string;
  readonly pattern: RegExp;
  readonly files: readonly { readonly path: string; readonly bytes: readonly number[] }[];
};

/** Native Git only prepares input bytes. No command here executes in the guest. */
export async function promptRepositoryFixtures(): Promise<PromptRepositoryFixture[]> {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-prompt-fixture-"));
  try { return await collectRepositoryStates(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execFile("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0"].concat(args), {
    cwd: root,
    env: {
      PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Prompt fixture", GIT_AUTHOR_EMAIL: "prompt@example.invalid",
      GIT_COMMITTER_NAME: "Prompt fixture", GIT_COMMITTER_EMAIL: "prompt@example.invalid",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  });
  return result.stdout.trim();
}

async function repositoryFiles(root: string): Promise<PromptRepositoryFixture["files"]> {
  const files: { path: string; bytes: number[] }[] = [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name).slice(root.length + 1);
    files.push({ path, bytes: Array.from(await readFile(join(root, path))) });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectRepositoryStates(root: string): Promise<PromptRepositoryFixture[]> {
  await git(root, "init", "--object-format=sha1", "--initial-branch=main", "--template=");
  await git(root, "config", "index.version", "2");
  await writeFile(join(root, "tracked.txt"), "base");
  await writeFile(join(root, "bun.lock"), "{}");
  await git(root, "add", "tracked.txt", "bun.lock");
  await git(root, "commit", "-m", "base");
  const head = await git(root, "rev-parse", "HEAD");
  const states: PromptRepositoryFixture[] = [];
  const record = async (step: string, pattern: RegExp) => {
    states.push({ step, pattern, files: await repositoryFiles(root) });
  };
  await record("branch", /on .*main/);
  await git(root, "checkout", "--detach");
  await record("detached", /\([0-9a-f]{7}\)/);
  await git(root, "checkout", "main");
  await writeFile(join(root, "tracked.txt"), "modified tracked contents for the pending-read control");
  await record("modified", /\[[^\]]*!/);
  await rm(join(root, "tracked.txt"));
  await record("deleted", /\[[^\]]*✘/);
  await git(root, "checkout", "--", "tracked.txt");
  await writeFile(join(root, "untracked.txt"), "new");
  await record("untracked", /\[[^\]]*\?/);
  await git(root, "add", "untracked.txt");
  await record("staged", /\[[^\]]*\+/);
  await git(root, "stash", "push");
  await record("stash", /\[[^\]]*\$/);
  await git(root, "branch", "prompt-upstream");
  await git(root, "config", "branch.main.remote", ".");
  await git(root, "config", "branch.main.merge", "refs/heads/prompt-upstream");
  await writeFile(join(root, "ahead.txt"), "ahead");
  await git(root, "add", "ahead.txt");
  await git(root, "commit", "-m", "ahead");
  await record("ahead", /⇡/);
  await git(root, "branch", "-f", "prompt-upstream", "HEAD");
  await git(root, "reset", "--hard", "HEAD~1");
  await record("behind", /⇣/);
  await writeFile(join(root, "diverged.txt"), "diverged");
  await git(root, "add", "diverged.txt");
  await git(root, "commit", "-m", "diverged");
  await record("diverged", /⇕/);
  await git(root, "config", "branch.main.merge", "refs/heads/prompt-missing");
  await record("missing upstream", /…/);
  await git(root, "config", "--unset", "branch.main.remote");
  await git(root, "config", "--unset", "branch.main.merge");
  await writeFile(join(root, ".git/MERGE_HEAD"), head);
  await record("merging", /MERGING/);
  await rm(join(root, ".git/MERGE_HEAD"));
  await writeFile(join(root, ".git/index"), "corrupt index provider-state fixture");
  await record("corrupt index", /…/);
  return states;
}

/** Self-contained for page.evaluate; imports metadata, never replaces the provider or readFile. */
export async function importPromptRepository(
  filesystem: Pick<Runtime["filesystem"], "mkdirp" | "writeFile">,
  root: string,
  files: PromptRepositoryFixture["files"],
): Promise<void> {
  for (const file of files) {
    const path = `${root}/${file.path}`;
    await filesystem.mkdirp(path.slice(0, path.lastIndexOf("/")));
    await filesystem.writeFile(path, new Uint8Array(file.bytes));
  }
}

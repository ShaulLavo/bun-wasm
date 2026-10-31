import { execFileSync } from "node:child_process";

const fullCommit = /^[0-9a-f]{40}$/;
const zeroCommit = "0".repeat(40);

type CiEvent = "pull_request" | "push" | "workflow_dispatch";

export interface ComparisonRefInput {
  cwd: string;
  eventBase: string;
  eventHead: string;
  eventName: CiEvent;
  githubSha: string;
}

export interface ComparisonRefs {
  base: string;
  eventBaseMismatch: boolean;
  head: string;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function requiredField(fields: readonly string[], index: number, name: string): string {
  const field = fields[index];
  if (!field) throw new Error(`Missing ${name} in Git output`);
  return field;
}

function requireCommitObject(value: string, name: string, cwd: string): string {
  if (!fullCommit.test(value)) throw new Error(`${name} must be a full commit ID: ${value}`);
  let resolved: string;
  try {
    resolved = git(cwd, ["rev-parse", "--verify", `${value}^{commit}`]);
  } catch {
    throw new Error(`Missing commit object for ${name}: ${value}`);
  }
  if (resolved !== value)
    throw new Error(`${name} does not resolve to itself: ${value} -> ${resolved}`);
  return value;
}

function requirePushBase(value: string, cwd: string): string {
  if (value === zeroCommit) return value;
  return requireCommitObject(value, "push event before", cwd);
}

function mergeParents(cwd: string, checkoutHead: string): readonly [string, string] {
  const fields = git(cwd, ["rev-list", "--parents", "-n", "1", checkoutHead]).split(/\s+/);
  if (fields.length !== 3)
    throw new Error(
      `pull_request checkout must have exactly two merge parents; got ${Math.max(fields.length - 1, 0)}`,
    );

  const listedHead = requireCommitObject(
    requiredField(fields, 0, "checkout commit"),
    "checkout commit",
    cwd,
  );
  if (listedHead !== checkoutHead)
    throw new Error(`Git parent listing changed checkout HEAD: ${listedHead} != ${checkoutHead}`);

  const base = requireCommitObject(
    requiredField(fields, 1, "merge parent 1"),
    "merge parent 1",
    cwd,
  );
  const head = requireCommitObject(
    requiredField(fields, 2, "merge parent 2"),
    "merge parent 2",
    cwd,
  );
  return [base, head];
}

export function resolveComparisonRefs(input: ComparisonRefInput): ComparisonRefs {
  const githubSha = requireCommitObject(input.githubSha, "GITHUB_SHA", input.cwd);
  const checkoutHead = requireCommitObject(
    git(input.cwd, ["rev-parse", "--verify", "HEAD"]),
    "checkout HEAD",
    input.cwd,
  );
  if (checkoutHead !== githubSha)
    throw new Error(`checkout HEAD ${checkoutHead} does not equal GITHUB_SHA ${githubSha}`);

  if (input.eventName === "workflow_dispatch") {
    const main = git(input.cwd, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
    const base = requireCommitObject(
      git(input.cwd, ["merge-base", main, checkoutHead]),
      "dispatch merge base",
      input.cwd,
    );
    return { base, eventBaseMismatch: false, head: checkoutHead };
  }

  if (input.eventName === "push") {
    const base = requirePushBase(input.eventBase, input.cwd);
    const head = requireCommitObject(input.eventHead, "push event head", input.cwd);
    if (head !== githubSha)
      throw new Error(`push event head ${head} does not equal GITHUB_SHA ${githubSha}`);
    return { base, eventBaseMismatch: false, head };
  }

  const eventBase = requireCommitObject(input.eventBase, "pull_request event base", input.cwd);
  const eventHead = requireCommitObject(input.eventHead, "pull_request event head", input.cwd);
  const [base, head] = mergeParents(input.cwd, checkoutHead);
  if (eventHead !== head)
    throw new Error(`pull_request event HEAD ${eventHead} does not equal merge parent 2 ${head}`);
  return { base, eventBaseMismatch: eventBase !== base, head };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

if (import.meta.main) {
  const eventName = requiredEnv("GITHUB_EVENT_NAME");
  if (eventName !== "pull_request" && eventName !== "push" && eventName !== "workflow_dispatch")
    throw new Error(`Unsupported GitHub event: ${eventName}`);
  const refs = resolveComparisonRefs({
    cwd: process.cwd(),
    eventBase: eventName === "workflow_dispatch" ? "" : requiredEnv("EVENT_BASE"),
    eventHead: requiredEnv("EVENT_HEAD"),
    eventName,
    githubSha: requiredEnv("GITHUB_SHA"),
  });
  if (refs.eventBaseMismatch) {
    console.error(
      `[ci-refs] pull_request event BASE differs from merge parent 1; using verified parent 1 ${refs.base}`,
    );
  }
  console.log(
    `base=${refs.base}\nhead=${refs.head}\nevent_base_mismatch=${refs.eventBaseMismatch}`,
  );
}

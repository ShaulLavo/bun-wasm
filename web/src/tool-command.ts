// Mirrors crates/bunwasm-cli/src/tool_args.rs: whether `bun <args>` runs in bun-tools.wasm.

const toolWords = new Set(["lint", "fmt", "check"]);
/** Bun's long flags whose value is the next argument (upstream `AUTO_PARAMS`). */
const longWithValue = new Set(["--breakpoint-resolve", "--conditions", "--console-depth", "--cpu-prof-dir", "--cpu-prof-interval",
  "--cpu-prof-name", "--cron-period", "--cron-title", "--define", "--disable-warning", "--dns-result-order", "--drop", "--elide-lines",
  "--env-file", "--extension-order", "--feature", "--fetch-preconnect", "--filter", "--heap-prof-dir", "--heap-prof-interval",
  "--heap-prof-name", "--import", "--install", "--jsx-factory", "--jsx-fragment", "--jsx-import-source", "--jsx-runtime", "--loader",
  "--main-fields", "--max-http-header-size", "--origin", "--port", "--preload", "--redirect-warnings", "--require", "--shell",
  "--stack-trace-limit", "--title", "--trace-event-categories", "--trace-event-file-pattern", "--tsconfig-override",
  "--unhandled-rejections", "--user-agent", "--watch-kill-signal"]);
const shortWithValue = "deFlpru";
const shortWithoutValue = "bhv";

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

function optionArgument(env: string, start: number): [string, number] {
  let j = start;
  while (j < env.length && !isWhitespace(env[j]!) && env[j] !== "=") j++;
  const endOfFlag = j;
  const foundEquals = j < env.length && env[j] === "=";
  if (foundEquals) j++;
  while (!foundEquals && j < env.length && isWhitespace(env[j]!)) j++;
  if (j < env.length && (env[j] === "'" || env[j] === "\"")) {
    const quote = env[j++];
    while (j < env.length && env[j] !== quote) j++;
    j = Math.min(j + 1, env.length);
  } else if (foundEquals) {
    while (j < env.length && !isWhitespace(env[j]!)) j++;
  } else {
    j = endOfFlag;
  }
  return [env.slice(start, j), j];
}

function plainArgument(env: string, start: number): [string, number] {
  let out = "";
  let quote = "";
  let escape = false;
  let i = start;
  while (i < env.length) {
    const ch = env[i]!;
    if (!escape && !quote && isWhitespace(ch)) break;
    i++;
    if (escape) { out += ch; escape = false; }
    else if (ch === "\\") escape = true;
    else if (quote === ch) quote = "";
    else if (!quote && (ch === "'" || ch === "\"")) quote = ch;
    else out += ch;
  }
  return [out, i];
}

/** Splits `BUN_OPTIONS` the way Bun's `append_options_env` and `tool_args::bun_options` do. */
function bunOptions(env: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < env.length) {
    if (isWhitespace(env[i]!)) { i++; continue; }
    const [arg, end] = env.startsWith("--", i) ? optionArgument(env, i) : plainArgument(env, i);
    args.push(arg);
    i = end;
  }
  return args;
}

/** `node` and `nodejs` run files and have no subcommands. */
function isNodeExecutable(executable: string): boolean {
  const name = (executable.split("/").pop() ?? executable).replace(/\.wasm$/, "");
  return name === "node" || name === "nodejs";
}

/** The letter of a chain of Bun's short flags that takes a value, and whether the value is the next argument. */
function shortValue(flag: string): { letter: string; next: boolean } | undefined {
  if (!flag.startsWith("-") || flag.startsWith("--") || flag.length < 2) return undefined;
  for (let at = 1; at < flag.length; at++) {
    const letter = flag[at]!;
    if (shortWithValue.includes(letter)) return { letter, next: at + 1 === flag.length };
    if (!shortWithoutValue.includes(letter)) return undefined;
  }
  return undefined;
}

function evaluates(flag: string): boolean {
  const name = flag.split("=", 1)[0];
  const letter = shortValue(flag)?.letter;
  return name === "--eval" || name === "--print" || letter === "e" || letter === "p";
}

function isWorkspaceScopeFlag(flag: string): boolean {
  const name = flag.split("=", 1)[0];
  return name === "--filter" || name === "--workspaces" || name === "--parallel" || name === "--sequential" || shortValue(flag)?.letter === "F";
}

/** `args` follows the executable; `executable` is argv[0]; `bunOptionsEnv` is `BUN_OPTIONS`. */
export function isToolCommand(args: readonly string[], executable = "bun", bunOptionsEnv?: string): boolean {
  if (isNodeExecutable(executable)) return false;
  const effective = bunOptionsEnv ? bunOptions(bunOptionsEnv).concat(args) : args;
  for (let at = 0; at < effective.length; at++) {
    const arg = effective[at]!;
    if (toolWords.has(arg)) return true;
    // What follows `--` is the command or the file to run, even if it looks like a flag.
    if (arg === "--") return toolWords.has(effective[at + 1] ?? "");
    // `bun -` runs standard input: `bun - check` passes it `check`.
    if (arg === "-") return false;
    // `bun -ptsconfig.json check`: before `check`, `-p` is its `--project`, as upstream.
    if (effective[at + 1] === "check" && shortValue(arg)?.letter === "p") continue;
    if (arg === "--cwd") { at++; continue; }
    if (["-v", "--version", "--revision"].includes(arg) || evaluates(arg) || isWorkspaceScopeFlag(arg)) return false;
    if (longWithValue.has(arg) || shortValue(arg)?.next) { at++; continue; }
    if (!arg.startsWith("-")) return false;
  }
  return false;
}

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

/** `args` follows the executable; `executable` is argv[0]. */
export function isToolCommand(args: readonly string[], executable = "bun"): boolean {
  if (isNodeExecutable(executable)) return false;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (toolWords.has(arg)) return true;
    // What follows `--` is the command or the file to run, even if it looks like a flag.
    if (arg === "--") return toolWords.has(args[at + 1] ?? "");
    // `bun -` runs standard input: `bun - check` passes it `check`.
    if (arg === "-") return false;
    // `bun -ptsconfig.json check`: before `check`, `-p` is its `--project`, as upstream.
    if (args[at + 1] === "check" && shortValue(arg)?.letter === "p") continue;
    if (arg === "--cwd") { at++; continue; }
    if (["-v", "--version", "--revision"].includes(arg) || evaluates(arg)) return false;
    if (longWithValue.has(arg) || shortValue(arg)?.next) { at++; continue; }
    if (!arg.startsWith("-")) return false;
  }
  return false;
}

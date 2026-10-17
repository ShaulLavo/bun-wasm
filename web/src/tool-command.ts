export function isToolCommand(args: readonly string[]): boolean {
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "lint" || arg === "fmt") return true;
    if (arg === "--cwd") { at++; continue; }
    if (["-e", "--eval", "-p", "--print", "-v", "--version", "--revision"].includes(arg)) return false;
    if (!arg.startsWith("-")) return false;
  }
  return false;
}

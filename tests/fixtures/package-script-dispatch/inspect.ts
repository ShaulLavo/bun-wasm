import { dirname, join } from "node:path";
const prefixes = [join(process.cwd(), "node_modules", ".bin"), join(dirname(process.cwd()), "node_modules", ".bin")];
console.log(process.env.npm_lifecycle_event, process.argv.slice(2).join("|"), process.env.MODE, process.env.MARK, prefixes.every(prefix => process.env.PATH!.includes(prefix)));

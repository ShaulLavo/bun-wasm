import { readFileSync } from "node:fs";

console.log(process.env.EXEC_MARK, process.argv[2], readFileSync("/root.txt", "utf8").trim());
process.exit(17);

// Real npm packages (vendored, unmodified): CJS, ESM, `exports` maps.
import ms from "ms";
import semver from "semver";
import pc from "picocolors";
import { nanoid, customAlphabet } from "nanoid";
import { Command } from "commander";

console.log("ms:", ms("2 days"), ms(90000), ms(ms("10h"), { long: true }));
console.log("semver:", semver.satisfies("1.2.3", "^1.0.0"), semver.inc("1.2.3", "minor"), semver.sort(["1.10.0", "1.2.0", "1.9.9"]).join(" "));
console.log("picocolors:", pc.isColorSupported, JSON.stringify(pc.createColors(true).red("x")));
console.log("nanoid:", nanoid().length, /^[0-5]{8}$/.test(customAlphabet("012345", 8)()));
const program = new Command().name("tool").option("-d, --debug", "debug").argument("<file>").exitOverride();
program.parse(["node", "tool", "-d", "input.txt"]);
console.log("commander:", program.opts().debug, program.args.join(","));
console.log(program.helpInformation().split("\n")[0]);

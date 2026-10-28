// The receipt for bash-web's shell and env guests that scripts/build-bash-web-shell.sh produces:
// the bash-web commit they were built from and each file's size and SHA-256. Browser builds ship the
// guests only when the receipt matches the consumer's bash-web pin and the bytes on disk.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RECEIPT = "bash-web-guests.json";
/** Program name the browser serves (programs/<name>) → the file in dist. */
const GUESTS = { "shell-engine.wasm": "bash-web-shell.wasm", "env.wasm": "bash-web-env.wasm" } as const;
type Program = keyof typeof GUESTS;

interface Receipt {
  bashWeb: string;
  rustToolchain: string;
  guests: Record<Program, { file: string; bytes: number; sha256: string }>;
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function describe(dist: string, program: Program) {
  const file = GUESTS[program];
  const bytes = readFileSync(join(dist, file));
  return { file, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function writeReceipt(dist: string, bashWeb: string, rustToolchain: string): Receipt {
  const guests = Object.fromEntries(Object.keys(GUESTS).map(program => [program, describe(dist, program as Program)])) as Receipt["guests"];
  const receipt: Receipt = { bashWeb, rustToolchain, guests };
  writeFileSync(join(dist, RECEIPT), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}

/** The bash-web commit a consumer's package.json pins (`git+…bash-web.git#<commit>`). */
export function pinnedBashWeb(consumer: string): string {
  const manifest = JSON.parse(readFileSync(join(consumer, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const commit = /#([0-9a-f]{40})$/.exec(manifest.dependencies?.["bash-web"] ?? "")?.[1];
  if (!commit) throw new Error(`${consumer}/package.json does not pin bash-web to a full commit`);
  return commit;
}

/**
 * The guests to ship, checked against the receipt and the pin. Undefined when dist holds none of
 * them; a partial, stale or modified set is an error, never a silent substitute.
 */
export function verifiedGuests(dist: string, bashWeb: string): { program: Program; path: string }[] | undefined {
  const receiptPath = join(dist, RECEIPT);
  const present = Object.values(GUESTS).filter(file => existsSync(join(dist, file)));
  if (!present.length && !existsSync(receiptPath)) return undefined;
  if (!existsSync(receiptPath)) throw new Error(`${dist} has bash-web guests but no ${RECEIPT}; rebuild them with scripts/build-bash-web-shell.sh`);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Receipt;
  if (receipt.bashWeb !== bashWeb) throw new Error(`bash-web guests in ${dist} were built from ${receipt.bashWeb}, but the consumer pins ${bashWeb}; run scripts/build-bash-web-shell.sh`);
  return (Object.keys(GUESTS) as Program[]).map(program => {
    const expected = receipt.guests[program];
    const path = join(dist, GUESTS[program]);
    if (!expected || !existsSync(path) || sha256(path) !== expected.sha256) throw new Error(`${path} does not match ${RECEIPT}; run scripts/build-bash-web-shell.sh`);
    return { program, path };
  });
}

if (import.meta.main) {
  const [command, dist, bashWeb, rustToolchain] = process.argv.slice(2);
  if (command !== "write" || !dist || !bashWeb || !rustToolchain) throw new Error("usage: bash-web-guests.ts write <dist> <bash-web commit> <rust toolchain>");
  for (const [program, guest] of Object.entries(writeReceipt(dist, bashWeb, rustToolchain).guests))
    console.log(`dist/${guest.file} (programs/${program}): ${guest.bytes} bytes, sha256 ${guest.sha256} (bash-web ${bashWeb})`);
}

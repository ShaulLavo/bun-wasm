// Orchestration control only. This file never substitutes for the live runtime check.
import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const [guest, flag, source] = process.argv.slice(2);
if (!guest || flag !== "-e" || !source) throw new Error("Unexpected legacy CLI arguments");
const directory = dirname(dirname(guest));
const address = process.env.TEST_SERVER;
if (!address || !address.startsWith("http://127.0.0.1:")) throw new Error("Missing loopback server");
const response = await fetch(`${address}/text`);
if (await response.text() !== "hello from the test server") throw new Error("Wrong server response");
appendFileSync(join(directory, "rows.jsonl"), JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), slots: process.env.SLOTS, server: address }) + "\n");
if (existsSync(join(directory, "hang"))) await new Promise(() => { setInterval(() => {}, 1000); });
writeSync(1, `ok ${source}`);
writeSync(2, "stderr\n");
const failure = join(directory, "fail-exit");
if (existsSync(failure) && readFileSync(failure, "utf8") === `${source.trim()}/${process.env.SLOTS}`) process.exitCode = 9;

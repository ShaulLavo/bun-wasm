// Bun.file, Bun.write, Bun.stdin, Bun.spawn and Bun.$ as a Bun author tries them first
// (docs/bun-api-probe.md). Each check prints one line.
import { $ } from "bun";

async function check(name: string, body: () => unknown): Promise<void> {
  try {
    const value = await body();
    console.log(`ok ${name}${value === undefined ? "" : ": " + (typeof value === "string" ? value : Bun.inspect(value))}`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
}

await check("Bun.stdin.text", async () => (await Bun.stdin.text()).trim());
await check("Bun.write + Bun.file", async () => {
  const bytes = await Bun.write("out/hello.txt", "hello bun");
  const file = Bun.file("out/hello.txt");
  return [bytes, await file.exists(), file.size, file.type, await file.text()];
});
await check("Bun.file json/bytes/arrayBuffer", async () => {
  await Bun.write("out/data.json", JSON.stringify({ list: [1, 2] }));
  const file = Bun.file("out/data.json");
  return [await file.json(), (await file.bytes()).length, (await file.arrayBuffer()).byteLength, file.type];
});
await check("Bun.file stream", async () => {
  const chunks: number[] = [];
  for await (const chunk of Bun.file("out/hello.txt").stream()) chunks.push(chunk.length);
  return chunks.reduce((a, b) => a + b, 0);
});
await check("Bun.file slice", () => Bun.file("out/hello.txt").slice(6).text());
await check("Bun.file writer", async () => {
  const writer = Bun.file("out/writer.txt").writer();
  writer.write("a");
  writer.write("b");
  await writer.end();
  return Bun.file("out/writer.txt").text();
});
await check("Bun.write Response + copy", async () => {
  await Bun.write("out/response.txt", new Response("from response"));
  await Bun.write("out/copy.txt", Bun.file("out/response.txt"));
  return Bun.file("out/copy.txt").text();
});
await check("Bun.file delete + missing", async () => {
  await Bun.file("out/copy.txt").delete();
  const missing = Bun.file("out/copy.txt");
  try {
    await missing.text();
  } catch (error) {
    return [await missing.exists(), (error as { code?: string }).code];
  }
  throw new Error("missing file read did not throw");
});
// Bun.write(Bun.stdout, ...) is left out: native Bun truncates a redirected stdout file and pads it with NULs.
await check("Bun.stdout writer", () => {
  const writer = Bun.stdout.writer();
  writer.write("");
  return typeof writer.flush;
});
await check("Bun.spawn bun child", async () => {
  const child = Bun.spawn([process.execPath, "-e", "console.log('child', 1 + 1)"], { stdout: "pipe" });
  return [(await new Response(child.stdout).text()).trim(), await child.exited];
});
await check("Bun.spawnSync", () => {
  const result = Bun.spawnSync([process.execPath, "-e", "process.stderr.write('err'); process.exit(3)"]);
  return [result.exitCode, result.stderr.toString(), result.success];
});
await check("Bun.spawn stdin pipe", async () => {
  const child = Bun.spawn([process.execPath, "-e", "process.stdin.pipe(process.stdout)"], { stdin: "pipe", stdout: "pipe" });
  child.stdin.write("piped through child");
  child.stdin.end();
  return (await new Response(child.stdout).text()).trim();
});
await check("$ echo text", async () => (await $`echo hello from shell`.text()).trim());
await check("$ interpolation", async () => {
  const name = "it's a $test";
  return (await $`echo ${name}`.text()).trim();
});
// Only commands both Bun's shell and bash-web run without coreutils (the native launcher has none):
// echo, pwd, cd, exit, true, false and bun. The playground runner checks ls, mkdir, rm and friends
// (scripts/bun-api-probe.ts).
const upper = "console.log((await Bun.stdin.text()).trim().toUpperCase())";
await check("$ pipes + env", async () => (await $`echo $GREETING | bun -e ${upper}`.env({ ...process.env, GREETING: "piped" }).text()).trim());
await check("$ json + lines", async () => {
  const lines: string[] = [];
  for await (const line of $`printf 'a\nb\n'`.lines()) if (line) lines.push(line);
  return [await $`echo '{"ok":true}'`.json(), lines];
});
await check("$ nothrow + exitCode", async () => {
  const result = await $`exit 3`.nothrow().quiet();
  return result.exitCode;
});
await check("$ throws ShellError", async () => {
  try {
    await $`false`.quiet();
  } catch (error) {
    return [(error as Error).constructor.name, (error as { exitCode?: number }).exitCode];
  }
  throw new Error("false did not throw");
});
// File redirects (`> file`) fail under the Node test host's WASI; the playground runner checks them.
await check("$ cwd", async () => (await $`pwd`.cwd("out").text()).trim().endsWith("/out"));

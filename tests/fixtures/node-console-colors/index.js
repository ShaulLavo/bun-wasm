import assert from "node:assert/strict";

const source = `
const {Console} = require('node:console');
const {Writable} = require('node:stream');
let output = '';
const stream = new Writable({write(chunk, encoding, callback) { output += chunk; callback(); }});
stream.isTTY = process.env.TTY === 'true';
const colorMode = process.env.MODE === 'auto' ? 'auto' : process.env.MODE === 'true';
new Console({stdout: stream, colorMode}).log(1);
process.stdout.write(JSON.stringify(output));
`;
for (const [force, tty, mode, colored] of [
  ["1", "false", "auto", true],
  ["0", "true", "auto", false],
  ["1", "true", "false", false],
  ["0", "false", "true", true],
]) {
  const child = Bun.spawn([process.execPath, "-e", source], {
    env: Object.assign({}, process.env, { FORCE_COLOR: force, TTY: tty, MODE: mode }),
    stdout: "pipe", stderr: "pipe",
  });
  const output = await child.stdout.text();
  assert.equal(await child.exited, 0);
  assert.equal(JSON.parse(output), colored ? "\x1b[33m1\x1b[39m\n" : "1\n");
  console.log(force, tty, mode, colored);
}

function rejects(name, action, pattern) {
  try { action(); console.log(name, false); }
  catch (error) { console.log(name, pattern.test(error.message)); }
}
const command = [process.execPath, "-e", "0"];
command.length = 4294967295;
rejects("large sync", () => Bun.spawnSync(command), /cmd array is too large/);
rejects("large async", () => Bun.spawn(command), /cmd array is too large/);
rejects("large options sync", () => Bun.spawnSync({ cmd: command }), /cmd array is too large/);
rejects("large options async", () => Bun.spawn({ cmd: command }), /cmd array is too large/);
rejects("ipc", () => Bun.spawn([process.execPath, "-e", "0"], { ipc: true }), /ipc must be a function/);

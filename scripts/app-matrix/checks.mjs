import { posix } from "node:path";
import { failure } from "./classify.mjs";

export async function checkCommand(command, result, read) {
  const check = command.check;
  const expected = check.exit ?? 0;
  if (result.timedOut || result.code !== expected) return { status: "fail", exit: result.code, timedOut: result.timedOut, ...failure(result.output, command.name) };
  const required = check.texts ?? (check.kind === "stdout" ? [check.text] : []);
  const missing = required.find(text => !result.output.includes(text));
  if (missing) return { status: "fail", category: "d", blocker: `Missing output ${missing}` };
  if (check.kind === "files") {
    const contents = await Promise.all(check.paths.map(read));
    const invalid = contents.findIndex(content => !content?.length || !content.includes(check.text));
    if (invalid !== -1) return { status: "fail", category: "d", blocker: `Missing or invalid build output ${check.paths[invalid]}` };
  }
  return { status: "pass", exit: result.code, assertion: JSON.stringify(check) };
}

export async function checkInstall(app, result, read) {
  if (result.code !== 0 || result.timedOut) return { status: "fail", exit: result.code, ...failure(result.output, "install") };
  for (const [name, version] of Object.entries(app.dependencies)) {
    const problem = await packageProblem(name, version, read);
    if (problem) return { status: "fail", category: "d", blocker: problem };
  }
  const paths = app.commands.flatMap(command => command.args.filter(arg => arg.startsWith("node_modules/")));
  for (const path of paths) {
    if (!(await read(path))?.length) return { status: "fail", category: "d", blocker: `Missing installed entry point ${path}` };
  }
  return { status: "pass", assertion: `Verified package versions and entry points: ${JSON.stringify(app.dependencies)}` };
}

async function packageProblem(name, version, read) {
  const path = `node_modules/${name}/package.json`;
  let metadata;
  try { metadata = JSON.parse(await read(path)); }
  catch { return `Missing or invalid installed package ${path}`; }
  if (metadata?.name !== name || metadata?.version !== version) return `Installed package mismatch ${name}@${version}`;
  if (typeof metadata.main === "string" && !(await read(posix.join("node_modules", name, metadata.main)))?.length) return `Missing installed package main ${name}/${metadata.main}`;
  return null;
}

// process.umask, process.cpuUsage, os priority and the credential setters: which error each
// invalid call raises, and that valid calls read back what they wrote.
import os from "node:os";

type Failure = { name: string; code: string };
const outcome = (fn: () => unknown): string => {
  try {
    fn();
    return "no error";
  } catch (error) {
    const failure = error as Failure;
    return `${failure.name} ${failure.code}`;
  }
};

console.log("umask bigint", outcome(() => process.umask(265n as never)));
console.log("umask string", outcome(() => process.umask("zz")));
console.log("umask negative", outcome(() => process.umask(-1)));
console.log("umask fraction", outcome(() => process.umask(1.5)));
console.log("umask overflow", outcome(() => process.umask("40000000000")));
const original = process.umask(0o77);
console.log("umask set", process.umask() === 0o77, process.umask(original.toString(8)) === 0o77, process.umask() === original);
console.log("umask padded sign", outcome(() => process.umask(" +77 ")), process.umask());
console.log("umask high bits", process.umask(512), process.umask());
process.umask(original);

console.log("cpuUsage negative", outcome(() => process.cpuUsage({ user: -1, system: 0 })));
console.log("cpuUsage empty", outcome(() => process.cpuUsage({} as never)));
console.log("cpuUsage string", outcome(() => process.cpuUsage("x" as never)));
console.log("cpuUsage function", outcome(() => process.cpuUsage(Object.assign(() => {}, { user: 1, system: 2 }) as never)));
const delta = process.cpuUsage({ user: 0, system: 0 });
console.log("cpuUsage diff", typeof delta.user, typeof delta.system);

os.setPriority(0, 5);
console.log("priority", os.getPriority(), os.getPriority(0));
os.setPriority(8);
console.log("priority short form", os.getPriority());
console.log("priority range", outcome(() => os.setPriority(0, 40)));
try {
  os.getPriority(-1);
} catch (error) {
  const failure = error as Failure & { info: { code: string; syscall: string }; errno: number };
  console.log("priority esrch", failure.name, failure.code, failure.info.code, failure.info.syscall, failure.errno);
}
console.log("setPriority esrch", outcome(() => os.setPriority(0x7ffffffe, 0)));
const replaced = process;
const uv = process.binding("uv");
(globalThis as { process: unknown }).process = null;
console.log("errname after replacing process", uv.errname(-2));
console.log("priority after replacing process", os.getPriority(0) === 8);
(globalThis as { process: unknown }).process = replaced;

console.log("setuid unknown name", outcome(() => process.setuid("zz_no_such_user_zz")));
console.log("setgid unknown name", outcome(() => process.setgid("zz_no_such_group_zz")));
console.log("setuid type", outcome(() => process.setuid({} as never)));
console.log("setgroups type", outcome(() => process.setgroups("x" as never)));
console.log("setgroups hole", outcome(() => process.setgroups(new Array(1))));
console.log("initgroups unknown uid", outcome(() => process.initgroups(0x7ffffffe, 0)));
console.log("initgroups type", outcome(() => process.initgroups({} as never, 0)));

// Setting an id to the one the process already has is allowed without privilege.
console.log("seteuid same", process.seteuid!(process.geteuid!()), process.geteuid!() === process.getuid!());
console.log("setegid same", process.setegid!(process.getegid!()), process.getegid!() === process.getgid!());
console.log("userInfo ids", os.userInfo().uid === process.getuid!(), os.userInfo().gid === process.getgid!());
console.log("userInfo shell", typeof os.userInfo().shell);

console.log("mainModule", process.mainModule === require.main);
console.log("mainModule key", Object.keys(process).includes("mainModule"));
(process as { mainModule: unknown }).mainModule = 123;
console.log("mainModule written", process.mainModule, require.main !== (123 as never));

// process.umask, process.cpuUsage, os priority and the credential setters: which error each
// invalid call raises, and that valid calls read back what they wrote.
const os = require("node:os");

const outcome = fn => {
  try {
    fn();
    return "no error";
  } catch (error) {
    return `${error.name} ${error.code}`;
  }
};

console.log("umask bigint", outcome(() => process.umask(265n)));
console.log("umask string", outcome(() => process.umask("zz")));
console.log("umask negative", outcome(() => process.umask(-1)));
console.log("umask fraction", outcome(() => process.umask(1.5)));
const original = process.umask(0o77);
console.log("umask set", process.umask() === 0o77, process.umask(String(original.toString(8))) === 0o77, process.umask() === original);

console.log("cpuUsage negative", outcome(() => process.cpuUsage({ user: -1, system: 0 })));
console.log("cpuUsage empty", outcome(() => process.cpuUsage({})));
console.log("cpuUsage string", outcome(() => process.cpuUsage("x")));
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
  console.log("priority esrch", error.name, error.code, error.info.code, error.info.syscall, error.errno);
}
console.log("setPriority esrch", outcome(() => os.setPriority(0x7ffffffe, 0)));

console.log("setuid unknown name", outcome(() => process.setuid("zz_no_such_user_zz")));
console.log("setgid unknown name", outcome(() => process.setgid("zz_no_such_group_zz")));
console.log("setuid type", outcome(() => process.setuid({})));
console.log("setgroups type", outcome(() => process.setgroups("x")));
console.log("initgroups unknown uid", outcome(() => process.initgroups(0x7ffffffe, 0)));
console.log("initgroups type", outcome(() => process.initgroups({}, 0)));

console.log("mainModule", process.mainModule === require.main);
process.mainModule = 123;
console.log("mainModule written", process.mainModule, require.main !== 123);

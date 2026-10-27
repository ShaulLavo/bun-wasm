import { constants } from "node:os";
import { getSystemErrorMap } from "node:util";

for (const code of ["EMFILE", "ENOMEM", "ENOSPC", "EAGAIN"] as const) {
  const errno = -constants.errno[code];
  const expected = getSystemErrorMap().get(errno);
  if (!expected || expected[0] !== code) throw new Error(`Missing Node errno ${code}`);
  console.log(`${code}\t${code}: ${expected[1]}, read`);
}

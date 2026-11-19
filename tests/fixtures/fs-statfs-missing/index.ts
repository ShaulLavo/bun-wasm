import fs, { statfs, statfsSync } from "node:fs";
import { statfs as statfsPromise } from "node:fs/promises";

// Every form exists, and a missing path fails with ENOENT and syscall "statfs".
console.log(typeof statfsSync, typeof statfs, typeof statfsPromise, fs.promises.statfs === statfsPromise);

const show = (error: NodeJS.ErrnoException) => console.log(error.code, error.syscall, error.path, error.message);

try {
  statfsSync("missing-dir/inner");
} catch (error) {
  show(error as NodeJS.ErrnoException);
}

await new Promise<void>(resolve => {
  statfs("missing-dir", error => {
    show(error as NodeJS.ErrnoException);
    resolve();
  });
});

await statfsPromise("missing-dir").catch(show);

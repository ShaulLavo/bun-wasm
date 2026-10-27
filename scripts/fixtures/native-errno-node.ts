import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { constants } from "node:os";

const errors: unknown = createRequire(import.meta.url)("internal/errors");
assert.ok(errors && typeof errors === "object" && "UVException" in errors && typeof errors.UVException === "function");
const Constructor = errors.UVException;

for (const code of ["EMFILE", "ENOMEM", "ENOSPC", "EAGAIN"] as const) {
  const errno = -constants.errno[code];
  const messages = [undefined, "/errno fixture"].map(path => {
    const error: unknown = Reflect.construct(Constructor, [{ errno, syscall: "read", path }]);
    assert.ok(error instanceof Error);
    assert.ok("code" in error && "errno" in error && "syscall" in error);
    assert.equal(error.code, code);
    assert.equal(error.errno, errno);
    assert.equal(error.syscall, "read");
    assert.equal("path" in error, path !== undefined);
    if (path !== undefined) assert.ok("path" in error && error.path === path);
    return error.message;
  });
  console.log(`${code}\t${messages.join("\t")}`);
}

// process.setuid, seteuid, setgid, setegid, setgroups and initgroups, after Bun's functions of
// the same names (src/jsc/bindings/BunProcess.cpp). The guest is one process with no kernel
// credentials, so it keeps the ids itself: it runs as root, which may set any of them, and a
// name resolves through the guest's own /etc/passwd and /etc/group.
(function (internal: BunWasm.Internal) {
  "use strict";
  type Coded = Error & { code: string };
  const fail = <T extends Error>(error: T, code: string): T & Coded => Object.assign(error, { code });
  const received = (value: unknown): string => (typeof value === "bigint" ? `type bigint (${value}n)` : internal.describe(value));

  const state = { uid: 0, euid: 0, gid: 0, egid: 0, groups: [] as number[] };

  // The rows of a colon-separated database: [name, password, id, ...].
  function rows(file: string, fallback: string[][]): string[][] {
    try {
      const fs = internal.builtin("node:fs") as unknown as { readFileSync(path: string, encoding: string): string };
      const text = fs.readFileSync(file, "utf8");
      const parsed = text.split("\n").filter(line => line !== "" && line[0] !== "#").map(line => line.split(":"));
      return parsed.length > 0 ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  const passwd = () => rows("/etc/passwd", [["root", "x", "0", "0"]]);
  const groupFile = () => rows("/etc/group", [["root", "x", "0"]]);

  const idTypeError = (name: string, value: unknown) =>
    fail(new TypeError(`The "${name}" argument must be of type number or string. Received ${received(value)}`), "ERR_INVALID_ARG_TYPE");

  function validateUint32(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 0 || value > 4294967295) {
      const rule = Number.isInteger(value) ? ">= 0 && <= 4294967295" : "an integer";
      throw fail(new RangeError(`The value of "${name}" is out of range. It must be ${rule}. Received ${String(value)}`), "ERR_OUT_OF_RANGE");
    }
    return value;
  }

  // Bun's maybe_uid_by_name and maybe_gid_by_name: a name becomes its id, a number stays.
  function lookup(table: string[][], kind: string, value: unknown, idColumn: number): number {
    if (typeof value === "number") return value;
    if (typeof value !== "string") throw idTypeError("id", value);
    const row = table.find(entry => entry[0] === value);
    if (row === undefined) throw fail(new Error(`${kind} identifier does not exist: ${value}`), "ERR_UNKNOWN_CREDENTIAL");
    return Number(row[idColumn]);
  }

  // setuid and its three siblings validate a numeric id as an integer from 0 to 2^31 - 1.
  function checkedId(value: unknown, resolve: (value: unknown) => number): number {
    const id = resolve(value);
    if (typeof value !== "number") return id;
    if (!Number.isInteger(id) || id < 0 || id > 2147483647) {
      const rule = Number.isInteger(id) ? ">= 0 && <= 2147483647" : "an integer";
      throw fail(new RangeError(`The value of "id" is out of range. It must be ${rule}. Received ${String(id)}`), "ERR_OUT_OF_RANGE");
    }
    return id;
  }
  const userId = (value: unknown) => checkedId(value, v => lookup(passwd(), "User", v, 2));
  const groupId = (value: unknown) => checkedId(value, v => lookup(groupFile(), "Group", v, 2));

  function setter(assign: (id: number) => void, resolve: (value: unknown) => number) {
    return (value: unknown): number => {
      assign(resolve(value));
      return 0;
    };
  }

  // Bun reads each index up to the length it captured first, so a hole or a getter is seen as
  // the value it gives, and the list changes only when every item is valid.
  function setgroups(groups: unknown): number {
    if (!Array.isArray(groups)) {
      throw fail(new TypeError(`The "groups" argument must be an instance of Array. Received ${received(groups)}`), "ERR_INVALID_ARG_TYPE");
    }
    const count = groups.length;
    if (count > 64) {
      throw fail(new RangeError(`The value of "groups.length" is out of range. It must be >= 0 && <= 64. Received ${count}`), "ERR_OUT_OF_RANGE");
    }
    const table = groupFile();
    const ids: number[] = [];
    for (let index = 0; index < count; index++) {
      const item: unknown = groups[index];
      const name = `groups[${index}]`;
      if (typeof item === "number") ids.push(validateUint32(item, name));
      else if (typeof item === "string") ids.push(lookup(table, "Group", item, 2));
      else throw idTypeError(name, item);
    }
    state.groups = ids;
    return 0;
  }

  // Node's initgroups takes a name or an id for the user and the extra group. Bun validates both
  // as ids, resolves the group first, and resolves only a numeric user through passwd: a name is
  // handed to initgroups(3) as it is. The result is the extra group followed by the groups of
  // /etc/group that list the user.
  function initgroups(user: unknown, extraGroup: unknown): void {
    const typeError = (name: string, value: unknown) =>
      fail(new TypeError(`The "${name}" argument must be one of type number or string. Received ${received(value)}`), "ERR_INVALID_ARG_TYPE");
    if (typeof user !== "number" && typeof user !== "string") throw typeError("user", user);
    if (typeof user === "number") validateUint32(user, "user");
    if (typeof extraGroup !== "number" && typeof extraGroup !== "string") throw typeError("extraGroup", extraGroup);
    if (typeof extraGroup === "number") validateUint32(extraGroup, "extraGroup");
    const table = groupFile();
    const gid = lookup(table, "Group", extraGroup, 2);
    let name: string;
    if (typeof user === "number") {
      const entry = passwd().find(row => Number(row[2]) === user);
      if (entry === undefined) throw fail(new Error(`User identifier does not exist: ${user}`), "ERR_UNKNOWN_CREDENTIAL");
      name = entry[0];
    } else {
      name = user;
    }
    const member = table.filter(row => (row[3] ?? "").split(",").includes(name)).map(row => Number(row[2]));
    state.groups = [gid].concat(member.filter(id => id !== gid));
  }

  return {
    getuid: () => state.uid,
    geteuid: () => state.euid,
    getgid: () => state.gid,
    getegid: () => state.egid,
    getgroups: () => state.groups.slice(),
    // setuid and setgid change the real, effective and saved ids, as they do for root.
    setuid: setter(id => { state.uid = id; state.euid = id; }, userId),
    seteuid: setter(id => { state.euid = id; }, userId),
    setgid: setter(id => { state.gid = id; state.egid = id; }, groupId),
    setegid: setter(id => { state.egid = id; }, groupId),
    setgroups,
    initgroups,
  };
})

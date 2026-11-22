// libuv's error names and messages for process.binding("uv") and fs error messages. The
// table is libuv's Linux errno set in the order Bun 1.4.4 reports it (Bun's uv binding
// reads it from uv_err_name and uv_strerror).
(function () {
  "use strict";
  type Entry = readonly [errno: number, name: string, message: string];

  const table: readonly Entry[] = [
    [-7, "E2BIG", "argument list too long"],
    [-13, "EACCES", "permission denied"],
    [-98, "EADDRINUSE", "address already in use"],
    [-99, "EADDRNOTAVAIL", "address not available"],
    [-97, "EAFNOSUPPORT", "address family not supported"],
    [-11, "EAGAIN", "resource temporarily unavailable"],
    [-3000, "EAI_ADDRFAMILY", "address family not supported"],
    [-3001, "EAI_AGAIN", "temporary failure"],
    [-3002, "EAI_BADFLAGS", "bad ai_flags value"],
    [-3013, "EAI_BADHINTS", "invalid value for hints"],
    [-3003, "EAI_CANCELED", "request canceled"],
    [-3004, "EAI_FAIL", "permanent failure"],
    [-3005, "EAI_FAMILY", "ai_family not supported"],
    [-3006, "EAI_MEMORY", "out of memory"],
    [-3007, "EAI_NODATA", "no address"],
    [-3008, "EAI_NONAME", "unknown node or service"],
    [-3009, "EAI_OVERFLOW", "argument buffer overflow"],
    [-3014, "EAI_PROTOCOL", "resolved protocol is unknown"],
    [-3010, "EAI_SERVICE", "service not available for socket type"],
    [-3011, "EAI_SOCKTYPE", "socket type not supported"],
    [-114, "EALREADY", "connection already in progress"],
    [-9, "EBADF", "bad file descriptor"],
    [-16, "EBUSY", "resource busy or locked"],
    [-125, "ECANCELED", "operation canceled"],
    [-4080, "ECHARSET", "invalid Unicode character"],
    [-103, "ECONNABORTED", "software caused connection abort"],
    [-111, "ECONNREFUSED", "connection refused"],
    [-104, "ECONNRESET", "connection reset by peer"],
    [-89, "EDESTADDRREQ", "destination address required"],
    [-17, "EEXIST", "file already exists"],
    [-14, "EFAULT", "bad address in system call argument"],
    [-27, "EFBIG", "file too large"],
    [-113, "EHOSTUNREACH", "host is unreachable"],
    [-4, "EINTR", "interrupted system call"],
    [-22, "EINVAL", "invalid argument"],
    [-5, "EIO", "i/o error"],
    [-106, "EISCONN", "socket is already connected"],
    [-21, "EISDIR", "illegal operation on a directory"],
    [-40, "ELOOP", "too many symbolic links encountered"],
    [-24, "EMFILE", "too many open files"],
    [-90, "EMSGSIZE", "message too long"],
    [-36, "ENAMETOOLONG", "name too long"],
    [-100, "ENETDOWN", "network is down"],
    [-101, "ENETUNREACH", "network is unreachable"],
    [-23, "ENFILE", "file table overflow"],
    [-105, "ENOBUFS", "no buffer space available"],
    [-19, "ENODEV", "no such device"],
    [-2, "ENOENT", "no such file or directory"],
    [-12, "ENOMEM", "not enough memory"],
    [-64, "ENONET", "machine is not on the network"],
    [-92, "ENOPROTOOPT", "protocol not available"],
    [-28, "ENOSPC", "no space left on device"],
    [-38, "ENOSYS", "function not implemented"],
    [-107, "ENOTCONN", "socket is not connected"],
    [-20, "ENOTDIR", "not a directory"],
    [-39, "ENOTEMPTY", "directory not empty"],
    [-88, "ENOTSOCK", "socket operation on non-socket"],
    [-95, "ENOTSUP", "operation not supported on socket"],
    [-75, "EOVERFLOW", "value too large for defined data type"],
    [-1, "EPERM", "operation not permitted"],
    [-32, "EPIPE", "broken pipe"],
    [-71, "EPROTO", "protocol error"],
    [-93, "EPROTONOSUPPORT", "protocol not supported"],
    [-91, "EPROTOTYPE", "protocol wrong type for socket"],
    [-34, "ERANGE", "result too large"],
    [-30, "EROFS", "read-only file system"],
    [-108, "ESHUTDOWN", "cannot send after transport endpoint shutdown"],
    [-29, "ESPIPE", "invalid seek"],
    [-3, "ESRCH", "no such process"],
    [-110, "ETIMEDOUT", "connection timed out"],
    [-26, "ETXTBSY", "text file is busy"],
    [-18, "EXDEV", "cross-device link not permitted"],
    [-4094, "UNKNOWN", "unknown error"],
    [-4095, "EOF", "end of file"],
    [-6, "ENXIO", "no such device or address"],
    [-31, "EMLINK", "too many links"],
    [-112, "EHOSTDOWN", "host is down"],
    [-121, "EREMOTEIO", "remote I/O error"],
    [-25, "ENOTTY", "inappropriate ioctl for device"],
    [-4028, "EFTYPE", "inappropriate file type or format"],
    [-84, "EILSEQ", "illegal byte sequence"],
    [-94, "ESOCKTNOSUPPORT", "socket type not supported"],
    [-61, "ENODATA", "no data available"],
    [-49, "EUNATCH", "protocol driver not attached"],
    [-8, "ENOEXEC", "exec format error"],
  ];

  const byErrno = new Map(table.map(entry => [entry[0], entry]));
  const byName = new Map(table.map(entry => [entry[1], entry]));
  let binding: Record<string, unknown> | undefined;

  function errorMap() {
    return new Map(table.map(([errno, name, message]) => [errno, [name, message]]));
  }

  // The binding's errname does not validate: a non-integer is just an unknown error.
  // Node latches DEP0119 once per thread, and only under --pending-deprecation.
  let errnameWarned = false;
  function errname(errno: unknown) {
    const process = globalThis.process as { pendingDeprecation?: boolean; emitWarning(message: string, type: string, code: string): void };
    if (process.pendingDeprecation && !errnameWarned) {
      errnameWarned = true;
      process.emitWarning("Directly calling process.binding('uv').errname(<val>) is being deprecated. Please make sure to use util.getSystemErrorName() instead.", "DeprecationWarning", "DEP0119");
    }
    const entry = typeof errno === "number" ? byErrno.get(errno) : undefined;
    if (entry) return entry[1];
    return Number.isInteger(errno) ? `Unknown system error ${errno}` : "Unknown system error";
  }

  function uvBinding() {
    if (binding) return binding;
    const constants: Record<string, unknown> = { errname };
    for (const [errno, name] of table) constants[`UV_${name}`] = errno;
    constants.getErrorMap = errorMap;
    binding = constants;
    return binding;
  }

  return {
    binding: uvBinding,
    // The libuv message for an error code name, as fs errors print it ("ENOENT: no such file or directory, ...").
    message: (name: string) => byName.get(name)?.[2],
  };
})

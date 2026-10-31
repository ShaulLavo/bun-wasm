// Generated from Bun 9510e74152073d850a18758ca41114d8f214ffa6, src/js/node/wasi.ts.
(function (intrinsics) {
"use strict";
var $, nodeFsConstants = intrinsics.processBindingConstants.fs;
class WASIError extends Error {
    constructor(errno) {
        super();
        this.errno = errno, Object.setPrototypeOf(this, WASIError.prototype);
    }
}
var WASI_ESUCCESS = 0, WASI_E2BIG = 1, WASI_EACCES = 2, WASI_EADDRINUSE = 3, WASI_EADDRNOTAVAIL = 4, WASI_EAFNOSUPPORT = 5, WASI_EAGAIN = 6, WASI_EALREADY = 7, WASI_EBADF = 8, WASI_EBADMSG = 9, WASI_EBUSY = 10, WASI_ECANCELED = 11, WASI_ECHILD = 12, WASI_ECONNABORTED = 13, WASI_ECONNREFUSED = 14, WASI_ECONNRESET = 15, WASI_EDEADLK = 16, WASI_EDESTADDRREQ = 17, WASI_EDOM = 18, WASI_EDQUOT = 19, WASI_EEXIST = 20, WASI_EFAULT = 21, WASI_EFBIG = 22, WASI_EHOSTUNREACH = 23, WASI_EIDRM = 24, WASI_EILSEQ = 25, WASI_EINPROGRESS = 26, WASI_EINTR = 27, WASI_EINVAL = 28, WASI_EIO = 29, WASI_EISCONN = 30, WASI_EISDIR = 31, WASI_ELOOP = 32, WASI_EMFILE = 33, WASI_EMLINK = 34, WASI_EMSGSIZE = 35, WASI_EMULTIHOP = 36, WASI_ENAMETOOLONG = 37, WASI_ENETDOWN = 38, WASI_ENETRESET = 39, WASI_ENETUNREACH = 40, WASI_ENFILE = 41, WASI_ENOBUFS = 42, WASI_ENODEV = 43, WASI_ENOENT = 44, WASI_ENOEXEC = 45, WASI_ENOLCK = 46, WASI_ENOLINK = 47, WASI_ENOMEM = 48, WASI_ENOMSG = 49, WASI_ENOPROTOOPT = 50, WASI_ENOSPC = 51, WASI_ENOSYS = 52, WASI_ENOTCONN = 53, WASI_ENOTDIR = 54, WASI_ENOTEMPTY = 55, WASI_ENOTRECOVERABLE = 56, WASI_ENOTSOCK = 57, WASI_ENOTTY = 59, WASI_ENXIO = 60, WASI_EOVERFLOW = 61, WASI_EOWNERDEAD = 62, WASI_EPERM = 63, WASI_EPIPE = 64, WASI_EPROTO = 65, WASI_EPROTONOSUPPORT = 66, WASI_EPROTOTYPE = 67, WASI_ERANGE = 68, WASI_EROFS = 69, WASI_ESPIPE = 70, WASI_ESRCH = 71, WASI_ESTALE = 72, WASI_ETIMEDOUT = 73, WASI_ETXTBSY = 74, WASI_EXDEV = 75, WASI_ENOTCAPABLE = 76, WASI_SIGABRT = 0, WASI_SIGALRM = 1, WASI_SIGBUS = 2, WASI_SIGCHLD = 3, WASI_SIGCONT = 4, WASI_SIGFPE = 5, WASI_SIGHUP = 6, WASI_SIGILL = 7, WASI_SIGINT = 8, WASI_SIGKILL = 9, WASI_SIGPIPE = 10, WASI_SIGQUIT = 11, WASI_SIGSEGV = 12, WASI_SIGSTOP = 13, WASI_SIGTERM = 14, WASI_SIGTRAP = 15, WASI_SIGTSTP = 16, WASI_SIGTTIN = 17, WASI_SIGTTOU = 18, WASI_SIGURG = 19, WASI_SIGUSR1 = 20, WASI_SIGUSR2 = 21, WASI_SIGVTALRM = 22, WASI_SIGXCPU = 23, WASI_SIGXFSZ = 24, WASI_FILETYPE_UNKNOWN = 0, WASI_FILETYPE_BLOCK_DEVICE = 1, WASI_FILETYPE_CHARACTER_DEVICE = 2, WASI_FILETYPE_DIRECTORY = 3, WASI_FILETYPE_REGULAR_FILE = 4, WASI_FILETYPE_SOCKET_STREAM = 6, WASI_FILETYPE_SYMBOLIC_LINK = 7, WASI_FDFLAG_APPEND = 1, WASI_FDFLAG_DSYNC = 2, WASI_FDFLAG_NONBLOCK = 4, WASI_FDFLAG_RSYNC = 8, WASI_FDFLAG_SYNC = 16, WASI_RIGHT_FD_DATASYNC = BigInt(1), WASI_RIGHT_FD_READ = BigInt(2), WASI_RIGHT_FD_SEEK = BigInt(4), WASI_RIGHT_FD_FDSTAT_SET_FLAGS = BigInt(8), WASI_RIGHT_FD_SYNC = BigInt(16), WASI_RIGHT_FD_TELL = BigInt(32), WASI_RIGHT_FD_WRITE = BigInt(64), WASI_RIGHT_FD_ADVISE = BigInt(128), WASI_RIGHT_FD_ALLOCATE = BigInt(256), WASI_RIGHT_PATH_CREATE_DIRECTORY = BigInt(512), WASI_RIGHT_PATH_CREATE_FILE = BigInt(1024), WASI_RIGHT_PATH_LINK_SOURCE = BigInt(2048), WASI_RIGHT_PATH_LINK_TARGET = BigInt(4096), WASI_RIGHT_PATH_OPEN = BigInt(8192), WASI_RIGHT_FD_READDIR = BigInt(16384), WASI_RIGHT_PATH_READLINK = BigInt(32768), WASI_RIGHT_PATH_RENAME_SOURCE = BigInt(65536), WASI_RIGHT_PATH_RENAME_TARGET = BigInt(131072), WASI_RIGHT_PATH_FILESTAT_GET = BigInt(262144), WASI_RIGHT_PATH_FILESTAT_SET_SIZE = BigInt(524288), WASI_RIGHT_PATH_FILESTAT_SET_TIMES = BigInt(1048576), WASI_RIGHT_FD_FILESTAT_GET = BigInt(2097152), WASI_RIGHT_FD_FILESTAT_SET_SIZE = BigInt(4194304), WASI_RIGHT_FD_FILESTAT_SET_TIMES = BigInt(8388608), WASI_RIGHT_PATH_SYMLINK = BigInt(16777216), WASI_RIGHT_PATH_REMOVE_DIRECTORY = BigInt(33554432), WASI_RIGHT_PATH_UNLINK_FILE = BigInt(67108864), WASI_RIGHT_POLL_FD_READWRITE = BigInt(134217728), WASI_RIGHT_SOCK_SHUTDOWN = BigInt(268435456), RIGHTS_ALL = WASI_RIGHT_FD_DATASYNC | WASI_RIGHT_FD_READ | WASI_RIGHT_FD_SEEK | WASI_RIGHT_FD_FDSTAT_SET_FLAGS | WASI_RIGHT_FD_SYNC | WASI_RIGHT_FD_TELL | WASI_RIGHT_FD_WRITE | WASI_RIGHT_FD_ADVISE | WASI_RIGHT_FD_ALLOCATE | WASI_RIGHT_PATH_CREATE_DIRECTORY | WASI_RIGHT_PATH_CREATE_FILE | WASI_RIGHT_PATH_LINK_SOURCE | WASI_RIGHT_PATH_LINK_TARGET | WASI_RIGHT_PATH_OPEN | WASI_RIGHT_FD_READDIR | WASI_RIGHT_PATH_READLINK | WASI_RIGHT_PATH_RENAME_SOURCE | WASI_RIGHT_PATH_RENAME_TARGET | WASI_RIGHT_PATH_FILESTAT_GET | WASI_RIGHT_PATH_FILESTAT_SET_SIZE | WASI_RIGHT_PATH_FILESTAT_SET_TIMES | WASI_RIGHT_FD_FILESTAT_GET | WASI_RIGHT_FD_FILESTAT_SET_TIMES | WASI_RIGHT_FD_FILESTAT_SET_SIZE | WASI_RIGHT_PATH_SYMLINK | WASI_RIGHT_PATH_UNLINK_FILE | WASI_RIGHT_PATH_REMOVE_DIRECTORY | WASI_RIGHT_POLL_FD_READWRITE | WASI_RIGHT_SOCK_SHUTDOWN, RIGHTS_BLOCK_DEVICE_BASE = RIGHTS_ALL, RIGHTS_BLOCK_DEVICE_INHERITING = RIGHTS_ALL, RIGHTS_CHARACTER_DEVICE_BASE = RIGHTS_ALL, RIGHTS_CHARACTER_DEVICE_INHERITING = RIGHTS_ALL, RIGHTS_REGULAR_FILE_BASE = WASI_RIGHT_FD_DATASYNC | WASI_RIGHT_FD_READ | WASI_RIGHT_FD_SEEK | WASI_RIGHT_FD_FDSTAT_SET_FLAGS | WASI_RIGHT_FD_SYNC | WASI_RIGHT_FD_TELL | WASI_RIGHT_FD_WRITE | WASI_RIGHT_FD_ADVISE | WASI_RIGHT_FD_ALLOCATE | WASI_RIGHT_FD_FILESTAT_GET | WASI_RIGHT_FD_FILESTAT_SET_SIZE | WASI_RIGHT_FD_FILESTAT_SET_TIMES | WASI_RIGHT_POLL_FD_READWRITE, RIGHTS_REGULAR_FILE_INHERITING = BigInt(0), RIGHTS_DIRECTORY_BASE = WASI_RIGHT_FD_FDSTAT_SET_FLAGS | WASI_RIGHT_FD_SYNC | WASI_RIGHT_FD_ADVISE | WASI_RIGHT_PATH_CREATE_DIRECTORY | WASI_RIGHT_PATH_CREATE_FILE | WASI_RIGHT_PATH_LINK_SOURCE | WASI_RIGHT_PATH_LINK_TARGET | WASI_RIGHT_PATH_OPEN | WASI_RIGHT_FD_READDIR | WASI_RIGHT_PATH_READLINK | WASI_RIGHT_PATH_RENAME_SOURCE | WASI_RIGHT_PATH_RENAME_TARGET | WASI_RIGHT_PATH_FILESTAT_GET | WASI_RIGHT_PATH_FILESTAT_SET_SIZE | WASI_RIGHT_PATH_FILESTAT_SET_TIMES | WASI_RIGHT_FD_FILESTAT_GET | WASI_RIGHT_FD_FILESTAT_SET_TIMES | WASI_RIGHT_PATH_SYMLINK | WASI_RIGHT_PATH_UNLINK_FILE | WASI_RIGHT_PATH_REMOVE_DIRECTORY | WASI_RIGHT_POLL_FD_READWRITE, RIGHTS_DIRECTORY_INHERITING = RIGHTS_DIRECTORY_BASE | RIGHTS_REGULAR_FILE_BASE, RIGHTS_SOCKET_BASE = WASI_RIGHT_FD_READ | WASI_RIGHT_FD_FDSTAT_SET_FLAGS | WASI_RIGHT_FD_WRITE | WASI_RIGHT_FD_FILESTAT_GET | WASI_RIGHT_POLL_FD_READWRITE | WASI_RIGHT_SOCK_SHUTDOWN, RIGHTS_SOCKET_INHERITING = RIGHTS_ALL, RIGHTS_TTY_BASE = WASI_RIGHT_FD_READ | WASI_RIGHT_FD_FDSTAT_SET_FLAGS | WASI_RIGHT_FD_WRITE | WASI_RIGHT_FD_FILESTAT_GET | WASI_RIGHT_POLL_FD_READWRITE, RIGHTS_TTY_INHERITING = BigInt(0), WASI_CLOCK_REALTIME = 0, WASI_CLOCK_MONOTONIC = 1, WASI_CLOCK_PROCESS_CPUTIME_ID = 2, WASI_CLOCK_THREAD_CPUTIME_ID = 3, WASI_EVENTTYPE_CLOCK = 0, WASI_EVENTTYPE_FD_READ = 1, WASI_EVENTTYPE_FD_WRITE = 2, WASI_FILESTAT_SET_ATIM = 1, WASI_FILESTAT_SET_ATIM_NOW = 2, WASI_FILESTAT_SET_MTIM = 4, WASI_FILESTAT_SET_MTIM_NOW = 8, WASI_O_CREAT = 1, WASI_O_DIRECTORY = 2, WASI_O_EXCL = 4, WASI_O_TRUNC = 8, WASI_PREOPENTYPE_DIR = 0, WASI_STDIN_FILENO = 0, WASI_STDOUT_FILENO = 1, WASI_STDERR_FILENO = 2, WASI_WHENCE_SET = 0, WASI_WHENCE_CUR = 1, WASI_WHENCE_END = 2, ERROR_MAP = {
    E2BIG: WASI_E2BIG,
    EACCES: WASI_EACCES,
    EADDRINUSE: WASI_EADDRINUSE,
    EADDRNOTAVAIL: WASI_EADDRNOTAVAIL,
    EAFNOSUPPORT: WASI_EAFNOSUPPORT,
    EALREADY: WASI_EALREADY,
    EAGAIN: WASI_EAGAIN,
    EBADF: WASI_EBADF,
    EBADMSG: WASI_EBADMSG,
    EBUSY: WASI_EBUSY,
    ECANCELED: WASI_ECANCELED,
    ECHILD: WASI_ECHILD,
    ECONNABORTED: WASI_ECONNABORTED,
    ECONNREFUSED: WASI_ECONNREFUSED,
    ECONNRESET: WASI_ECONNRESET,
    EDEADLOCK: WASI_EDEADLK,
    EDESTADDRREQ: WASI_EDESTADDRREQ,
    EDOM: WASI_EDOM,
    EDQUOT: WASI_EDQUOT,
    EEXIST: WASI_EEXIST,
    EFAULT: WASI_EFAULT,
    EFBIG: WASI_EFBIG,
    EHOSTDOWN: WASI_EHOSTUNREACH,
    EHOSTUNREACH: WASI_EHOSTUNREACH,
    EIDRM: WASI_EIDRM,
    EILSEQ: WASI_EILSEQ,
    EINPROGRESS: WASI_EINPROGRESS,
    EINTR: WASI_EINTR,
    EINVAL: WASI_EINVAL,
    EIO: WASI_EIO,
    EISCONN: WASI_EISCONN,
    EISDIR: WASI_EISDIR,
    ELOOP: WASI_ELOOP,
    EMFILE: WASI_EMFILE,
    EMLINK: WASI_EMLINK,
    EMSGSIZE: WASI_EMSGSIZE,
    EMULTIHOP: WASI_EMULTIHOP,
    ENAMETOOLONG: WASI_ENAMETOOLONG,
    ENETDOWN: WASI_ENETDOWN,
    ENETRESET: WASI_ENETRESET,
    ENETUNREACH: WASI_ENETUNREACH,
    ENFILE: WASI_ENFILE,
    ENOBUFS: WASI_ENOBUFS,
    ENODEV: WASI_ENODEV,
    ENOENT: WASI_ENOENT,
    ENOEXEC: WASI_ENOEXEC,
    ENOLCK: WASI_ENOLCK,
    ENOLINK: WASI_ENOLINK,
    ENOMEM: WASI_ENOMEM,
    ENOMSG: WASI_ENOMSG,
    ENOPROTOOPT: WASI_ENOPROTOOPT,
    ENOSPC: WASI_ENOSPC,
    ENOSYS: WASI_ENOSYS,
    ENOTCONN: WASI_ENOTCONN,
    ENOTDIR: WASI_ENOTDIR,
    ENOTEMPTY: WASI_ENOTEMPTY,
    ENOTRECOVERABLE: WASI_ENOTRECOVERABLE,
    ENOTSOCK: WASI_ENOTSOCK,
    ENOTTY: WASI_ENOTTY,
    ENXIO: WASI_ENXIO,
    EOVERFLOW: WASI_EOVERFLOW,
    EOWNERDEAD: WASI_EOWNERDEAD,
    EPERM: WASI_EPERM,
    EPIPE: WASI_EPIPE,
    EPROTO: WASI_EPROTO,
    EPROTONOSUPPORT: WASI_EPROTONOSUPPORT,
    EPROTOTYPE: WASI_EPROTOTYPE,
    ERANGE: WASI_ERANGE,
    EROFS: WASI_EROFS,
    ESPIPE: WASI_ESPIPE,
    ESRCH: WASI_ESRCH,
    ESTALE: WASI_ESTALE,
    ETIMEDOUT: WASI_ETIMEDOUT,
    ETXTBSY: WASI_ETXTBSY,
    EXDEV: WASI_EXDEV
}, SIGNAL_MAP = {
    [WASI_SIGHUP]: "SIGHUP",
    [WASI_SIGINT]: "SIGINT",
    [WASI_SIGQUIT]: "SIGQUIT",
    [WASI_SIGILL]: "SIGILL",
    [WASI_SIGTRAP]: "SIGTRAP",
    [WASI_SIGABRT]: "SIGABRT",
    [WASI_SIGBUS]: "SIGBUS",
    [WASI_SIGFPE]: "SIGFPE",
    [WASI_SIGKILL]: "SIGKILL",
    [WASI_SIGUSR1]: "SIGUSR1",
    [WASI_SIGSEGV]: "SIGSEGV",
    [WASI_SIGUSR2]: "SIGUSR2",
    [WASI_SIGPIPE]: "SIGPIPE",
    [WASI_SIGALRM]: "SIGALRM",
    [WASI_SIGTERM]: "SIGTERM",
    [WASI_SIGCHLD]: "SIGCHLD",
    [WASI_SIGCONT]: "SIGCONT",
    [WASI_SIGSTOP]: "SIGSTOP",
    [WASI_SIGTSTP]: "SIGTSTP",
    [WASI_SIGTTIN]: "SIGTTIN",
    [WASI_SIGTTOU]: "SIGTTOU",
    [WASI_SIGURG]: "SIGURG",
    [WASI_SIGXCPU]: "SIGXCPU",
    [WASI_SIGXFSZ]: "SIGXFSZ",
    [WASI_SIGVTALRM]: "SIGVTALRM"
}, fs, SC_OPEN_MAX = 32768, STDIN_DEFAULT_RIGHTS = WASI_RIGHT_FD_DATASYNC | WASI_RIGHT_FD_READ | WASI_RIGHT_FD_SYNC | WASI_RIGHT_FD_ADVISE | WASI_RIGHT_FD_FILESTAT_GET | WASI_RIGHT_POLL_FD_READWRITE, STDOUT_DEFAULT_RIGHTS = WASI_RIGHT_FD_DATASYNC | WASI_RIGHT_FD_WRITE | WASI_RIGHT_FD_SYNC | WASI_RIGHT_FD_ADVISE | WASI_RIGHT_FD_FILESTAT_GET | WASI_RIGHT_POLL_FD_READWRITE, STDERR_DEFAULT_RIGHTS = STDOUT_DEFAULT_RIGHTS, msToNs = (ms) => {
    let msInt = Math.trunc(ms), decimal = BigInt(Math.round((ms - msInt) * 1e6));
    return BigInt(msInt) * BigInt(1e6) + decimal;
}, nsToMs = (ns) => {
    if (typeof ns === "number")
        ns = Math.trunc(ns);
    let nsInt = BigInt(ns);
    return Number(nsInt / BigInt(1e6));
}, wrap = (f) => (...args) => {
    try {
        return f(...args);
    }
    catch (err) {
        let e = err;
        while (e.prev != null)
            e = e.prev;
        if (e?.code && typeof e?.code === "string")
            return ERROR_MAP[e.code] || WASI_EINVAL;
        if (e instanceof WASIError)
            return e.errno;
        throw e;
    }
}, stat = (wasi, fd) => {
    let entry = wasi.FD_MAP.get(fd);
    if (!entry)
        throw new WASIError(WASI_EBADF);
    if (entry.filetype === void 0) {
        let stats = wasi.fstatSync(entry.real), { filetype, rightsBase, rightsInheriting } = translateFileAttributes(wasi, fd, stats);
        if (entry.filetype = filetype, !entry.rights)
            entry.rights = {
                base: rightsBase,
                inheriting: rightsInheriting
            };
    }
    return entry;
}, translateFileAttributes = (wasi, fd, stats) => {
    switch (!0) {
        case stats.isBlockDevice():
            return {
                filetype: WASI_FILETYPE_BLOCK_DEVICE,
                rightsBase: RIGHTS_BLOCK_DEVICE_BASE,
                rightsInheriting: RIGHTS_BLOCK_DEVICE_INHERITING
            };
        case stats.isCharacterDevice(): {
            let filetype = WASI_FILETYPE_CHARACTER_DEVICE;
            if (fd !== void 0 && wasi.bindings.isTTY(fd))
                return {
                    filetype,
                    rightsBase: RIGHTS_TTY_BASE,
                    rightsInheriting: RIGHTS_TTY_INHERITING
                };
            return {
                filetype,
                rightsBase: RIGHTS_CHARACTER_DEVICE_BASE,
                rightsInheriting: RIGHTS_CHARACTER_DEVICE_INHERITING
            };
        }
        case stats.isDirectory():
            return {
                filetype: WASI_FILETYPE_DIRECTORY,
                rightsBase: RIGHTS_DIRECTORY_BASE,
                rightsInheriting: RIGHTS_DIRECTORY_INHERITING
            };
        case stats.isFIFO():
            return {
                filetype: WASI_FILETYPE_SOCKET_STREAM,
                rightsBase: RIGHTS_SOCKET_BASE,
                rightsInheriting: RIGHTS_SOCKET_INHERITING
            };
        case stats.isFile():
            return {
                filetype: WASI_FILETYPE_REGULAR_FILE,
                rightsBase: RIGHTS_REGULAR_FILE_BASE,
                rightsInheriting: RIGHTS_REGULAR_FILE_INHERITING
            };
        case stats.isSocket():
            return {
                filetype: WASI_FILETYPE_SOCKET_STREAM,
                rightsBase: RIGHTS_SOCKET_BASE,
                rightsInheriting: RIGHTS_SOCKET_INHERITING
            };
        case stats.isSymbolicLink():
            return {
                filetype: WASI_FILETYPE_SYMBOLIC_LINK,
                rightsBase: BigInt(0),
                rightsInheriting: BigInt(0)
            };
        default:
            return {
                filetype: WASI_FILETYPE_UNKNOWN,
                rightsBase: BigInt(0),
                rightsInheriting: BigInt(0)
            };
    }
}, warnedAboutSleep = !1, defaultConfig;
function getDefaults() {
    if (defaultConfig)
        return defaultConfig;
    let defaultBindings = {
        hrtime: () => process.hrtime.bigint(),
        exit: (code) => {
            process.exit(code);
        },
        kill: (signal) => {
            process.kill(process.pid, signal);
        },
        randomFillSync: (array) => crypto.getRandomValues(array),
        isTTY: (fd) => (intrinsics.getInternalField(intrinsics.internalModuleRegistry, 183) || intrinsics.createInternalModuleById(183)).isatty(fd),
        fs: intrinsics.getInternalField(intrinsics.internalModuleRegistry, 155) || intrinsics.createInternalModuleById(155),
        path: intrinsics.getInternalField(intrinsics.internalModuleRegistry, 164) || intrinsics.createInternalModuleById(164)
    };
    return defaultConfig = {
        args: [],
        env: {},
        preopens: {},
        bindings: defaultBindings,
        sleep: (ms) => {
            Bun.sleepSync(ms);
        }
    };
}
class WASI {
    constructor(wasiConfig = {}) {
        let defaultConfig = getDefaults();
        this.lastStdin = 0, this.started = !1, this.sleep = wasiConfig.sleep || defaultConfig.sleep, this.getStdin = wasiConfig.getStdin, this.sendStdout = wasiConfig.sendStdout, this.sendStderr = wasiConfig.sendStderr;
        let preopens = wasiConfig.preopens ?? defaultConfig.preopens;
        this.env = wasiConfig.env ?? defaultConfig.env;
        let args = wasiConfig.args ?? defaultConfig.args;
        this.memory = void 0, this.view = void 0, this.bindings = wasiConfig.bindings || defaultConfig.bindings;
        let bindings = this.bindings;
        fs = bindings.fs, this.FD_MAP = new Map([
            [
                WASI_STDIN_FILENO,
                {
                    real: 0,
                    filetype: WASI_FILETYPE_CHARACTER_DEVICE,
                    rights: {
                        base: STDIN_DEFAULT_RIGHTS,
                        inheriting: BigInt(0)
                    },
                    path: "/dev/stdin"
                }
            ],
            [
                WASI_STDOUT_FILENO,
                {
                    real: 1,
                    filetype: WASI_FILETYPE_CHARACTER_DEVICE,
                    rights: {
                        base: STDOUT_DEFAULT_RIGHTS,
                        inheriting: BigInt(0)
                    },
                    path: "/dev/stdout"
                }
            ],
            [
                WASI_STDERR_FILENO,
                {
                    real: 2,
                    filetype: WASI_FILETYPE_CHARACTER_DEVICE,
                    rights: {
                        base: STDERR_DEFAULT_RIGHTS,
                        inheriting: BigInt(0)
                    },
                    path: "/dev/stderr"
                }
            ]
        ]);
        let path = bindings.path;
        for (let [k, v] of Object.entries(preopens)) {
            let real = fs.openSync(v, nodeFsConstants.O_RDONLY), newfd = this.getUnusedFileDescriptor();
            this.FD_MAP.set(newfd, {
                real,
                filetype: WASI_FILETYPE_DIRECTORY,
                rights: {
                    base: RIGHTS_DIRECTORY_BASE,
                    inheriting: RIGHTS_DIRECTORY_INHERITING
                },
                fakePath: k,
                path: v
            });
        }
        let getiovs = (iovs, iovsLen) => {
            this.refreshMemory();
            let { view, memory } = this, { buffer } = memory, { byteLength } = buffer;
            if (iovsLen === 1) {
                let ptr = iovs, buf = view.getUint32(ptr, !0), bufLen = view.getUint32(ptr + 4, !0);
                if (bufLen > byteLength - buf)
                    console.log({
                        buf,
                        bufLen,
                        total_memory: byteLength
                    }), bufLen = Math.min(bufLen, Math.max(0, byteLength - buf));
                try {
                    return [new intrinsics.Uint8Array(buffer, buf, bufLen)];
                }
                catch (err) {
                    throw console.warn("WASI.getiovs -- invalid buffer", err), new WASIError(WASI_EINVAL);
                }
            }
            let buffers = [];
            buffers.length = iovsLen;
            for (let i = 0, ptr = iovs; i < iovsLen; i++, ptr += 8) {
                let buf = view.getUint32(ptr, !0), bufLen = view.getUint32(ptr + 4, !0);
                if (bufLen > byteLength - buf)
                    console.log({
                        buf,
                        bufLen,
                        total_memory: byteLength
                    }), bufLen = Math.min(bufLen, Math.max(0, byteLength - buf));
                try {
                    buffers[i] = new intrinsics.Uint8Array(buffer, buf, bufLen);
                }
                catch (err) {
                    throw console.warn("WASI.getiovs -- invalid buffer", err), new WASIError(WASI_EINVAL);
                }
            }
            return buffers;
        }, CHECK_FD = (fd, rights) => {
            let stats = stat(this, fd);
            if (rights !== BigInt(0) && (stats.rights.base & rights) === BigInt(0))
                throw new WASIError(WASI_EPERM);
            return stats;
        }, RESOLVE_PATH = (stats, guestPath) => {
            if (!stats.path)
                throw new WASIError(WASI_EINVAL);
            let rel = intrinsics.String(guestPath);
            while (rel.length !== 0 && (rel.charCodeAt(0) === 47 || rel.charCodeAt(0) === 92))
                rel = rel.slice(1);
            let base = path.resolve(stats.path), resolved = path.resolve(base, rel), isContained = (parent, child) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
            if (!isContained(base, resolved))
                throw new WASIError(WASI_ENOTCAPABLE);
            let realBase = base;
            try {
                realBase = fs.realpathSync(base);
            }
            catch { }
            let probe = resolved, suffix = "";
            for (;;) {
                let real;
                try {
                    real = fs.realpathSync(probe);
                }
                catch {
                    let parent = path.dirname(probe);
                    if (parent !== probe) {
                        suffix = path.sep + path.basename(probe) + suffix, probe = parent;
                        continue;
                    }
                    real = probe;
                }
                if (!isContained(realBase, real + suffix))
                    throw new WASIError(WASI_ENOTCAPABLE);
                return resolved;
            }
        }, CPUTIME_START = Bun.nanoseconds(), timeOrigin = Math.trunc(performance.timeOrigin * 1e6), now = (clockId) => {
            switch (clockId) {
                case WASI_CLOCK_MONOTONIC:
                    return Bun.nanoseconds();
                case WASI_CLOCK_REALTIME:
                    return Bun.nanoseconds() + timeOrigin;
                case WASI_CLOCK_PROCESS_CPUTIME_ID:
                case WASI_CLOCK_THREAD_CPUTIME_ID:
                    return Bun.nanoseconds() - CPUTIME_START;
                default:
                    return null;
            }
        };
        this.wasiImport = {
            args_get: (argv, argvBuf) => {
                this.refreshMemory();
                let coffset = argv, offset = argvBuf;
                return args.forEach((a) => {
                    this.view.setUint32(coffset, offset, !0), coffset += 4, offset += intrinsics.Buffer.from(this.memory.buffer).write(`${a}\x00`, offset);
                }), WASI_ESUCCESS;
            },
            args_sizes_get: (argc, argvBufSize) => {
                this.refreshMemory(), this.view.setUint32(argc, args.length, !0);
                let size = args.reduce((acc, a) => acc + intrinsics.Buffer.byteLength(a) + 1, 0);
                return this.view.setUint32(argvBufSize, size, !0), WASI_ESUCCESS;
            },
            environ_get: (environ, environBuf) => {
                this.refreshMemory();
                let coffset = environ, offset = environBuf;
                return Object.entries(this.env).forEach(([key, value]) => {
                    this.view.setUint32(coffset, offset, !0), coffset += 4, offset += intrinsics.Buffer.from(this.memory.buffer).write(`${key}=${value}\x00`, offset);
                }), WASI_ESUCCESS;
            },
            environ_sizes_get: (environCount, environBufSize) => {
                this.refreshMemory();
                let envProcessed = Object.entries(this.env).map(([key, value]) => `${key}=${value}\x00`), size = envProcessed.reduce((acc, e) => acc + intrinsics.Buffer.byteLength(e), 0);
                return this.view.setUint32(environCount, envProcessed.length, !0), this.view.setUint32(environBufSize, size, !0), WASI_ESUCCESS;
            },
            clock_res_get: (clockId, resolution) => {
                let res;
                switch (clockId) {
                    case WASI_CLOCK_MONOTONIC:
                    case WASI_CLOCK_PROCESS_CPUTIME_ID:
                    case WASI_CLOCK_THREAD_CPUTIME_ID: {
                        res = BigInt(1);
                        break;
                    }
                    case WASI_CLOCK_REALTIME: {
                        res = BigInt(1000);
                        break;
                    }
                }
                if (!res)
                    throw Error("invalid clockId");
                return this.view.setBigUint64(resolution, res), WASI_ESUCCESS;
            },
            clock_time_get: (clockId, _precision, time) => {
                this.refreshMemory();
                let n = now(clockId);
                if (n === null)
                    return WASI_EINVAL;
                return this.view.setBigUint64(time, BigInt(n), !0), WASI_ESUCCESS;
            },
            fd_advise: wrap((fd, _offset, _len, _advice) => (CHECK_FD(fd, WASI_RIGHT_FD_ADVISE), WASI_ENOSYS)),
            fd_allocate: wrap((fd, _offset, _len) => (CHECK_FD(fd, WASI_RIGHT_FD_ALLOCATE), WASI_ENOSYS)),
            fd_close: wrap((fd) => {
                let stats = CHECK_FD(fd, BigInt(0));
                return fs.closeSync(stats.real), this.FD_MAP.delete(fd), WASI_ESUCCESS;
            }),
            fd_datasync: wrap((fd) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_FD_DATASYNC);
                return fs.fdatasyncSync(stats.real), WASI_ESUCCESS;
            }),
            fd_fdstat_get: wrap((fd, bufPtr) => {
                let stats = CHECK_FD(fd, BigInt(0));
                if (this.refreshMemory(), stats.filetype == null)
                    throw Error("stats.filetype must be set");
                return this.view.setUint8(bufPtr, stats.filetype), this.view.setUint16(bufPtr + 2, 0, !0), this.view.setUint16(bufPtr + 4, 0, !0), this.view.setBigUint64(bufPtr + 8, BigInt(stats.rights.base), !0), this.view.setBigUint64(bufPtr + 8 + 8, BigInt(stats.rights.inheriting), !0), WASI_ESUCCESS;
            }),
            fd_fdstat_set_flags: wrap((fd, flags) => {
                if (CHECK_FD(fd, WASI_RIGHT_FD_FDSTAT_SET_FLAGS), this.wasiImport.sock_fcntlSetFlags(fd, flags) == 0)
                    return WASI_ESUCCESS;
                return WASI_ENOSYS;
            }),
            fd_fdstat_set_rights: wrap((fd, fsRightsBase, fsRightsInheriting) => {
                let stats = CHECK_FD(fd, BigInt(0));
                if (fsRightsBase = BigInt.asUintN(64, fsRightsBase), fsRightsInheriting = BigInt.asUintN(64, fsRightsInheriting), (stats.rights.base | fsRightsBase) > stats.rights.base)
                    return WASI_EPERM;
                if ((stats.rights.inheriting | fsRightsInheriting) > stats.rights.inheriting)
                    return WASI_EPERM;
                return stats.rights.base = fsRightsBase, stats.rights.inheriting = fsRightsInheriting, WASI_ESUCCESS;
            }),
            fd_filestat_get: wrap((fd, bufPtr) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_FD_FILESTAT_GET), rstats = this.fstatSync(stats.real);
                if (this.refreshMemory(), this.view.setBigUint64(bufPtr, BigInt(rstats.dev), !0), bufPtr += 8, this.view.setBigUint64(bufPtr, BigInt(rstats.ino), !0), bufPtr += 8, stats.filetype == null)
                    throw Error("stats.filetype must be set");
                return this.view.setUint8(bufPtr, stats.filetype), bufPtr += 8, this.view.setBigUint64(bufPtr, BigInt(rstats.nlink), !0), bufPtr += 8, this.view.setBigUint64(bufPtr, BigInt(rstats.size), !0), bufPtr += 8, this.view.setBigUint64(bufPtr, msToNs(rstats.atimeMs), !0), bufPtr += 8, this.view.setBigUint64(bufPtr, msToNs(rstats.mtimeMs), !0), bufPtr += 8, this.view.setBigUint64(bufPtr, msToNs(rstats.ctimeMs), !0), WASI_ESUCCESS;
            }),
            fd_filestat_set_size: wrap((fd, stSize) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_FD_FILESTAT_SET_SIZE);
                return fs.ftruncateSync(stats.real, Number(stSize)), WASI_ESUCCESS;
            }),
            fd_filestat_set_times: wrap((fd, stAtim, stMtim, fstflags) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_FD_FILESTAT_SET_TIMES), rstats = this.fstatSync(stats.real), { atime: atim, mtime: mtim } = rstats, n = nsToMs(now(WASI_CLOCK_REALTIME)), atimflags = WASI_FILESTAT_SET_ATIM | WASI_FILESTAT_SET_ATIM_NOW;
                if ((fstflags & atimflags) === atimflags)
                    return WASI_EINVAL;
                let mtimflags = WASI_FILESTAT_SET_MTIM | WASI_FILESTAT_SET_MTIM_NOW;
                if ((fstflags & mtimflags) === mtimflags)
                    return WASI_EINVAL;
                if ((fstflags & WASI_FILESTAT_SET_ATIM) === WASI_FILESTAT_SET_ATIM)
                    atim = nsToMs(stAtim);
                else if ((fstflags & WASI_FILESTAT_SET_ATIM_NOW) === WASI_FILESTAT_SET_ATIM_NOW)
                    atim = n;
                if ((fstflags & WASI_FILESTAT_SET_MTIM) === WASI_FILESTAT_SET_MTIM)
                    mtim = nsToMs(stMtim);
                else if ((fstflags & WASI_FILESTAT_SET_MTIM_NOW) === WASI_FILESTAT_SET_MTIM_NOW)
                    mtim = n;
                return fs.futimesSync(stats.real, new Date(atim), new Date(mtim)), WASI_ESUCCESS;
            }),
            fd_prestat_get: wrap((fd, bufPtr) => {
                let stats = CHECK_FD(fd, BigInt(0));
                return this.refreshMemory(), this.view.setUint8(bufPtr, WASI_PREOPENTYPE_DIR), this.view.setUint32(bufPtr + 4, intrinsics.Buffer.byteLength(stats.fakePath ?? stats.path ?? ""), !0), WASI_ESUCCESS;
            }),
            fd_prestat_dir_name: wrap((fd, pathPtr, pathLen) => {
                let stats = CHECK_FD(fd, BigInt(0));
                return this.refreshMemory(), intrinsics.Buffer.from(this.memory.buffer).write(stats.fakePath ?? stats.path ?? "", pathPtr, pathLen, "utf8"), WASI_ESUCCESS;
            }),
            fd_pwrite: wrap((fd, iovs, iovsLen, offset, nwritten) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_FD_WRITE | WASI_RIGHT_FD_SEEK), written = 0;
                return getiovs(iovs, iovsLen).forEach((iov) => {
                    let w = 0;
                    while (w < iov.byteLength)
                        w += fs.writeSync(stats.real, iov, w, iov.byteLength - w, Number(offset) + written + w);
                    written += w;
                }), this.view.setUint32(nwritten, written, !0), WASI_ESUCCESS;
            }),
            fd_write: wrap((fd, iovs, iovsLen, nwritten) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_FD_WRITE), IS_STDOUT = fd == WASI_STDOUT_FILENO, IS_STDERR = fd == WASI_STDERR_FILENO, written = 0;
                return getiovs(iovs, iovsLen).forEach((iov) => {
                    if (iov.byteLength == 0)
                        return;
                    if (IS_STDOUT && this.sendStdout != null)
                        this.sendStdout(iov), written += iov.byteLength;
                    else if (IS_STDERR && this.sendStderr != null)
                        this.sendStderr(iov), written += iov.byteLength;
                    else {
                        let w = 0;
                        while (w < iov.byteLength) {
                            let i = fs.writeSync(stats.real, iov, w, iov.byteLength - w, stats.offset ? Number(stats.offset) : null);
                            if (stats.offset)
                                stats.offset += BigInt(i);
                            w += i;
                        }
                        written += w;
                    }
                }), this.view.setUint32(nwritten, written, !0), WASI_ESUCCESS;
            }),
            fd_pread: wrap((fd, iovs, iovsLen, offset, nread) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_FD_READ | WASI_RIGHT_FD_SEEK), read = 0;
                outer: for (let iov of getiovs(iovs, iovsLen)) {
                    let r = 0;
                    while (r < iov.byteLength) {
                        let length = iov.byteLength - r, rr = fs.readSync(stats.real, iov, r, iov.byteLength - r, Number(offset) + read + r);
                        if (r += rr, read += rr, rr === 0 || rr < length)
                            break outer;
                    }
                }
                return this.view.setUint32(nread, read, !0), WASI_ESUCCESS;
            }),
            fd_read: wrap((fd, iovs, iovsLen, nread) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_FD_READ), IS_STDIN = fd == WASI_STDIN_FILENO, read = 0;
                outer: for (let iov of getiovs(iovs, iovsLen)) {
                    let r = 0;
                    while (r < iov.byteLength) {
                        let length = iov.byteLength - r, position = IS_STDIN || stats.offset === void 0 ? null : Number(stats.offset), rr = 0;
                        if (IS_STDIN) {
                            let getStdin = this.getStdin;
                            if (getStdin != null) {
                                if (this.stdinBuffer == null)
                                    this.stdinBuffer = intrinsics.uncurry(getStdin, "call")(this);
                                if (this.stdinBuffer != null) {
                                    if (rr = this.stdinBuffer.copy(iov), rr == this.stdinBuffer.length)
                                        this.stdinBuffer = void 0;
                                    else
                                        this.stdinBuffer = this.stdinBuffer.slice(rr);
                                    if (rr > 0)
                                        this.lastStdin = (new Date()).valueOf();
                                }
                            }
                            else {
                                if (this.sleep == null && !warnedAboutSleep)
                                    warnedAboutSleep = !0, console.log("(cpu waiting for stdin: please define a way to sleep!) ");
                                try {
                                    rr = fs.readSync(stats.real, iov, r, length, position);
                                }
                                catch { }
                                if (rr == 0)
                                    this.shortPause();
                                else
                                    this.lastStdin = (new Date()).valueOf();
                            }
                        }
                        else
                            rr = fs.readSync(stats.real, iov, r, length, position);
                        if (stats.filetype == WASI_FILETYPE_REGULAR_FILE)
                            stats.offset = (stats.offset ? stats.offset : BigInt(0)) + BigInt(rr);
                        if (r += rr, read += rr, rr === 0 || rr < length)
                            break outer;
                    }
                }
                return this.view.setUint32(nread, read, !0), WASI_ESUCCESS;
            }),
            fd_readdir: wrap((fd, bufPtr, bufLen, cookie, bufusedPtr) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_FD_READDIR);
                this.refreshMemory();
                let entries = fs.readdirSync(stats.path, { withFileTypes: !0 }), startPtr = bufPtr;
                for (let i = Number(cookie); i < entries.length; i += 1) {
                    let entry = entries[i], nameLength = intrinsics.Buffer.byteLength(entry.name);
                    if (bufPtr - startPtr > bufLen)
                        break;
                    if (this.view.setBigUint64(bufPtr, BigInt(i + 1), !0), bufPtr += 8, bufPtr - startPtr > bufLen)
                        break;
                    let rstats = fs.lstatSync(path.resolve(stats.path, entry.name));
                    if (this.view.setBigUint64(bufPtr, BigInt(rstats.ino), !0), bufPtr += 8, bufPtr - startPtr > bufLen)
                        break;
                    if (this.view.setUint32(bufPtr, nameLength, !0), bufPtr += 4, bufPtr - startPtr > bufLen)
                        break;
                    let filetype;
                    switch (!0) {
                        case rstats.isBlockDevice():
                            filetype = WASI_FILETYPE_BLOCK_DEVICE;
                            break;
                        case rstats.isCharacterDevice():
                            filetype = WASI_FILETYPE_CHARACTER_DEVICE;
                            break;
                        case rstats.isDirectory():
                            filetype = WASI_FILETYPE_DIRECTORY;
                            break;
                        case rstats.isFIFO():
                            filetype = WASI_FILETYPE_SOCKET_STREAM;
                            break;
                        case rstats.isFile():
                            filetype = WASI_FILETYPE_REGULAR_FILE;
                            break;
                        case rstats.isSocket():
                            filetype = WASI_FILETYPE_SOCKET_STREAM;
                            break;
                        case rstats.isSymbolicLink():
                            filetype = WASI_FILETYPE_SYMBOLIC_LINK;
                            break;
                        default:
                            filetype = WASI_FILETYPE_UNKNOWN;
                            break;
                    }
                    if (this.view.setUint8(bufPtr, filetype), bufPtr += 1, bufPtr += 3, bufPtr + nameLength >= startPtr + bufLen)
                        break;
                    intrinsics.Buffer.from(this.memory.buffer).write(entry.name, bufPtr), bufPtr += nameLength;
                }
                let bufused = bufPtr - startPtr;
                return this.view.setUint32(bufusedPtr, Math.min(bufused, bufLen), !0), WASI_ESUCCESS;
            }),
            fd_renumber: wrap((from, to) => {
                let fromEntry = CHECK_FD(from, BigInt(0)), toEntry = CHECK_FD(to, BigInt(0));
                return fs.closeSync(fromEntry.real), this.FD_MAP.set(from, toEntry), this.FD_MAP.delete(to), WASI_ESUCCESS;
            }),
            fd_seek: wrap((fd, offset, whence, newOffsetPtr) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_FD_SEEK);
                switch (this.refreshMemory(), whence) {
                    case WASI_WHENCE_CUR:
                        stats.offset = (stats.offset ? stats.offset : BigInt(0)) + BigInt(offset);
                        break;
                    case WASI_WHENCE_END:
                        let { size } = this.fstatSync(stats.real);
                        stats.offset = BigInt(size) + BigInt(offset);
                        break;
                    case WASI_WHENCE_SET:
                        stats.offset = BigInt(offset);
                        break;
                }
                if (stats.offset == null)
                    throw Error("stats.offset must be defined");
                return this.view.setBigUint64(newOffsetPtr, stats.offset, !0), WASI_ESUCCESS;
            }),
            fd_tell: wrap((fd, offsetPtr) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_FD_TELL);
                if (this.refreshMemory(), !stats.offset)
                    stats.offset = BigInt(0);
                return this.view.setBigUint64(offsetPtr, stats.offset, !0), WASI_ESUCCESS;
            }),
            fd_sync: wrap((fd) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_FD_SYNC);
                return fs.fsyncSync(stats.real), WASI_ESUCCESS;
            }),
            path_create_directory: wrap((fd, pathPtr, pathLen) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_PATH_CREATE_DIRECTORY);
                if (!stats.path)
                    return WASI_EINVAL;
                this.refreshMemory();
                let p = intrinsics.Buffer.from(this.memory.buffer, pathPtr, pathLen).toString();
                return fs.mkdirSync(RESOLVE_PATH(stats, p)), WASI_ESUCCESS;
            }),
            path_filestat_get: wrap((fd, flags, pathPtr, pathLen, bufPtr) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_PATH_FILESTAT_GET);
                if (!stats.path)
                    return WASI_EINVAL;
                this.refreshMemory();
                let p = intrinsics.Buffer.from(this.memory.buffer, pathPtr, pathLen).toString(), resolved = RESOLVE_PATH(stats, p), rstats;
                if (flags)
                    rstats = fs.statSync(resolved);
                else
                    rstats = fs.lstatSync(resolved);
                return this.view.setBigUint64(bufPtr, BigInt(rstats.dev), !0), bufPtr += 8, this.view.setBigUint64(bufPtr, BigInt(rstats.ino), !0), bufPtr += 8, this.view.setUint8(bufPtr, translateFileAttributes(this, void 0, rstats).filetype), bufPtr += 8, this.view.setBigUint64(bufPtr, BigInt(rstats.nlink), !0), bufPtr += 8, this.view.setBigUint64(bufPtr, BigInt(rstats.size), !0), bufPtr += 8, this.view.setBigUint64(bufPtr, BigInt(rstats.atime.getTime() * 1e6), !0), bufPtr += 8, this.view.setBigUint64(bufPtr, BigInt(rstats.mtime.getTime() * 1e6), !0), bufPtr += 8, this.view.setBigUint64(bufPtr, BigInt(rstats.ctime.getTime() * 1e6), !0), WASI_ESUCCESS;
            }),
            path_filestat_set_times: wrap((fd, _dirflags, pathPtr, pathLen, stAtim, stMtim, fstflags) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_PATH_FILESTAT_SET_TIMES);
                if (!stats.path)
                    return WASI_EINVAL;
                this.refreshMemory();
                let rstats = this.fstatSync(stats.real), { atime: atim, mtime: mtim } = rstats, n = nsToMs(now(WASI_CLOCK_REALTIME)), atimflags = WASI_FILESTAT_SET_ATIM | WASI_FILESTAT_SET_ATIM_NOW;
                if ((fstflags & atimflags) === atimflags)
                    return WASI_EINVAL;
                let mtimflags = WASI_FILESTAT_SET_MTIM | WASI_FILESTAT_SET_MTIM_NOW;
                if ((fstflags & mtimflags) === mtimflags)
                    return WASI_EINVAL;
                if ((fstflags & WASI_FILESTAT_SET_ATIM) === WASI_FILESTAT_SET_ATIM)
                    atim = nsToMs(stAtim);
                else if ((fstflags & WASI_FILESTAT_SET_ATIM_NOW) === WASI_FILESTAT_SET_ATIM_NOW)
                    atim = n;
                if ((fstflags & WASI_FILESTAT_SET_MTIM) === WASI_FILESTAT_SET_MTIM)
                    mtim = nsToMs(stMtim);
                else if ((fstflags & WASI_FILESTAT_SET_MTIM_NOW) === WASI_FILESTAT_SET_MTIM_NOW)
                    mtim = n;
                let p = intrinsics.Buffer.from(this.memory.buffer, pathPtr, pathLen).toString();
                return fs.utimesSync(RESOLVE_PATH(stats, p), new Date(atim), new Date(mtim)), WASI_ESUCCESS;
            }),
            path_link: wrap((oldFd, _oldFlags, oldPath, oldPathLen, newFd, newPath, newPathLen) => {
                let ostats = CHECK_FD(oldFd, WASI_RIGHT_PATH_LINK_SOURCE), nstats = CHECK_FD(newFd, WASI_RIGHT_PATH_LINK_TARGET);
                if (!ostats.path || !nstats.path)
                    return WASI_EINVAL;
                this.refreshMemory();
                let op = intrinsics.Buffer.from(this.memory.buffer, oldPath, oldPathLen).toString(), np = intrinsics.Buffer.from(this.memory.buffer, newPath, newPathLen).toString();
                return fs.linkSync(RESOLVE_PATH(ostats, op), RESOLVE_PATH(nstats, np)), WASI_ESUCCESS;
            }),
            path_open: wrap((dirfd, _dirflags, pathPtr, pathLen, oflags, fsRightsBase, fsRightsInheriting, fsFlags, fdPtr) => {
                try {
                    let stats = CHECK_FD(dirfd, WASI_RIGHT_PATH_OPEN);
                    fsRightsBase = BigInt.asUintN(64, BigInt(fsRightsBase)), fsRightsInheriting = BigInt.asUintN(64, BigInt(fsRightsInheriting));
                    let read = (fsRightsBase & (WASI_RIGHT_FD_READ | WASI_RIGHT_FD_READDIR)) !== BigInt(0), write = (fsRightsBase & (WASI_RIGHT_FD_DATASYNC | WASI_RIGHT_FD_WRITE | WASI_RIGHT_FD_ALLOCATE | WASI_RIGHT_FD_FILESTAT_SET_SIZE)) !== BigInt(0), noflags;
                    if (write && read)
                        noflags = nodeFsConstants.O_RDWR;
                    else if (read)
                        noflags = nodeFsConstants.O_RDONLY;
                    else if (write)
                        noflags = nodeFsConstants.O_WRONLY;
                    let neededBase = fsRightsBase | WASI_RIGHT_PATH_OPEN, neededInheriting = fsRightsBase | fsRightsInheriting;
                    if ((oflags & WASI_O_CREAT) !== 0)
                        noflags |= nodeFsConstants.O_CREAT, neededBase |= WASI_RIGHT_PATH_CREATE_FILE;
                    if ((oflags & WASI_O_DIRECTORY) !== 0)
                        noflags |= nodeFsConstants.O_DIRECTORY;
                    if ((oflags & WASI_O_EXCL) !== 0)
                        noflags |= nodeFsConstants.O_EXCL;
                    if ((oflags & WASI_O_TRUNC) !== 0)
                        noflags |= nodeFsConstants.O_TRUNC, neededBase |= WASI_RIGHT_PATH_FILESTAT_SET_SIZE;
                    if ((fsFlags & WASI_FDFLAG_APPEND) !== 0)
                        noflags |= nodeFsConstants.O_APPEND;
                    if ((fsFlags & WASI_FDFLAG_DSYNC) !== 0) {
                        let O_DSYNC = nodeFsConstants.O_DSYNC;
                        noflags |= O_DSYNC ? O_DSYNC : nodeFsConstants.O_SYNC, neededInheriting |= WASI_RIGHT_FD_DATASYNC;
                    }
                    if ((fsFlags & WASI_FDFLAG_NONBLOCK) !== 0)
                        noflags |= nodeFsConstants.O_NONBLOCK;
                    if ((fsFlags & WASI_FDFLAG_RSYNC) !== 0) {
                        let O_RSYNC = nodeFsConstants.O_RSYNC;
                        noflags |= O_RSYNC ? O_RSYNC : nodeFsConstants.O_SYNC, neededInheriting |= WASI_RIGHT_FD_SYNC;
                    }
                    if ((fsFlags & WASI_FDFLAG_SYNC) !== 0)
                        noflags |= nodeFsConstants.O_SYNC, neededInheriting |= WASI_RIGHT_FD_SYNC;
                    if (write && (noflags & (nodeFsConstants.O_APPEND | nodeFsConstants.O_TRUNC)) === 0)
                        neededInheriting |= WASI_RIGHT_FD_SEEK;
                    this.refreshMemory();
                    let p = intrinsics.Buffer.from(this.memory.buffer, pathPtr, pathLen).toString();
                    if (p == "dev/tty")
                        return this.view.setUint32(fdPtr, WASI_STDIN_FILENO, !0), WASI_ESUCCESS;
                    if (p.startsWith("proc/"))
                        throw new WASIError(WASI_EBADF);
                    let fullUnresolved = RESOLVE_PATH(stats, p), full;
                    try {
                        full = fs.realpathSync(fullUnresolved);
                    }
                    catch (e) {
                        if (e?.code === "ENOENT") {
                            let parentDir = path.dirname(fullUnresolved), lastComponent = path.basename(fullUnresolved), realParent = parentDir;
                            try {
                                realParent = fs.realpathSync(parentDir);
                            }
                            catch (e2) {
                                if (e2?.code !== "ENOENT")
                                    throw e2;
                            }
                            full = path.join(realParent, lastComponent);
                            let finalIsLink = !1;
                            try {
                                finalIsLink = fs.lstatSync(full).isSymbolicLink();
                            }
                            catch { }
                            if (finalIsLink)
                                throw new WASIError(WASI_ENOTCAPABLE);
                        }
                        else
                            throw e;
                    }
                    {
                        let contained = (base) => {
                            if (full === base)
                                return !0;
                            let rel = path.relative(base, full);
                            return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
                        }, lexicalBase = path.resolve(stats.path), realBase = lexicalBase;
                        try {
                            realBase = fs.realpathSync(lexicalBase);
                        }
                        catch { }
                        if (!contained(lexicalBase) && !contained(realBase))
                            throw new WASIError(WASI_ENOTCAPABLE);
                    }
                    let isDirectory;
                    if (write)
                        try {
                            isDirectory = fs.statSync(full).isDirectory();
                        }
                        catch { }
                    let realfd;
                    if (!write && isDirectory)
                        realfd = fs.openSync(full, nodeFsConstants.O_RDONLY);
                    else
                        realfd = fs.openSync(full, noflags);
                    let newfd = this.getUnusedFileDescriptor();
                    this.FD_MAP.set(newfd, {
                        real: realfd,
                        filetype: void 0,
                        rights: {
                            base: neededBase,
                            inheriting: neededInheriting
                        },
                        path: full
                    }), stat(this, newfd), this.view.setUint32(fdPtr, newfd, !0);
                }
                catch (e) {
                    if (e instanceof WASIError)
                        return e.errno;
                    throw e;
                }
                return WASI_ESUCCESS;
            }),
            path_readlink: wrap((fd, pathPtr, pathLen, buf, bufLen, bufused) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_PATH_READLINK);
                if (!stats.path)
                    return WASI_EINVAL;
                this.refreshMemory();
                let p = intrinsics.Buffer.from(this.memory.buffer, pathPtr, pathLen).toString(), full = RESOLVE_PATH(stats, p), r = fs.readlinkSync(full), used = intrinsics.Buffer.from(this.memory.buffer).write(r, buf, bufLen);
                return this.view.setUint32(bufused, used, !0), WASI_ESUCCESS;
            }),
            path_remove_directory: wrap((fd, pathPtr, pathLen) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_PATH_REMOVE_DIRECTORY);
                if (!stats.path)
                    return WASI_EINVAL;
                this.refreshMemory();
                let p = intrinsics.Buffer.from(this.memory.buffer, pathPtr, pathLen).toString();
                return fs.rmdirSync(RESOLVE_PATH(stats, p)), WASI_ESUCCESS;
            }),
            path_rename: wrap((oldFd, oldPath, oldPathLen, newFd, newPath, newPathLen) => {
                let ostats = CHECK_FD(oldFd, WASI_RIGHT_PATH_RENAME_SOURCE), nstats = CHECK_FD(newFd, WASI_RIGHT_PATH_RENAME_TARGET);
                if (!ostats.path || !nstats.path)
                    return WASI_EINVAL;
                this.refreshMemory();
                let op = intrinsics.Buffer.from(this.memory.buffer, oldPath, oldPathLen).toString(), np = intrinsics.Buffer.from(this.memory.buffer, newPath, newPathLen).toString();
                return fs.renameSync(RESOLVE_PATH(ostats, op), RESOLVE_PATH(nstats, np)), WASI_ESUCCESS;
            }),
            path_symlink: wrap((oldPath, oldPathLen, fd, newPath, newPathLen) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_PATH_SYMLINK);
                if (!stats.path)
                    return WASI_EINVAL;
                this.refreshMemory();
                let op = intrinsics.Buffer.from(this.memory.buffer, oldPath, oldPathLen).toString(), np = intrinsics.Buffer.from(this.memory.buffer, newPath, newPathLen).toString();
                return fs.symlinkSync(op, RESOLVE_PATH(stats, np)), WASI_ESUCCESS;
            }),
            path_unlink_file: wrap((fd, pathPtr, pathLen) => {
                let stats = CHECK_FD(fd, WASI_RIGHT_PATH_UNLINK_FILE);
                if (!stats.path)
                    return WASI_EINVAL;
                this.refreshMemory();
                let p = intrinsics.Buffer.from(this.memory.buffer, pathPtr, pathLen).toString();
                return fs.unlinkSync(RESOLVE_PATH(stats, p)), WASI_ESUCCESS;
            }),
            poll_oneoff: (sin, sout, nsubscriptions, neventsPtr) => {
                let startNs = BigInt(bindings.hrtime()), nevents = 0, waitTimeNs = BigInt(0), fd = -1, fd_type = "read", fd_timeout_ms = 0;
                this.refreshMemory();
                let last_sin = sin;
                for (let i = 0; i < nsubscriptions; i += 1) {
                    let userdata = this.view.getBigUint64(sin, !0);
                    sin += 8;
                    let type = this.view.getUint8(sin);
                    switch (sin += 1, sin += 7, type) {
                        case WASI_EVENTTYPE_CLOCK: {
                            let clockid = this.view.getUint32(sin, !0);
                            sin += 4, sin += 4;
                            let timeout = this.view.getBigUint64(sin, !0);
                            sin += 8, sin += 8;
                            let subclockflags = this.view.getUint16(sin, !0);
                            sin += 2, sin += 6;
                            let absolute = subclockflags === 1;
                            if (!absolute)
                                fd_timeout_ms = timeout / BigInt(1e6);
                            let e = WASI_ESUCCESS, t = now(clockid);
                            if (t == null)
                                e = WASI_EINVAL;
                            else {
                                let tNS = BigInt(t), waitNs = (absolute ? timeout : tNS + timeout) - tNS;
                                if (waitNs > waitTimeNs)
                                    waitTimeNs = waitNs;
                            }
                            this.view.setBigUint64(sout, userdata, !0), sout += 8, this.view.setUint16(sout, e, !0), sout += 2, this.view.setUint8(sout, WASI_EVENTTYPE_CLOCK), sout += 1, sout += 5, nevents += 1;
                            break;
                        }
                        case WASI_EVENTTYPE_FD_READ:
                        case WASI_EVENTTYPE_FD_WRITE: {
                            if (fd = this.view.getUint32(sin, !0), fd_type = type == WASI_EVENTTYPE_FD_READ ? "read" : "write", sin += 4, sin += 28, this.view.setBigUint64(sout, userdata, !0), sout += 8, this.view.setUint16(sout, WASI_ENOSYS, !0), sout += 2, this.view.setUint8(sout, type), sout += 1, sout += 5, nevents += 1, fd == WASI_STDIN_FILENO && WASI_EVENTTYPE_FD_READ == type)
                                this.shortPause();
                            break;
                        }
                        default:
                            return WASI_EINVAL;
                    }
                    if (sin - last_sin != 48)
                        console.warn("*** BUG in wasi-js in poll_oneoff ", {
                            i,
                            sin,
                            last_sin,
                            diff: sin - last_sin
                        });
                    last_sin = sin;
                }
                if (this.view.setUint32(neventsPtr, nevents, !0), nevents == 2 && fd >= 0) {
                    let r = this.wasiImport.sock_pollSocket(fd, fd_type, fd_timeout_ms);
                    if (r != WASI_ENOSYS)
                        return r;
                }
                if (waitTimeNs > 0) {
                    if (waitTimeNs -= BigInt(bindings.hrtime()) - startNs, waitTimeNs >= 1e6) {
                        let sleep = this.sleep;
                        if (sleep == null && !warnedAboutSleep)
                            warnedAboutSleep = !0, console.log("(100% cpu burning waiting for stdin: please define a way to sleep!) ");
                        if (sleep != null) {
                            let ms = nsToMs(waitTimeNs);
                            intrinsics.uncurry(sleep, "call")(this, ms);
                        }
                        else {
                            let end = BigInt(bindings.hrtime()) + waitTimeNs;
                            while (BigInt(bindings.hrtime()) < end)
                                ;
                        }
                    }
                }
                return WASI_ESUCCESS;
            },
            proc_exit: (rval) => (bindings.exit(rval), WASI_ESUCCESS),
            proc_raise: (sig) => {
                if (!(sig in SIGNAL_MAP))
                    return WASI_EINVAL;
                return bindings.kill(SIGNAL_MAP[sig]), WASI_ESUCCESS;
            },
            random_get: (bufPtr, bufLen) => (this.refreshMemory(), crypto.getRandomValues(new intrinsics.Uint8Array(this.memory.buffer, bufPtr, bufLen)), WASI_ESUCCESS),
            sched_yield() {
                return WASI_ESUCCESS;
            },
            sock_recv() {
                return WASI_ENOSYS;
            },
            sock_send() {
                return WASI_ENOSYS;
            },
            sock_shutdown() {
                return WASI_ENOSYS;
            },
            sock_fcntlSetFlags(_fd, _flags) {
                return WASI_ENOSYS;
            },
            sock_pollSocket(_fd, _eventtype, _timeout_ms) {
                return WASI_ENOSYS;
            }
        };
    }
    fstatSync(real_fd) {
        if (real_fd <= 2)
            try {
                return fs.fstatSync(real_fd);
            }
            catch {
                let now = new Date;
                return {
                    dev: 0,
                    mode: 8592,
                    nlink: 1,
                    uid: 0,
                    gid: 0,
                    rdev: 0,
                    blksize: 65536,
                    ino: 0,
                    size: 0,
                    blocks: 0,
                    atimeMs: now.valueOf(),
                    mtimeMs: now.valueOf(),
                    ctimeMs: now.valueOf(),
                    birthtimeMs: 0,
                    atime: new Date,
                    mtime: new Date,
                    ctime: new Date,
                    birthtime: new Date(0)
                };
            }
        return fs.fstatSync(real_fd);
    }
    shortPause() {
        if (this.sleep == null)
            return;
        if ((new Date()).valueOf() - this.lastStdin > 2000)
            this.sleep(50);
    }
    getUnusedFileDescriptor(start = 3) {
        let fd = start;
        while (this.FD_MAP.has(fd))
            fd += 1;
        if (fd > SC_OPEN_MAX)
            throw Error("no available file descriptors");
        return fd;
    }
    refreshMemory() {
        if (!this.view || this.view.buffer.byteLength === 0)
            this.view = new DataView(this.memory.buffer);
    }
    setMemory(memory) {
        this.memory = memory;
    }
    bindInstance(instance, memory) {
        if (this.started)
            throw Object.assign(Error("WASI instance has already started"), { code: "ERR_WASI_ALREADY_STARTED" });
        if (instance === null || typeof instance !== "object")
            intrinsics.throwTypeError("instance must be an Object");
        let exports2 = instance.exports;
        if (exports2 === null || typeof exports2 !== "object")
            throw Error(`instance.exports must be an Object. Received ${exports2}.`);
        if (memory == null) {
            if (memory = exports2.memory, !(memory instanceof WebAssembly.Memory))
                throw Error(`instance.exports.memory must be a WebAssembly.Memory. Recceived ${memory}.`);
        }
        return this.setMemory(memory), this.started = !0, exports2;
    }
    initialize(instance) {
        let exports2 = this.bindInstance(instance);
        if (exports2._start !== intrinsics.undefined)
            intrinsics.throwTypeError("instance.exports._start must be undefined for a WASI reactor");
        let initialize = exports2._initialize;
        if (initialize === intrinsics.undefined)
            return;
        if (typeof initialize !== "function")
            intrinsics.throwTypeError("instance.exports._initialize must be a function");
        initialize();
    }
    start(instance, memory) {
        let exports2 = this.bindInstance(instance, memory);
        if (exports2._start)
            exports2._start();
    }
    getImports(module2) {
        let namespace = null, imports = WebAssembly.Module.imports(module2);
        for (let imp of imports) {
            if (imp.kind !== "function")
                continue;
            if (!imp.module.startsWith("wasi_"))
                continue;
            namespace = imp.module;
            break;
        }
        switch (namespace) {
            case "wasi_unstable":
                return {
                    wasi_unstable: this.wasiImport
                };
            case "wasi_snapshot_preview1":
                return {
                    wasi_snapshot_preview1: this.wasiImport
                };
            default:
                throw Error(`No WASI namespace found. Only wasi_unstable and wasi_snapshot_preview1 are supported.

List of imports:

` + imports.map(({ name, kind, module }) => `${module}:${name} (${kind})`).join(`
`) + `
`);
        }
    }
}
$ = { WASI };
return $;
})

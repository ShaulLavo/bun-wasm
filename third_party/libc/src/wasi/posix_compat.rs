//! bun-wasm additions: POSIX declarations wasi-libc does not provide.
//! Values follow Linux/musl so code written against Linux constants behaves
//! the same; the functions are implemented by the `bunwasm-posix` crate.
use crate::prelude::*;
use super::*;

// ── sys/mman.h (musl values) ────────────────────────────────────────────
pub const PROT_NONE: c_int = 0;
pub const PROT_READ: c_int = 1;
pub const PROT_WRITE: c_int = 2;
pub const PROT_EXEC: c_int = 4;
pub const MAP_SHARED: c_int = 0x01;
pub const MAP_PRIVATE: c_int = 0x02;
pub const MAP_FIXED: c_int = 0x10;
pub const MAP_ANON: c_int = 0x20;
pub const MAP_ANONYMOUS: c_int = MAP_ANON;
pub const MAP_NORESERVE: c_int = 0x4000;
pub const MAP_POPULATE: c_int = 0x8000;
pub const MAP_FAILED: *mut c_void = !0 as *mut c_void;
pub const MS_ASYNC: c_int = 1;
pub const MS_INVALIDATE: c_int = 2;
pub const MS_SYNC: c_int = 4;
pub const MADV_NORMAL: c_int = 0;
pub const MADV_RANDOM: c_int = 1;
pub const MADV_SEQUENTIAL: c_int = 2;
pub const MADV_WILLNEED: c_int = 3;
pub const MADV_DONTNEED: c_int = 4;

extern "C" {
    pub fn mmap(addr: *mut c_void, len: size_t, prot: c_int, flags: c_int, fd: c_int, off: off_t) -> *mut c_void;
    pub fn munmap(addr: *mut c_void, len: size_t) -> c_int;
    pub fn mprotect(addr: *mut c_void, len: size_t, prot: c_int) -> c_int;
    pub fn msync(addr: *mut c_void, len: size_t, flags: c_int) -> c_int;
    pub fn madvise(addr: *mut c_void, len: size_t, advice: c_int) -> c_int;
}

// ── signal.h (Linux numbering; nothing is ever delivered) ───────────────
pub type sighandler_t = size_t;
pub const SIG_DFL: sighandler_t = 0;
pub const SIG_IGN: sighandler_t = 1;
pub const SIG_ERR: sighandler_t = !0;
pub const SIGHUP: c_int = 1;
pub const SIGINT: c_int = 2;
pub const SIGQUIT: c_int = 3;
pub const SIGILL: c_int = 4;
pub const SIGTRAP: c_int = 5;
pub const SIGABRT: c_int = 6;
pub const SIGIOT: c_int = 6;
pub const SIGBUS: c_int = 7;
pub const SIGFPE: c_int = 8;
pub const SIGKILL: c_int = 9;
pub const SIGUSR1: c_int = 10;
pub const SIGSEGV: c_int = 11;
pub const SIGUSR2: c_int = 12;
pub const SIGPIPE: c_int = 13;
pub const SIGALRM: c_int = 14;
pub const SIGTERM: c_int = 15;
pub const SIGSTKFLT: c_int = 16;
pub const SIGCHLD: c_int = 17;
pub const SIGCONT: c_int = 18;
pub const SIGSTOP: c_int = 19;
pub const SIGTSTP: c_int = 20;
pub const SIGTTIN: c_int = 21;
pub const SIGTTOU: c_int = 22;
pub const SIGURG: c_int = 23;
pub const SIGXCPU: c_int = 24;
pub const SIGXFSZ: c_int = 25;
pub const SIGVTALRM: c_int = 26;
pub const SIGPROF: c_int = 27;
pub const SIGWINCH: c_int = 28;
pub const SIGIO: c_int = 29;
pub const SIGPOLL: c_int = 29;
pub const SIGPWR: c_int = 30;
pub const SIGSYS: c_int = 31;
pub const NSIG: c_int = 65;
pub const SA_NOCLDSTOP: c_int = 1;
pub const SA_NOCLDWAIT: c_int = 2;
pub const SA_SIGINFO: c_int = 4;
pub const SA_ONSTACK: c_int = 0x08000000;
pub const SA_RESTART: c_int = 0x10000000;
pub const SA_NODEFER: c_int = 0x40000000;
pub const SA_RESETHAND: c_int = 0x80000000u32 as c_int;
pub const SIG_BLOCK: c_int = 0;
pub const SIG_UNBLOCK: c_int = 1;
pub const SIG_SETMASK: c_int = 2;

s! {
    pub struct sigaction {
        pub sa_sigaction: sighandler_t,
        pub sa_mask: sigset_t,
        pub sa_flags: c_int,
        pub sa_restorer: Option<extern "C" fn()>,
    }

    pub struct siginfo_t {
        pub si_signo: c_int,
        pub si_errno: c_int,
        pub si_code: c_int,
        _pad: [c_int; 29],
    }

    pub struct stack_t {
        pub ss_sp: *mut c_void,
        pub ss_flags: c_int,
        pub ss_size: size_t,
    }
}

extern "C" {
    pub fn sigaction(signum: c_int, act: *const sigaction, oldact: *mut sigaction) -> c_int;
    pub fn sigemptyset(set: *mut sigset_t) -> c_int;
    pub fn sigfillset(set: *mut sigset_t) -> c_int;
    pub fn sigaddset(set: *mut sigset_t, signum: c_int) -> c_int;
    pub fn sigdelset(set: *mut sigset_t, signum: c_int) -> c_int;
    pub fn sigismember(set: *const sigset_t, signum: c_int) -> c_int;
    pub fn sigprocmask(how: c_int, set: *const sigset_t, oldset: *mut sigset_t) -> c_int;
    pub fn pthread_sigmask(how: c_int, set: *const sigset_t, oldset: *mut sigset_t) -> c_int;
    pub fn sigaltstack(ss: *const stack_t, old: *mut stack_t) -> c_int;
    pub fn signal(signum: c_int, handler: sighandler_t) -> sighandler_t;
    pub fn kill(pid: pid_t, sig: c_int) -> c_int;
    pub fn raise(sig: c_int) -> c_int;
}

// ── processes: unistd.h / sys/wait.h ────────────────────────────────────
pub const WNOHANG: c_int = 1;
pub const WUNTRACED: c_int = 2;

pub const fn WIFEXITED(status: c_int) -> bool {
    (status & 0x7f) == 0
}
pub const fn WEXITSTATUS(status: c_int) -> c_int {
    (status >> 8) & 0xff
}
pub const fn WIFSIGNALED(status: c_int) -> bool {
    ((status & 0x7f) + 1) as i8 >= 2
}
pub const fn WTERMSIG(status: c_int) -> c_int {
    status & 0x7f
}
pub const fn WIFSTOPPED(status: c_int) -> bool {
    (status & 0xff) == 0x7f
}
pub const fn WSTOPSIG(status: c_int) -> c_int {
    (status >> 8) & 0xff
}

extern "C" {
    pub fn fork() -> pid_t;
    pub fn execve(path: *const c_char, argv: *const *const c_char, envp: *const *const c_char) -> c_int;
    pub fn execvp(file: *const c_char, argv: *const *const c_char) -> c_int;
    pub fn waitpid(pid: pid_t, status: *mut c_int, options: c_int) -> pid_t;
    pub fn getpid() -> pid_t;
    pub fn getppid() -> pid_t;
    pub fn getpgid(pid: pid_t) -> pid_t;
    pub fn setsid() -> pid_t;
    pub fn getuid() -> uid_t;
    pub fn geteuid() -> uid_t;
    pub fn getgid() -> gid_t;
    pub fn getegid() -> gid_t;
    pub fn umask(mask: mode_t) -> mode_t;
    pub fn dup(fd: c_int) -> c_int;
    pub fn dup2(src: c_int, dst: c_int) -> c_int;
    pub fn pipe(fds: *mut c_int) -> c_int;
    pub fn pipe2(fds: *mut c_int, flags: c_int) -> c_int;
    pub fn chown(path: *const c_char, uid: uid_t, gid: gid_t) -> c_int;
    pub fn fchown(fd: c_int, uid: uid_t, gid: gid_t) -> c_int;
    pub fn lchown(path: *const c_char, uid: uid_t, gid: gid_t) -> c_int;
    pub fn fchmodat(dirfd: c_int, path: *const c_char, mode: mode_t, flags: c_int) -> c_int;
    pub fn fchownat(dirfd: c_int, path: *const c_char, uid: uid_t, gid: gid_t, flags: c_int) -> c_int;
}

// ── sys/utsname.h ───────────────────────────────────────────────────────
s! {
    pub struct utsname {
        pub sysname: [c_char; 65],
        pub nodename: [c_char; 65],
        pub release: [c_char; 65],
        pub version: [c_char; 65],
        pub machine: [c_char; 65],
        pub domainname: [c_char; 65],
    }
}
extern "C" {
    pub fn uname(buf: *mut utsname) -> c_int;
}

// ── termios.h / sys/ioctl.h ─────────────────────────────────────────────
pub type tcflag_t = c_uint;
pub type cc_t = c_uchar;
pub type speed_t = c_uint;
pub const NCCS: usize = 32;
pub const TCSANOW: c_int = 0;
pub const TCSADRAIN: c_int = 1;
pub const TCSAFLUSH: c_int = 2;
pub const TIOCGWINSZ: c_int = 0x5413;
pub const ECHO: tcflag_t = 0o10;
pub const ICANON: tcflag_t = 0o2;
pub const ISIG: tcflag_t = 0o1;
pub const IEXTEN: tcflag_t = 0o100000;
pub const ICRNL: tcflag_t = 0o400;
pub const IXON: tcflag_t = 0o2000;
pub const OPOST: tcflag_t = 0o1;
pub const VMIN: usize = 6;
pub const VTIME: usize = 5;
s! {
    pub struct termios {
        pub c_iflag: tcflag_t,
        pub c_oflag: tcflag_t,
        pub c_cflag: tcflag_t,
        pub c_lflag: tcflag_t,
        pub c_line: cc_t,
        pub c_cc: [cc_t; NCCS],
        pub __c_ispeed: speed_t,
        pub __c_ospeed: speed_t,
    }

    pub struct winsize {
        pub ws_row: c_ushort,
        pub ws_col: c_ushort,
        pub ws_xpixel: c_ushort,
        pub ws_ypixel: c_ushort,
    }
}
extern "C" {
    pub fn tcgetattr(fd: c_int, termios: *mut termios) -> c_int;
    pub fn tcsetattr(fd: c_int, action: c_int, termios: *const termios) -> c_int;
    pub fn cfmakeraw(termios: *mut termios);
}

// ── sys/resource.h ──────────────────────────────────────────────────────
pub type rlim_t = u64;
pub const RLIM_INFINITY: rlim_t = !0;
pub const RLIMIT_CORE: c_int = 4;
pub const RLIMIT_NOFILE: c_int = 7;
pub const RLIMIT_STACK: c_int = 3;
s! {
    pub struct rlimit {
        pub rlim_cur: rlim_t,
        pub rlim_max: rlim_t,
    }
}
extern "C" {
    pub fn getrlimit(resource: c_int, rlim: *mut rlimit) -> c_int;
    pub fn setrlimit(resource: c_int, rlim: *const rlimit) -> c_int;
}

// ── pwd.h ───────────────────────────────────────────────────────────────
s! {
    pub struct passwd {
        pub pw_name: *mut c_char,
        pub pw_passwd: *mut c_char,
        pub pw_uid: uid_t,
        pub pw_gid: gid_t,
        pub pw_gecos: *mut c_char,
        pub pw_dir: *mut c_char,
        pub pw_shell: *mut c_char,
    }
}
extern "C" {
    pub fn getpwuid(uid: uid_t) -> *mut passwd;
    pub fn getpwuid_r(uid: uid_t, pwd: *mut passwd, buf: *mut c_char, buflen: size_t, result: *mut *mut passwd) -> c_int;
}

// ── dlfcn.h (no dynamic loading in WASI) ────────────────────────────────
pub const RTLD_LAZY: c_int = 1;
pub const RTLD_NOW: c_int = 2;
pub const RTLD_NOLOAD: c_int = 4;
pub const RTLD_GLOBAL: c_int = 0x100;
pub const RTLD_LOCAL: c_int = 0;
pub const RTLD_DEFAULT: *mut c_void = 0 as *mut c_void;
s! {
    pub struct Dl_info {
        pub dli_fname: *const c_char,
        pub dli_fbase: *mut c_void,
        pub dli_sname: *const c_char,
        pub dli_saddr: *mut c_void,
    }
}
extern "C" {
    pub fn dladdr(addr: *const c_void, info: *mut Dl_info) -> c_int;
    pub fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
    pub fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    pub fn dlclose(handle: *mut c_void) -> c_int;
    pub fn dlerror() -> *mut c_char;
}

// ── fcntl / flock ───────────────────────────────────────────────────────
// wasi-libc's fcntl rejects these with EINVAL, so dup paths fail cleanly.
pub const F_DUPFD: c_int = 0;
pub const F_DUPFD_CLOEXEC: c_int = 1030;
pub const LOCK_SH: c_int = 1;
pub const LOCK_EX: c_int = 2;
pub const LOCK_NB: c_int = 4;
pub const LOCK_UN: c_int = 8;
extern "C" {
    pub fn flock(fd: c_int, operation: c_int) -> c_int;
}

// ── sockets (flags p2.rs lacks) ─────────────────────────────────────────
pub const MSG_DONTWAIT: c_int = 0x40;
pub const MSG_NOSIGNAL: c_int = 0x4000;

// ── raw syscalls, hostname, statfs, ELF program headers ─────────────────
extern "C" {
    pub fn syscall(num: c_long, ...) -> c_long;
    pub fn gethostname(name: *mut c_char, len: size_t) -> c_int;
}

pub type fsblkcnt_t = u64;
pub type fsfilcnt_t = u64;
s! {
    pub struct fsid_t {
        pub __val: [c_int; 2],
    }
    pub struct statfs {
        pub f_type: c_ulong,
        pub f_bsize: c_ulong,
        pub f_blocks: fsblkcnt_t,
        pub f_bfree: fsblkcnt_t,
        pub f_bavail: fsblkcnt_t,
        pub f_files: fsfilcnt_t,
        pub f_ffree: fsfilcnt_t,
        pub f_fsid: fsid_t,
        pub f_namelen: c_ulong,
        pub f_frsize: c_ulong,
        pub f_flags: c_ulong,
        pub f_spare: [c_ulong; 4],
    }
}
extern "C" {
    pub fn statfs(path: *const c_char, buf: *mut statfs) -> c_int;
    pub fn fstatfs(fd: c_int, buf: *mut statfs) -> c_int;
}

pub type Elf32_Addr = u32;
pub type Elf32_Half = u16;
pub type Elf32_Word = u32;
pub type Elf32_Off = u32;
s! {
    pub struct Elf32_Phdr {
        pub p_type: Elf32_Word,
        pub p_offset: Elf32_Off,
        pub p_vaddr: Elf32_Addr,
        pub p_paddr: Elf32_Addr,
        pub p_filesz: Elf32_Word,
        pub p_memsz: Elf32_Word,
        pub p_flags: Elf32_Word,
        pub p_align: Elf32_Word,
    }
    pub struct dl_phdr_info {
        pub dlpi_addr: Elf32_Addr,
        pub dlpi_name: *const c_char,
        pub dlpi_phdr: *const Elf32_Phdr,
        pub dlpi_phnum: Elf32_Half,
        pub dlpi_adds: c_ulonglong,
        pub dlpi_subs: c_ulonglong,
        pub dlpi_tls_modid: size_t,
        pub dlpi_tls_data: *mut c_void,
    }
}
extern "C" {
    pub fn dl_iterate_phdr(
        callback: Option<unsafe extern "C" fn(info: *mut dl_phdr_info, size: size_t, data: *mut c_void) -> c_int>,
        data: *mut c_void,
    ) -> c_int;
}

// ── netdb.h getaddrinfo errors (musl values; p2.rs only has EAI_SYSTEM) ─
pub const EAI_BADFLAGS: c_int = -1;
pub const EAI_NONAME: c_int = -2;
pub const EAI_AGAIN: c_int = -3;
pub const EAI_FAIL: c_int = -4;
pub const EAI_NODATA: c_int = -5;
pub const EAI_FAMILY: c_int = -6;
pub const EAI_SOCKTYPE: c_int = -7;
pub const EAI_SERVICE: c_int = -8;
pub const EAI_MEMORY: c_int = -10;
pub const EAI_OVERFLOW: c_int = -12;

// ── spawn.h / wait4 (process creation always fails with ENOSYS) ─────────
pub const AF_UNIX: c_int = 3;
pub const AF_LOCAL: c_int = AF_UNIX;
pub const POSIX_SPAWN_RESETIDS: c_int = 0x01;
pub const POSIX_SPAWN_SETPGROUP: c_int = 0x02;
pub const POSIX_SPAWN_SETSIGDEF: c_int = 0x04;
pub const POSIX_SPAWN_SETSIGMASK: c_int = 0x08;
pub const POSIX_SPAWN_SETSCHEDPARAM: c_int = 0x10;
pub const POSIX_SPAWN_SETSCHEDULER: c_int = 0x20;
pub const POSIX_SPAWN_USEVFORK: c_int = 0x40;
pub const POSIX_SPAWN_SETSID: c_int = 0x80;
s! {
    pub struct posix_spawnattr_t {
        __flags: c_int,
        __pgrp: pid_t,
        __def: sigset_t,
        __mask: sigset_t,
        __prio: c_int,
        __pol: c_int,
        __fn: *mut c_void,
        __pad: [c_char; 64],
    }
    pub struct posix_spawn_file_actions_t {
        __pad0: [c_int; 2],
        __actions: *mut c_void,
        __pad: [c_int; 16],
    }
}
extern "C" {
    pub fn wait4(pid: pid_t, status: *mut c_int, options: c_int, rusage: *mut rusage) -> pid_t;
    pub fn posix_spawn(
        pid: *mut pid_t,
        path: *const c_char,
        file_actions: *const posix_spawn_file_actions_t,
        attrp: *const posix_spawnattr_t,
        argv: *const *mut c_char,
        envp: *const *mut c_char,
    ) -> c_int;
    pub fn posix_spawnp(
        pid: *mut pid_t,
        file: *const c_char,
        file_actions: *const posix_spawn_file_actions_t,
        attrp: *const posix_spawnattr_t,
        argv: *const *mut c_char,
        envp: *const *mut c_char,
    ) -> c_int;
    pub fn posix_spawnattr_init(attr: *mut posix_spawnattr_t) -> c_int;
    pub fn posix_spawnattr_destroy(attr: *mut posix_spawnattr_t) -> c_int;
    pub fn posix_spawnattr_setflags(attr: *mut posix_spawnattr_t, flags: c_short) -> c_int;
    pub fn posix_spawnattr_getflags(attr: *const posix_spawnattr_t, flags: *mut c_short) -> c_int;
    pub fn posix_spawnattr_setsigdefault(attr: *mut posix_spawnattr_t, set: *const sigset_t) -> c_int;
    pub fn posix_spawnattr_setsigmask(attr: *mut posix_spawnattr_t, set: *const sigset_t) -> c_int;
    pub fn posix_spawnattr_setpgroup(attr: *mut posix_spawnattr_t, pgroup: pid_t) -> c_int;
    pub fn posix_spawn_file_actions_init(actions: *mut posix_spawn_file_actions_t) -> c_int;
    pub fn posix_spawn_file_actions_destroy(actions: *mut posix_spawn_file_actions_t) -> c_int;
    pub fn posix_spawn_file_actions_addopen(
        actions: *mut posix_spawn_file_actions_t,
        fd: c_int,
        path: *const c_char,
        oflag: c_int,
        mode: mode_t,
    ) -> c_int;
    pub fn posix_spawn_file_actions_addclose(actions: *mut posix_spawn_file_actions_t, fd: c_int) -> c_int;
    pub fn posix_spawn_file_actions_adddup2(actions: *mut posix_spawn_file_actions_t, fd: c_int, newfd: c_int) -> c_int;
    pub fn posix_spawn_file_actions_addchdir_np(actions: *mut posix_spawn_file_actions_t, path: *const c_char) -> c_int;
    pub fn socketpair(domain: c_int, type_: c_int, protocol: c_int, sv: *mut c_int) -> c_int;
}

//! Signals, processes, users, terminals, dynamic loading: everything a WASI
//! sandbox cannot do. Queries answer like a minimal single-user system;
//! actions fail with ENOSYS. Signal state is accepted and ignored, since
//! nothing is ever delivered.
use core::ffi::{c_char, c_int, c_long, c_short, c_void};

use libc::{gid_t, mode_t, pid_t, rlimit, sigset_t, size_t, uid_t};

use crate::{fail, set_errno};

const ENOSYS: c_int = libc::ENOSYS;

// ── signals ───────────────────────────────────────────────────────────────

#[unsafe(no_mangle)]
pub extern "C" fn sigaction(_sig: c_int, _act: *const libc::sigaction, old: *mut libc::sigaction) -> c_int {
    if !old.is_null() {
        // SAFETY: caller-provided out pointer; SIG_DFL with no flags.
        unsafe { old.write(core::mem::zeroed()) };
    }
    0
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sigemptyset(set: *mut sigset_t) -> c_int {
    // SAFETY: caller-provided pointer.
    unsafe { *set = 0 };
    0
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sigfillset(set: *mut sigset_t) -> c_int {
    // SAFETY: caller-provided pointer.
    unsafe { *set = !0 };
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn sigaddset(_set: *mut sigset_t, _sig: c_int) -> c_int {
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn sigdelset(_set: *mut sigset_t, _sig: c_int) -> c_int {
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn sigismember(_set: *const sigset_t, _sig: c_int) -> c_int {
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn sigprocmask(_how: c_int, _set: *const sigset_t, _old: *mut sigset_t) -> c_int {
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn pthread_sigmask(_how: c_int, _set: *const sigset_t, _old: *mut sigset_t) -> c_int {
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn sigaltstack(_ss: *const libc::stack_t, _old: *mut libc::stack_t) -> c_int {
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn signal(_sig: c_int, _handler: libc::sighandler_t) -> libc::sighandler_t {
    libc::SIG_DFL
}
#[unsafe(no_mangle)]
pub extern "C" fn kill(pid: pid_t, sig: c_int) -> c_int {
    // Signal 0 probes for existence: only we exist.
    if sig == 0 && (pid == 0 || pid == getpid()) {
        return 0;
    }
    fail(libc::EPERM)
}
/// Every signal Bun raises is fatal; end the instance the way a trap would.
#[unsafe(no_mangle)]
pub extern "C" fn raise(sig: c_int) -> c_int {
    std::process::exit(128 + sig)
}

// ── processes ─────────────────────────────────────────────────────────────

#[unsafe(no_mangle)]
pub extern "C" fn fork() -> pid_t {
    fail(ENOSYS)
}
#[unsafe(no_mangle)]
pub extern "C" fn execve(_p: *const c_char, _a: *const *const c_char, _e: *const *const c_char) -> c_int {
    fail(ENOSYS)
}
#[unsafe(no_mangle)]
pub extern "C" fn execvp(_p: *const c_char, _a: *const *const c_char) -> c_int {
    fail(ENOSYS)
}
#[unsafe(no_mangle)]
pub extern "C" fn waitpid(_pid: pid_t, _status: *mut c_int, _options: c_int) -> pid_t {
    fail(libc::ECHILD)
}
#[unsafe(no_mangle)]
pub extern "C" fn wait4(_pid: pid_t, _status: *mut c_int, _options: c_int, _ru: *mut libc::rusage) -> pid_t {
    fail(libc::ECHILD)
}
#[unsafe(no_mangle)]
pub extern "C" fn posix_spawn(
    _pid: *mut pid_t,
    _path: *const c_char,
    _actions: *const libc::posix_spawn_file_actions_t,
    _attr: *const libc::posix_spawnattr_t,
    _argv: *const *mut c_char,
    _envp: *const *mut c_char,
) -> c_int {
    ENOSYS
}
#[unsafe(no_mangle)]
pub extern "C" fn posix_spawnp(
    _pid: *mut pid_t,
    _file: *const c_char,
    _actions: *const libc::posix_spawn_file_actions_t,
    _attr: *const libc::posix_spawnattr_t,
    _argv: *const *mut c_char,
    _envp: *const *mut c_char,
) -> c_int {
    ENOSYS
}
macro_rules! ok_zero {
    ($($name:ident($($arg:ident: $ty:ty),*);)*) => {$(
        #[unsafe(no_mangle)]
        pub extern "C" fn $name($($arg: $ty),*) -> c_int {
            let _ = ($($arg),*);
            0
        }
    )*};
}
ok_zero! {
    posix_spawnattr_init(a: *mut libc::posix_spawnattr_t);
    posix_spawnattr_destroy(a: *mut libc::posix_spawnattr_t);
    posix_spawnattr_setflags(a: *mut libc::posix_spawnattr_t, f: c_short);
    posix_spawnattr_getflags(a: *const libc::posix_spawnattr_t, f: *mut c_short);
    posix_spawnattr_setsigdefault(a: *mut libc::posix_spawnattr_t, s: *const sigset_t);
    posix_spawnattr_setsigmask(a: *mut libc::posix_spawnattr_t, s: *const sigset_t);
    posix_spawnattr_setpgroup(a: *mut libc::posix_spawnattr_t, p: pid_t);
    posix_spawn_file_actions_init(a: *mut libc::posix_spawn_file_actions_t);
    posix_spawn_file_actions_destroy(a: *mut libc::posix_spawn_file_actions_t);
    posix_spawn_file_actions_addopen(a: *mut libc::posix_spawn_file_actions_t, fd: c_int, p: *const c_char, o: c_int, m: mode_t);
    posix_spawn_file_actions_addclose(a: *mut libc::posix_spawn_file_actions_t, fd: c_int);
    posix_spawn_file_actions_adddup2(a: *mut libc::posix_spawn_file_actions_t, fd: c_int, n: c_int);
    posix_spawn_file_actions_addchdir_np(a: *mut libc::posix_spawn_file_actions_t, p: *const c_char);
}
#[unsafe(no_mangle)]
pub extern "C" fn socketpair(_d: c_int, _t: c_int, _p: c_int, _sv: *mut c_int) -> c_int {
    fail(ENOSYS)
}
#[unsafe(no_mangle)]
pub extern "C" fn pthread_exit(_value: *mut c_void) -> ! {
    // wasip1 has one thread; leaving it ends the program.
    std::process::exit(0)
}

/// A fixed pid: there is one process and it has no parent we can see.
#[unsafe(no_mangle)]
pub extern "C" fn getpid() -> pid_t {
    42
}
#[unsafe(no_mangle)]
pub extern "C" fn getppid() -> pid_t {
    1
}
#[unsafe(no_mangle)]
pub extern "C" fn getpgid(_pid: pid_t) -> pid_t {
    42
}
#[unsafe(no_mangle)]
pub extern "C" fn setsid() -> pid_t {
    fail(libc::EPERM)
}
#[unsafe(no_mangle)]
pub extern "C" fn getuid() -> uid_t {
    1000
}
#[unsafe(no_mangle)]
pub extern "C" fn geteuid() -> uid_t {
    1000
}
#[unsafe(no_mangle)]
pub extern "C" fn getgid() -> gid_t {
    1000
}
#[unsafe(no_mangle)]
pub extern "C" fn getegid() -> gid_t {
    1000
}
#[unsafe(no_mangle)]
pub extern "C" fn umask(_mask: mode_t) -> mode_t {
    0o022
}
ok_zero! {
    chown(p: *const c_char, u: uid_t, g: gid_t);
    fchown(fd: c_int, u: uid_t, g: gid_t);
    lchown(p: *const c_char, u: uid_t, g: gid_t);
    fchownat(d: c_int, p: *const c_char, u: uid_t, g: gid_t, f: c_int);
    flock(fd: c_int, op: c_int);
}

// ── terminals ─────────────────────────────────────────────────────────────

#[unsafe(no_mangle)]
pub extern "C" fn tcgetattr(_fd: c_int, _t: *mut libc::termios) -> c_int {
    fail(libc::ENOTTY)
}
#[unsafe(no_mangle)]
pub extern "C" fn tcsetattr(_fd: c_int, _a: c_int, _t: *const libc::termios) -> c_int {
    fail(libc::ENOTTY)
}
#[unsafe(no_mangle)]
pub extern "C" fn cfmakeraw(_t: *mut libc::termios) {}

// ── resource limits ───────────────────────────────────────────────────────

#[unsafe(no_mangle)]
pub unsafe extern "C" fn getrlimit(resource: c_int, rlim: *mut rlimit) -> c_int {
    // Descriptor counts get a finite answer: callers size tables from it.
    let limit = if resource == libc::RLIMIT_NOFILE { 65536 } else { libc::RLIM_INFINITY };
    // SAFETY: caller-provided out pointer.
    unsafe { rlim.write(rlimit { rlim_cur: limit, rlim_max: limit }) };
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn setrlimit(_resource: c_int, _rlim: *const rlimit) -> c_int {
    0
}

// ── users ─────────────────────────────────────────────────────────────────

#[unsafe(no_mangle)]
pub extern "C" fn getpwuid(_uid: uid_t) -> *mut libc::passwd {
    set_errno(ENOSYS);
    core::ptr::null_mut()
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn getpwuid_r(
    _uid: uid_t,
    _pwd: *mut libc::passwd,
    _buf: *mut c_char,
    _len: size_t,
    result: *mut *mut libc::passwd,
) -> c_int {
    // SAFETY: caller-provided out pointer.
    unsafe { *result = core::ptr::null_mut() };
    ENOSYS
}

// ── dynamic loading ───────────────────────────────────────────────────────

#[unsafe(no_mangle)]
pub extern "C" fn dladdr(_addr: *const c_void, _info: *mut libc::Dl_info) -> c_int {
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn dlopen(_name: *const c_char, _flag: c_int) -> *mut c_void {
    core::ptr::null_mut()
}
#[unsafe(no_mangle)]
pub extern "C" fn dlsym(_handle: *mut c_void, _symbol: *const c_char) -> *mut c_void {
    core::ptr::null_mut()
}
#[unsafe(no_mangle)]
pub extern "C" fn dlclose(_handle: *mut c_void) -> c_int {
    0
}
#[unsafe(no_mangle)]
pub extern "C" fn dlerror() -> *mut c_char {
    c"dynamic loading is not available in WASI".as_ptr().cast_mut()
}
#[unsafe(no_mangle)]
pub extern "C" fn dl_iterate_phdr(
    _callback: Option<unsafe extern "C" fn(*mut libc::dl_phdr_info, size_t, *mut c_void) -> c_int>,
    _data: *mut c_void,
) -> c_int {
    0
}

// ── file systems / raw syscalls ───────────────────────────────────────────

#[unsafe(no_mangle)]
pub extern "C" fn statfs(_path: *const c_char, _buf: *mut libc::statfs) -> c_int {
    fail(ENOSYS)
}
#[unsafe(no_mangle)]
pub extern "C" fn fstatfs(_fd: c_int, _buf: *mut libc::statfs) -> c_int {
    fail(ENOSYS)
}
/// Linux syscall numbers mean nothing here.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn syscall(_num: c_long, mut _args: ...) -> c_long {
    set_errno(ENOSYS);
    -1
}

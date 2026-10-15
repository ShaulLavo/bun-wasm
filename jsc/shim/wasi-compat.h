/* Force-included into every WebKit TU when targeting WASI: fills small wasi-libc gaps.
 * Signals: wasi-libc's emulation only has signal()/raise(). WTF wants the sigaction surface for
 * thread suspend/resume and crash handlers; on single-threaded wasip1 nothing ever delivers a
 * signal, so these are inert stand-ins (sigaction records nothing, masks are no-ops). */
#pragma once
#if defined(__wasi__)
#include <time.h>
#ifdef __cplusplus
extern "C" {
#endif
int mkostemp(char* tmpl, int flags);
char* mkdtemp(char* tmpl);
#ifdef __cplusplus
}
#endif
#ifndef CLOCK_THREAD_CPUTIME_ID
#define CLOCK_THREAD_CPUTIME_ID CLOCK_MONOTONIC
#endif

// The signal and pthread stand-ins are for WTF's C++ only. Kept out of C so CMake's C feature
// checks (which declare functions like `char pthread_create(void)`) still compile.
#ifdef __cplusplus
#include <pthread.h>
#include <sched.h>
#include <signal.h>
extern "C" {

#ifndef SA_SIGINFO
typedef struct {
    int si_signo;
    int si_errno;
    int si_code;
    void* si_addr;
} siginfo_t;

struct sigaction {
    union {
        void (*sa_handler)(int);
        void (*sa_sigaction)(int, siginfo_t*, void*);
    };
    sigset_t sa_mask;
    int sa_flags;
};

#define SA_NOCLDSTOP 1
#define SA_NOCLDWAIT 2
#define SA_SIGINFO 4
#define SA_ONSTACK 0x08000000
#define SA_RESTART 0x10000000
#define SA_NODEFER 0x40000000
#define SA_RESETHAND 0x80000000
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2

static inline int sigemptyset(sigset_t* s) { *s = 0; return 0; }
static inline int sigfillset(sigset_t* s) { *s = (sigset_t)~0; return 0; }
static inline int sigaddset(sigset_t* s, int n) { (void)s; (void)n; return 0; }
static inline int sigdelset(sigset_t* s, int n) { (void)s; (void)n; return 0; }
static inline int sigismember(const sigset_t* s, int n) { (void)s; (void)n; return 0; }
static inline int sigaction(int n, const struct sigaction* a, struct sigaction* old)
{
    (void)n; (void)a;
    if (old) { old->sa_handler = SIG_DFL; old->sa_mask = 0; old->sa_flags = 0; }
    return 0;
}
static inline int sigprocmask(int how, const sigset_t* s, sigset_t* old) { (void)how; (void)s; if (old) *old = 0; return 0; }
static inline int pthread_sigmask(int how, const sigset_t* s, sigset_t* old) { return sigprocmask(how, s, old); }
static inline int sigsuspend(const sigset_t* s) { (void)s; return -1; }
static inline int pthread_kill(pthread_t t, int n) { (void)t; (void)n; return 0; }
#endif

static inline int pthread_getschedparam(pthread_t t, int* policy, struct sched_param* p) { (void)t; if (policy) *policy = 0; if (p) p->sched_priority = 0; return 0; }
static inline int pthread_setschedparam(pthread_t t, int policy, const struct sched_param* p) { (void)t; (void)policy; (void)p; return 0; }

}
#endif // __cplusplus
#endif // __wasi__

/* Original direct embedder regression for the frame stack of ordinary bytecode
   calls (docs/bun-patches/quickjs-frame-stack.md). Drives the QuickJS engine
   without the bun-wasm runtime: frame-limit boundaries, what the allocator
   acquires and holds against what the engine charges, denied segments and
   call semantics. scripts/check-quickjs-frame-stack.ts builds and runs it.

   The contract runs on several allocators behind the same callbacks:
   - "exact": the ledger heap below growing a byte-granular break, so exact
     and small limits can be checked to the byte;
   - "paged": the same heap growing 64 KiB at a time and never shrinking,
     as wasm32 linear memory does under the product's allocator;
   - "default": the engine's own default callbacks, whose large blocks are
     private mappings, watched through this file's mmap and munmap;
   - "sanitizer", only under AddressSanitizer: libc malloc with a bound that
     makes no accounting claim, so the sanitizer sees every frame block.
   Each watches every block the frame stack takes. The engine asks the
   allocator for a block's bound immediately before it requests the block,
   which is how an allocator knows a frame block when it sees one. What a
   block made the allocator acquire, and what it occupies, are read from the
   allocator's own sources, never from that bound or the engine's count. */
#include "quickjs.h"
#include <errno.h>
#include <malloc.h>
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/auxv.h>
#include <sys/syscall.h>
#endif

#if defined(__SANITIZE_ADDRESS__)
#define SANITIZED 1
#elif defined(__has_feature)
#define SANITIZED __has_feature(address_sanitizer)
#else
#define SANITIZED 0
#endif

#define THREAD_STACK ((size_t)512 << 20)
#define AMPLE_STACK ((size_t)448 << 20)
#define DEFAULT_LIMIT ((size_t)4 << 20)
#define PAGE_64K ((size_t)65536)

/* The ledger heap: one general heap over a reserved region. A block is a
   header and its 16-byte-rounded size, taken first-fit from the free list,
   which coalesces and serves any request, or else from the break, which
   grows 'grain' bytes at a time and never shrinks. heap_end - heap_base is
   everything it has ever acquired. */
#define HEAP_RESERVE ((size_t)1 << 30)
#define HEAP_PAD ((size_t)4096) /* 'understates': taken beyond what is declared */

typedef struct Header {
    size_t extent; /* every byte this block occupies, this header included */
    struct Header *next;
} Header;

/* What the allocator answers when asked for a bound. */
enum { DECLARE_HONEST, DECLARE_ZERO, DECLARE_SHORT, DECLARE_HUGE, DECLARE_REQUEST };
enum { BACKING_LEDGER, BACKING_DEFAULT, BACKING_LIBC };

typedef struct {
    const char *name;
    int backing;
    size_t grain;   /* ledger: the step its break grows by */
    int byte_exact; /* a block costs about what it asks for, so small limits fit */
    int precise;    /* a frame block occupies exactly what is declared for it */
    int claims;     /* the declared bound is a real statement about backing */
    int declares;
} Profile;

typedef struct { void *block; size_t bytes, declared; } FrameBlock;

typedef struct {
    const Profile *profile;
    JSRuntime *rt;
    int declares;    /* DECLARE_* */
    int understates; /* ledger: every block takes HEAP_PAD more than declared */
    int blind;       /* the usable-size callback answers zero */
    int meddles;     /* the bound callback tries to change the runtime's settings */
    long meddled;    /* how many of those attempts were accepted */
    long live;       /* blocks the engine holds */
    /* the last bound asked for, and whether the very next call may be the
       request it was asked about */
    size_t offered, offered_bound;
    int armed;
    /* offers the engine did not follow with a request */
    long declined;
    size_t declined_largest;
    /* blocks the frame stack requested */
    long frame_requests, fail_at, denied, frame_live, untracked;
    long frame_cold, frame_warm;          /* requests that did and did not acquire backing */
    long over_declared;                   /* requests that acquired more than declared */
    size_t frame_bytes, frame_peak;       /* what the held blocks occupy */
    size_t frame_declared, declared_peak; /* what was declared for them */
    size_t frame_largest, declared_largest;
    size_t limit;    /* the frame limit in force */
    long over_limit; /* requests that left more held than the limit */
    FrameBlock frames[4096];
} Allocator;
typedef struct { int argc; char **argv; int status; } Job;

/* Only for taking the semantics golden from the engine before the change,
   which has no frame stack: `run` mode never depends on these values. */
#ifdef QUICKJS_FRAME_STACK_BASELINE
typedef size_t JSMallocBoundFunc(void *opaque, size_t size);
int JS_SetMaxFrameStackSize(JSRuntime *rt, size_t bytes) { return 0; }
void JS_GetFrameStackUsage(JSRuntime *rt, size_t *plive, size_t *pcommitted, size_t *plimit)
{
    *plive = *pcommitted = *plimit = 0;
}
int JS_SetMallocBound(JSRuntime *rt, JSMallocBoundFunc *bound) { return 0; }
size_t JS_DefaultMallocBound(void *opaque, size_t size) { return 0; }
const JSMallocFunctions *JS_GetDefaultMallocFunctions(void) { return NULL; }
#endif

static Allocator memory;
static const Profile *profile;
static int checks, failures;
static JSContext *other_context;
static char *heap_base, *heap_brk, *heap_end;
static Header *heap_free;
static size_t mapped_ever, mapped_now; /* through this file's mmap and munmap */
static int mapping_fails;              /* this file's mmap refuses */
static int unmapping_fails;
static long page_size_answer;

static void check(int ok, const char *label)
{
    checks++;
    if (ok)
        return;
    failures++;
    fprintf(stderr, "FAIL [%s]: %s\n", profile ? profile->name : "setup", label);
}

/* Linux, and not under a sanitizer, which has its own versions: this file's
   mmap and munmap see every mapping the engine's default callbacks make,
   and its sysconf can make the page size unreadable or senseless. */
#if defined(__linux__) && !SANITIZED
#define HOST_WATCH 1
extern long __sysconf(int name);

void *mmap(void *addr, size_t length, int prot, int flags, int fd, off_t offset)
{
    void *p = mapping_fails ? MAP_FAILED : (void *)syscall(SYS_mmap, addr, length, prot, flags, fd, offset);
    if (p != MAP_FAILED) {
        mapped_ever += length;
        mapped_now += length;
    }
    return p;
}

int munmap(void *addr, size_t length)
{
    int result;
    if (unmapping_fails) {
        errno = ENOMEM;
        return -1;
    }
    result = (int)syscall(SYS_munmap, addr, length);
    if (result == 0)
        mapped_now -= length;
    return result;
}

long sysconf(int name)
{
    if (name != _SC_PAGESIZE)
        return __sysconf(name);
    return page_size_answer ? page_size_answer : (long)getauxval(AT_PAGESZ);
}
#else
#define HOST_WATCH 0
#endif

static size_t round_up(size_t size, size_t step)
{
    return (size + step - 1) / step * step;
}

/* What a block of 'size' bytes occupies in the ledger heap, as declared. */
static size_t heap_extent(size_t size)
{
    if (size > SIZE_MAX / 4)
        return 0;
    return sizeof(Header) + round_up(size, 16);
}

/* What the ledger heap declares for a request: its break can have to grow
   by the whole block, in steps of the grain. */
static size_t heap_bound(const Allocator *a, size_t size)
{
    size_t extent = heap_extent(size);
    return extent ? round_up(extent, a->profile->grain) : 0;
}

/* First fit. A block is split so that it occupies exactly its extent; a
   remainder too small to carry a header leaves the block for a later fit. */
static Header *heap_reuse(size_t extent)
{
    Header **link = &heap_free;
    Header *h, *rest;
    for (h = *link; h; h = *link) {
        if (h->extent == extent || h->extent >= extent + sizeof(Header))
            break;
        link = &h->next;
    }
    if (!h)
        return NULL;
    if (h->extent == extent) {
        *link = h->next;
        return h;
    }
    rest = (Header *)((char *)h + extent);
    rest->extent = h->extent - extent;
    rest->next = h->next;
    *link = rest;
    h->extent = extent;
    return h;
}

static Header *heap_grow(const Allocator *a, size_t extent)
{
    size_t room = (size_t)(heap_end - heap_brk);
    size_t step = extent > room ? round_up(extent - room, a->profile->grain) : 0;
    Header *h = (Header *)heap_brk;
    if (step > (size_t)(heap_base + HEAP_RESERVE - heap_end))
        return NULL;
    heap_end += step;
    heap_brk += extent;
    h->extent = extent;
    return h;
}

static void *heap_take(const Allocator *a, size_t size)
{
    size_t extent = heap_extent(size);
    Header *h;
    if (!extent)
        return NULL;
    /* the understating heap occupies more than heap_bound() declares */
    if (a->understates)
        extent += HEAP_PAD;
    h = heap_reuse(extent);
    if (!h)
        h = heap_grow(a, extent);
    return h ? h + 1 : NULL;
}

/* Back into the address-ordered free list, joined to its neighbours. */
static void heap_give(void *p)
{
    Header *h = (Header *)p - 1;
    Header **link = &heap_free;
    Header *prev = NULL, *next;
    for (next = *link; next && next < h; next = *link) {
        prev = next;
        link = &next->next;
    }
    h->next = next;
    *link = h;
    if (next && (char *)h + h->extent == (char *)next) {
        h->extent += next->extent;
        h->next = next->next;
    }
    if (prev && (char *)prev + prev->extent == (char *)h) {
        prev->extent += h->extent;
        prev->next = h->next;
    }
}

/* Everything the allocators here have ever acquired from their sources. */
static size_t source_acquired(void)
{
    return (size_t)(heap_end - heap_base) + mapped_ever;
}

static void *backing_take(const Allocator *a, size_t size)
{
    if (a->profile->backing == BACKING_LEDGER)
        return heap_take(a, size);
    if (a->profile->backing == BACKING_DEFAULT)
        return JS_GetDefaultMallocFunctions()->js_malloc(NULL, size);
    return malloc(size);
}

static void backing_give(const Allocator *a, void *p)
{
    if (a->profile->backing == BACKING_LEDGER)
        heap_give(p);
    else if (a->profile->backing == BACKING_DEFAULT)
        JS_GetDefaultMallocFunctions()->js_free(NULL, p);
    else
        free(p);
}

static size_t backing_usable(const Allocator *a, const void *p)
{
    if (a->profile->backing == BACKING_LEDGER)
        return ((const Header *)p - 1)->extent - sizeof(Header);
    if (a->profile->backing == BACKING_DEFAULT)
        return JS_GetDefaultMallocFunctions()->js_malloc_usable_size(p);
    return malloc_usable_size((void *)p);
}

/* An offer the engine did not take up: it asked what a block would cost
   and then requested something else, or nothing. */
static void settle(Allocator *a)
{
    if (!a->armed)
        return;
    a->armed = 0;
    a->declined++;
    if (a->offered > a->declined_largest)
        a->declined_largest = a->offered;
}

/* What one frame block occupies in its allocator. The ledger heap knows;
   a default mapping is what this file's mmap saw; libc can only report. */
static size_t occupied(const Allocator *a, void *p, size_t acquired)
{
    if (a->profile->backing == BACKING_LEDGER)
        return ((Header *)p - 1)->extent;
    if (a->profile->backing == BACKING_DEFAULT && HOST_WATCH)
        return acquired;
    return backing_usable(a, p);
}

static void note_frame(Allocator *a, void *p, size_t acquired)
{
    FrameBlock *slot;
    if (acquired > a->offered_bound)
        a->over_declared++;
    if (acquired)
        a->frame_cold++;
    else
        a->frame_warm++;
    if (a->frame_live >= 4096) {
        a->untracked++;
        return;
    }
    slot = &a->frames[a->frame_live++];
    slot->block = p;
    slot->bytes = occupied(a, p, acquired);
    slot->declared = a->offered_bound;
    a->frame_bytes += slot->bytes;
    a->frame_declared += slot->declared;
    if (a->frame_bytes > a->frame_peak)
        a->frame_peak = a->frame_bytes;
    if (a->frame_declared > a->declared_peak)
        a->declared_peak = a->frame_declared;
    if (slot->declared > a->declared_largest)
        a->declared_largest = slot->declared;
    if (a->frame_declared > a->limit || (a->profile->claims && a->frame_bytes > a->limit))
        a->over_limit++;
}

/* Whether 'p' was a frame block, which is then forgotten. */
static int forget_frame(Allocator *a, void *p)
{
    long i;
    for (i = 0; i < a->frame_live; i++) {
        if (a->frames[i].block != p)
            continue;
        a->frame_bytes -= a->frames[i].bytes;
        a->frame_declared -= a->frames[i].declared;
        a->frames[i] = a->frames[--a->frame_live];
        return 1;
    }
    return 0;
}

static size_t honest_bound(const Allocator *a, size_t size)
{
    if (a->profile->backing == BACKING_LEDGER)
        return heap_bound(a, size);
    if (a->profile->backing == BACKING_DEFAULT)
        return JS_DefaultMallocBound(NULL, size);
    return 0;
}

static size_t declare(void *opaque, size_t size)
{
    Allocator *a = opaque;
    size_t bound = 0;
    settle(a);
    if (a->declares == DECLARE_HONEST)
        bound = honest_bound(a, size);
    if (a->declares == DECLARE_SHORT)
        bound = size - 1;
    if (a->declares == DECLARE_HUGE)
        bound = SIZE_MAX;
    /* no statement about backing: only for the sanitizer's own run */
    if (a->declares == DECLARE_REQUEST)
        bound = size;
    /* a bound function must not do this; the engine refuses it anyway */
    if (a->meddles) {
        a->meddled += JS_SetMallocBound(a->rt, NULL) == 0;
        a->meddled += JS_SetMaxFrameStackSize(a->rt, DEFAULT_LIMIT) == 0;
    }
    a->offered = size;
    a->offered_bound = bound;
    a->armed = 1;
    return bound;
}

static void *allocate(void *opaque, size_t size)
{
    Allocator *a = opaque;
    int frame = a->armed && size == a->offered;
    size_t before = source_acquired();
    void *p;
    if (frame)
        a->armed = 0;
    settle(a);
    if (frame && size > a->frame_largest)
        a->frame_largest = size;
    if (frame && ++a->frame_requests == a->fail_at) {
        a->denied++;
        return NULL;
    }
    p = backing_take(a, size);
    if (!p)
        return NULL;
    a->live++;
    if (frame)
        note_frame(a, p, source_acquired() - before);
    return p;
}

static void *allocate_zero(void *opaque, size_t count, size_t size)
{
    void *p = allocate(opaque, count * size);
    if (p)
        memset(p, 0, count * size);
    return p;
}

static void release(void *opaque, void *p)
{
    Allocator *a = opaque;
    int frame;
    if (!p)
        return;
    settle(a);
    frame = forget_frame(a, p);
    a->live--;
    backing_give(a, p);
    if (frame && a->meddles) {
        a->meddled += JS_SetMallocBound(a->rt, NULL) == 0;
        a->meddled += JS_SetMaxFrameStackSize(a->rt, DEFAULT_LIMIT) == 0;
    }
}

static void *resize(void *opaque, void *p, size_t size)
{
    Allocator *a = opaque;
    size_t usable;
    void *q;
    if (!p)
        return allocate(opaque, size);
    if (!size) {
        release(opaque, p);
        return NULL;
    }
    settle(a);
    if (a->profile->backing == BACKING_DEFAULT)
        return JS_GetDefaultMallocFunctions()->js_realloc(NULL, p, size);
    if (a->profile->backing == BACKING_LIBC)
        return realloc(p, size);
    usable = backing_usable(a, p);
    if (size <= usable)
        return p;
    q = heap_take(a, size);
    if (!q)
        return NULL;
    memcpy(q, p, usable);
    heap_give(p);
    return q;
}

static size_t usable_size(const void *p)
{
    return memory.blind ? 0 : backing_usable(&memory, p);
}

static const JSMallocFunctions allocator = {
    allocate_zero, allocate, release, resize, usable_size
};

/* Forgets peaks and counts, not the blocks still held. */
static void observe_from_here(void)
{
    settle(&memory);
    memory.frame_peak = memory.frame_bytes;
    memory.declared_peak = memory.frame_declared;
    memory.frame_largest = memory.declared_largest = memory.declined_largest = 0;
    memory.declined = memory.frame_cold = memory.frame_warm = 0;
}

static char *read_file(const char *path, size_t *plen)
{
    FILE *f = fopen(path, "rb");
    char *buf;
    long len;
    if (!f) {
        fprintf(stderr, "cannot read %s\n", path);
        exit(2);
    }
    fseek(f, 0, SEEK_END);
    len = ftell(f);
    fseek(f, 0, SEEK_SET);
    buf = malloc((size_t)len + 1);
    if (fread(buf, 1, (size_t)len, f) != (size_t)len)
        exit(2);
    buf[len] = 0;
    fclose(f);
    *plen = (size_t)len;
    return buf;
}

static JSValue print(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int i;
    for (i = 0; i < argc; i++) {
        const char *text = JS_ToCString(ctx, argv[i]);
        if (!text)
            return JS_EXCEPTION;
        fputs(i ? " " : "", stdout);
        fputs(text, stdout);
        JS_FreeCString(ctx, text);
    }
    fputc('\n', stdout);
    return JS_UNDEFINED;
}

static JSValue collect(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    JS_RunGC(JS_GetRuntime(ctx));
    return JS_UNDEFINED;
}

/* callWith(fn, thisValue, ...args): a C caller passing its own argument vector */
static JSValue call_with(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    if (argc < 2)
        return JS_ThrowTypeError(ctx, "callWith needs a function and a receiver");
    return JS_Call(ctx, argv[0], argv[1], argc - 2, argv + 2);
}

/* otherRealm(source): evaluates in a second context of the same runtime */
static JSValue other_realm(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t len;
    const char *source = JS_ToCStringLen(ctx, &len, argv[0]);
    JSValue value;
    if (!source)
        return JS_EXCEPTION;
    value = JS_Eval(other_context, source, len, "other-realm.js", JS_EVAL_TYPE_GLOBAL);
    JS_FreeCString(ctx, source);
    if (JS_IsException(value))
        return JS_Throw(ctx, JS_GetException(other_context));
    return value;
}

/* frameUsage(): [live, committed, limit] bytes of the frame stack right now */
static JSValue frame_usage(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    size_t live, committed, limit;
    JSValue result = JS_NewArray(ctx);
    JS_GetFrameStackUsage(JS_GetRuntime(ctx), &live, &committed, &limit);
    JS_SetPropertyUint32(ctx, result, 0, JS_NewInt64(ctx, (int64_t)live));
    JS_SetPropertyUint32(ctx, result, 1, JS_NewInt64(ctx, (int64_t)committed));
    JS_SetPropertyUint32(ctx, result, 2, JS_NewInt64(ctx, (int64_t)limit));
    return result;
}

/* Sets the frame limit and tells the allocator, which checks every frame
   block against it. */
static int set_limit(JSRuntime *rt, size_t bytes)
{
    int status = JS_SetMaxFrameStackSize(rt, bytes);
    if (status == 0)
        memory.limit = bytes;
    return status;
}

/* setFrameLimit(bytes): the setter's return value, callable while frames are live */
static JSValue set_frame_limit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t bytes;
    if (JS_ToInt64(ctx, &bytes, argv[0]))
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, set_limit(JS_GetRuntime(ctx), (size_t)bytes));
}

/* What the allocator holds for the frame stack against what the engine
   charges: the engine's count is the sum of the bounds declared for the
   blocks still held, it is within the limit, and the blocks occupy no more
   than that. On a precise allocator they occupy exactly that. */
static int held_agrees(JSRuntime *rt)
{
    size_t live, committed, limit;
    JS_GetFrameStackUsage(rt, &live, &committed, &limit);
    if (memory.untracked || memory.frame_declared != committed || committed > limit)
        return 0;
    if (!profile->claims)
        return 1;
    return profile->precise ? memory.frame_bytes == committed : memory.frame_bytes <= committed;
}

/* heldAgrees(): that comparison while frames are live */
static JSValue held_agrees_now(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    return JS_NewInt32(ctx, held_agrees(JS_GetRuntime(ctx)));
}

/* redeclare(): the bound setter's return value while frames are live */
static JSValue redeclare(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    return JS_NewInt32(ctx, JS_SetMallocBound(JS_GetRuntime(ctx), declare));
}

static void install(JSContext *ctx)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "print", JS_NewCFunction(ctx, print, "print", 1));
    JS_SetPropertyStr(ctx, global, "collectGarbage",JS_NewCFunction(ctx, collect, "collectGarbage", 0));
    JS_SetPropertyStr(ctx, global, "callWith", JS_NewCFunction(ctx, call_with, "callWith", 2));
    JS_SetPropertyStr(ctx, global, "otherRealm", JS_NewCFunction(ctx, other_realm, "otherRealm", 1));
    JS_SetPropertyStr(ctx, global, "frameUsage", JS_NewCFunction(ctx, frame_usage, "frameUsage", 0));
    JS_SetPropertyStr(ctx, global, "setFrameLimit", JS_NewCFunction(ctx, set_frame_limit, "setFrameLimit", 1));
    JS_SetPropertyStr(ctx, global, "heldAgrees", JS_NewCFunction(ctx, held_agrees_now, "heldAgrees", 0));
    JS_SetPropertyStr(ctx, global, "redeclare", JS_NewCFunction(ctx, redeclare, "redeclare", 0));
    JS_FreeValue(ctx, global);
}

static JSContext *finish_context(JSRuntime *rt, JSRuntime **prt)
{
    JSContext *ctx = JS_NewContext(rt);
    JS_UpdateStackTop(rt);
    JS_SetMaxStackSize(rt, AMPLE_STACK);
    install(ctx);
    other_context = JS_NewContext(rt);
    install(other_context);
    *prt = rt;
    return ctx;
}

/* A runtime on the watching allocator. 'declared' is whether the allocator
   states its bound, which JS_NewRuntime2 never does for it. */
static JSContext *new_context(JSRuntime **prt, const Profile *chosen, int declared, int blind)
{
    JSRuntime *rt;
    profile = chosen;
    memset(&memory, 0, sizeof(memory));
    memory.profile = chosen;
    memory.declares = chosen->declares;
    memory.blind = blind;
    memory.fail_at = -1;
    memory.limit = DEFAULT_LIMIT;
    rt = JS_NewRuntime2(&allocator, &memory);
    memory.rt = rt;
    if (declared)
        JS_SetMallocBound(rt, declare);
    return finish_context(rt, prt);
}

static void free_context(JSRuntime *rt, JSContext *ctx)
{
    JS_FreeContext(other_context);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

/* Formats the pending exception as "Name: message" on one line. */
static void describe_exception(JSContext *ctx, char *out, size_t size)
{
    JSValue error = JS_GetException(ctx);
    const char *text = JS_ToCString(ctx, error);
    snprintf(out, size, "%s", text ? text : "<unprintable>");
    if (text)
        JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, error);
}

static int drain(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    JSContext *job_ctx;
    char text[1024];
    while (JS_IsJobPending(rt)) {
        if (JS_ExecutePendingJob(rt, &job_ctx) >= 0)
            continue;
        describe_exception(job_ctx, text, sizeof(text));
        printf("job error %s\n", text);
        return -1;
    }
    return 0;
}

static const Profile exact_profile = { "exact", BACKING_LEDGER, 16, 1, 1, 1, DECLARE_HONEST };
static const Profile paged_profile = { "paged", BACKING_LEDGER, PAGE_64K, 0, 0, 1, DECLARE_HONEST };
static const Profile default_profile = { "default", BACKING_DEFAULT, 0, 0, HOST_WATCH, 1, DECLARE_HONEST };
static const Profile libc_profile = { "libc", BACKING_LIBC, 0, 0, 0, 1, DECLARE_HONEST };
static const Profile sanitizer_profile = { "sanitizer", BACKING_LIBC, 0, 1, 0, 0, DECLARE_REQUEST };

/* run FILE: evaluates a script that reports through print(), on the
   engine's default runtime, or under a sanitizer on libc blocks it can see. */
static int mode_run(char **argv)
{
    JSRuntime *rt;
    JSContext *ctx;
    size_t len;
    char *text = read_file(argv[0], &len);
    JSValue value;
    char description[1024];
    int status = 0;
#if SANITIZED
    ctx = new_context(&rt, &sanitizer_profile, 1, 0);
#else
    ctx = finish_context(JS_NewRuntime(), &rt);
#endif
    value = JS_Eval(ctx, text, len, "frames.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(value)) {
        describe_exception(ctx, description, sizeof(description));
        printf("uncaught %s\n", description);
        status = 1;
    }
    JS_FreeValue(ctx, value);
    status |= drain(ctx) < 0;
    free_context(rt, ctx);
    free(text);
    return status;
}

enum {
    DONE,       /* evaluated to the expected int */
    REFUSED,    /* RangeError: Maximum call stack size exceeded */
    NO_MEMORY,  /* InternalError: out of memory */
    OTHER,
    INTERRUPTED,
    NO_BOUND,   /* the allocator declares no bound for the block */
    BROKEN,     /* the allocator reported more than it declared */
};

static int classify(const char *text)
{
    if (!strcmp(text, "RangeError: Maximum call stack size exceeded"))
        return REFUSED;
    if (!strncmp(text, "InternalError: out of memory", 28))
        return NO_MEMORY;
    if (!strcmp(text, "InternalError: interrupted"))
        return INTERRUPTED;
    if (!strcmp(text, "InternalError: no allocator block bound for frame storage"))
        return NO_BOUND;
    if (!strcmp(text, "InternalError: allocator exceeded its declared block bound"))
        return BROKEN;
    fprintf(stderr, "unexpected: %.300s\n", text);
    return OTHER;
}

static int outcome(JSContext *ctx, const char *source, int expected)
{
    JSValue value = JS_Eval(ctx, source, strlen(source), "contract.js", JS_EVAL_TYPE_GLOBAL);
    char text[1024];
    int result = OTHER;
    if (JS_IsException(value)) {
        describe_exception(ctx, text, sizeof(text));
        result = classify(text);
    } else if (JS_VALUE_GET_TAG(value) == JS_TAG_INT && JS_VALUE_GET_INT(value) == expected) {
        result = DONE;
    } else {
        fprintf(stderr, "unexpected value for %.80s\n", source);
    }
    JS_FreeValue(ctx, value);
    settle(&memory);
    return result;
}

static void usage(JSRuntime *rt, size_t *plive, size_t *pcommitted)
{
    size_t limit;
    JS_GetFrameStackUsage(rt, plive, pcommitted, &limit);
}

/* Releases the idle spare, then sets 'bytes' as the limit. */
static int trim_to(JSRuntime *rt, size_t bytes)
{
    return set_limit(rt, 0) == 0 && set_limit(rt, bytes) == 0;
}

#define SHALLOW "(function () { return 21 * 2; })()"
#define DEEP "(function f(n) { return n === 0 ? 0 : 1 + f(n - 1); })(4000)"

/* An allocator that acquires 64 KiB at a time cannot serve a frame within
   a smaller limit, so the call is refused and the allocator is never asked
   for a block. Before the bound was declared, this call took a pooled cell
   and left a 4,000-byte arena behind a count of 216 under a 1,024-byte
   limit. */
static void limit_below_one_step(JSRuntime *rt, JSContext *ctx)
{
    long requests = memory.frame_requests;
    size_t live, committed;
    check(outcome(ctx, SHALLOW, 42) == REFUSED, "a limit below one growth step refuses the call as a stack overflow");
    check(memory.frame_requests == requests && memory.frame_bytes == 0, "the refused call requested no block");
    check(memory.declined > 0, "the allocator was asked what the block would cost");
    usage(rt, &live, &committed);
    check(live == 0 && committed == 0, "nothing is charged after the refusal");
}

/* A byte-exact allocator serves a small frame in a few hundred bytes. */
static void small_limit_fits(JSRuntime *rt, JSContext *ctx)
{
    size_t live, committed;
    check(outcome(ctx, SHALLOW, 42) == DONE, "a small limit still fits a small frame exactly");
    usage(rt, &live, &committed);
    check(committed <= 1024, "the committed count never exceeds the limit");
    check(committed > 0 && held_agrees(rt), "the small chunk kept as the spare is charged what it holds");
    check(memory.declared_peak <= 1024, "the blocks were never declared to cost more than the small limit");
    check(outcome(ctx, DEEP, 4000) == REFUSED, "a deep chain is refused at a small limit");
    check(outcome(ctx, SHALLOW, 42) == DONE, "a shallow call works after that refusal");
}

static size_t segment_charge;

/* Zero, tiny, exact and invalid limits, and recovery after each refusal. */
static void limit_boundaries(JSRuntime *rt, JSContext *ctx)
{
    size_t live, committed, default_limit, ignored;
    JS_GetFrameStackUsage(rt, &live, &committed, &default_limit);
    check(live == 0 && committed == 0, "no frame storage before the first call");
    check(default_limit == DEFAULT_LIMIT, "the default limit is 4 MiB");
    check(set_limit(rt, default_limit * 2 + 1) == -1, "a limit above the supported range is refused");
    check(set_limit(rt, default_limit + 1) == -1, "one byte above the default is refused: the maximum is the default");
    JS_GetFrameStackUsage(rt, &live, &committed, &ignored);
    check(ignored == default_limit, "a refused limit changes nothing");

    check(set_limit(rt, 0) == 0, "zero is a valid limit");
    check(outcome(ctx, SHALLOW, 42) == REFUSED, "no ordinary call fits a zero limit");
    usage(rt, &live, &committed);
    check(live == 0 && committed == 0, "a refused call leaves no storage behind");
    check(set_limit(rt, 1) == 0 && outcome(ctx, SHALLOW, 42) == REFUSED, "a one-byte limit refuses at entry");
    check(set_limit(rt, 64) == 0 && outcome(ctx, SHALLOW, 42) == REFUSED, "a limit below one record refuses at entry");
    check(memory.frame_requests == 0, "none of those refusals requested a block");

    check(set_limit(rt, default_limit) == 0 && outcome(ctx, SHALLOW, 42) == DONE, "calls work again once the limit is restored");
    usage(rt, &live, &committed);
    segment_charge = committed;
    check(live == 0 && segment_charge > 0, "one emptied segment is kept, and it is charged");
    check(memory.frame_live == 1 && held_agrees(rt), "the allocator holds that one segment and no more than is charged");
    check(memory.frame_largest == PAGE_64K - 256, "a segment is one request of 64 KiB less 256 bytes");

    check(set_limit(rt, segment_charge) == 0 && outcome(ctx, SHALLOW, 42) == DONE, "a limit of exactly one segment's charge fits a small call");
    check(set_limit(rt, segment_charge - 1) == 0, "lowering the limit below the idle spare releases it");
    usage(rt, &live, &committed);
    check(committed == 0 && memory.frame_live == 0, "the released spare is no longer charged or held");
    observe_from_here();
    if (profile->byte_exact) {
        /* a segment no longer fits, so the remaining budget is offered as an exact-fit chunk */
        check(outcome(ctx, SHALLOW, 42) == DONE, "one byte under a segment's charge still fits a small frame exactly");
        usage(rt, &live, &committed);
        check(committed < segment_charge && held_agrees(rt), "the exact-fit chunk costs less than a segment");
    } else {
        limit_below_one_step(rt, ctx);
    }

    observe_from_here();
    check(trim_to(rt, 1024), "a 1,024-byte limit is accepted");
    if (profile->byte_exact)
        small_limit_fits(rt, ctx);
    else
        limit_below_one_step(rt, ctx);
    check(set_limit(rt, default_limit) == 0 && outcome(ctx, SHALLOW, 42) == DONE, "the default limit is restored and calls work");
}

/* Segment growth, release, the spare, and agreement with what the allocator holds. */
static void chunk_accounting(JSRuntime *rt, JSContext *ctx)
{
    static const char probe[] =
        "(function f(n) { if (n === 0) { const u = frameUsage(); return u[1] > 4 * 65536 ? heldAgrees() : 0; } return f(n - 1); })(4000)";
    static const char shrink[] =
        "(function f(n) { return n === 0 ? setFrameLimit(0) : f(n - 1); })(50)";
    static const char large[] =
        "(function () { var s = 'var t = 0;'; for (var i = 0; i < 5300; i++) s += 'var v' + i + ' = ' + i + ';';"
        " s += 'return function () { return v0 + v5299; };'; return new Function(s)()(); })()";
    size_t live, committed, spare, acquired;

    check(trim_to(rt, 2 * 1024 * 1024), "storage is trimmed and a known limit is set");
    observe_from_here();
    check(outcome(ctx, SHALLOW, 42) == DONE, "a first call takes one segment");
    usage(rt, &live, &spare);
    check(memory.frame_live == 1 && held_agrees(rt), "the allocator holds exactly one segment, as charged");
    check(outcome(ctx, probe, 1) == DONE, "a deep chain commits several segments, and the allocator holds what is charged while it runs");
    usage(rt, &live, &committed);
    check(live == 0 && committed == spare, "unwinding releases every segment but one spare");
    check(memory.frame_live == 1 && held_agrees(rt), "after unwinding the allocator again holds one segment, as charged");
    check(memory.frame_peak <= memory.declared_peak && memory.declared_peak <= 2 * 1024 * 1024, "at its peak the chain held no more than was declared, within the limit");
    check(memory.over_declared == 0, "no segment made the allocator acquire more than it declared");
    check(outcome(ctx, shrink, -1) == DONE, "a limit below what live frames hold is refused and changes nothing");
    check(outcome(ctx, large, 5299) == DONE, "a frame larger than a segment gets a larger one of its own");
    usage(rt, &live, &committed);
    check(live == 0 && committed <= spare, "a large emptied segment is released, not kept as the spare");
    check(memory.frame_live <= 1 && held_agrees(rt), "the allocator no longer holds the large segment");
    check(outcome(ctx, SHALLOW, 42) == DONE, "a small call follows a large one");

    /* warm: a heap that kept what it acquired serves the same chain again without acquiring */
    check(trim_to(rt, 2 * 1024 * 1024), "every segment is given back to the allocator");
    check(memory.frame_live == 0 && memory.frame_bytes == 0, "the allocator holds no frame block after the trim");
    acquired = source_acquired();
    observe_from_here();
    check(outcome(ctx, probe, 1) == DONE, "the deep chain runs again after the trim");
    if (profile->backing == BACKING_LEDGER) {
        check(source_acquired() == acquired && memory.frame_cold == 0 && memory.frame_warm > 4, "a heap that keeps freed storage serves it again without acquiring more");
        check(memory.declared_peak > 4 * PAGE_64K, "and each reused segment is still charged its full bound");
    }
    if (profile->backing == BACKING_DEFAULT && HOST_WATCH)
        check(memory.frame_warm == 0 && memory.frame_cold > 4, "a mapping per segment is acquired again every time, and charged exactly");
}

/* Denies each segment allocation of a deep chain in turn. */
static void chunk_faults(JSRuntime *rt, JSContext *ctx)
{
    size_t live, committed, snapshot;
    long total, index, held, reported = 0;

    check(trim_to(rt, 2 * 1024 * 1024), "storage is trimmed before the fault sweep");
    memory.frame_requests = 0;
    check(outcome(ctx, DEEP, 4000) == DONE, "the deep chain runs without faults");
    total = memory.frame_requests;
    check(total >= 4, "the deep chain needs several segments");
    for (index = 1; index <= total; index++) {
        check(trim_to(rt, 2 * 1024 * 1024), "storage is trimmed before a fault");
        memory.frame_requests = 0;
        memory.fail_at = index;
        observe_from_here();
        reported += outcome(ctx, DEEP, 4000) == NO_MEMORY;
        memory.fail_at = -1;
        /* the denied request added nothing: the peak is the segments granted before it */
        held = index - 1;
        snapshot = (size_t)held * segment_charge;
        check(memory.declared_peak == snapshot, "a denied segment was never charged");
        usage(rt, &live, &committed);
        check(live == 0, "a denied segment leaves no live frame");
        check(held_agrees(rt), "after a denied segment the allocator holds what is charged");
        check(outcome(ctx, DEEP, 4000) == DONE, "the same chain runs after a denied segment");
    }
    check(total > 0 && reported == total && memory.denied == total, "every denied segment is reported as out of memory");
    printf("%s faults segments %ld reported %ld\n", profile->name, total, reported);
}

/* Calls that still recurse natively are refused by the native guard, with a
   frame limit far out of reach: through a native function, through a
   constructor, and from a generator, which is never an inline caller. */
static void native_guard(JSRuntime *rt, JSContext *ctx)
{
    static const char *const unbounded[] = {
        "(function f() { return 1 + [0].map(f)[0]; })()",
        "(function F() { return new F(); })()",
        "(function f() { return 1 + f.call(null); })()",
        "(function () { function* g() { yield* g(); } return g().next().value; })()",
        "(function f() { return 1 + inner(); function inner() { return [0].map(f)[0]; } })()",
    };
    size_t live, committed, index;
    check(set_limit(rt, 4 * 1024 * 1024) == 0, "the frame limit is put out of reach of the native checks");
    JS_UpdateStackTop(rt);
    JS_SetMaxStackSize(rt, 256 * 1024);
    for (index = 0; index < sizeof(unbounded) / sizeof(unbounded[0]); index++) {
        check(outcome(ctx, unbounded[index], 0) == REFUSED, "unbounded native recursion is refused with RangeError");
        usage(rt, &live, &committed);
        check(live == 0, "the refused recursion released its frames");
        check(outcome(ctx, SHALLOW, 42) == DONE, "a shallow call works after the refusal");
    }
    JS_SetMaxStackSize(rt, AMPLE_STACK);
    check(set_limit(rt, 2 * 1024 * 1024) == 0, "the frame limit is restored");
}

typedef struct { long calls, stop_at; } Interrupt;

static int interrupt(JSRuntime *rt, void *opaque)
{
    Interrupt *state = opaque;
    return ++state->calls == state->stop_at;
}

/* An ordinary function calling an ordinary function takes no native stack:
   the frame limit alone bounds it, refuses it and lets it be interrupted. */
static void inline_calls(JSRuntime *rt, JSContext *ctx)
{
    /* each line is one call shape the dispatch loop enters without a C call */
    static const char *const deep[] = {
        "(function f(n) { return n === 0 ? 0 : 1 + f(n - 1); })(6000)",
        "(function () { 'use strict'; function f(n, total) { return n === 0 ? total : f(n - 1, total + 1); } return f(6000, 0); })()",
        "(function () { function even(n) { return n === 0 ? 0 : 1 + odd(n - 1); } function odd(n) { return 1 + even(n - 1); } return even(6000); })()",
        "(function () { var o = { m: function (n) { return n === 0 ? 0 : 1 + this.m(n - 1); } }; return o.m(6000); })()",
        "(function () { 'use strict'; var o = { m(n, total) { return n === 0 ? total : this.m(n - 1, total + 1); } }; return o.m(6000, 0); })()",
        "(function f(n, a, b, c) { return n === 0 ? 0 : 1 + f(n - 1); })(6000)",
        "(function f(n) { return n === 0 ? 0 : 1 + f(n - 1, 1, 2, 3, 4, 5); })(6000)",
        "(function f(n) { try { return n === 0 ? 0 : 1 + f(n - 1); } finally { n = 0; } })(6000)",
    };
    static const char unbounded[] = "(function f() { return 1 + f(); })()";
    static const char recovering[] =
        "(function () { var deepest = 0; function helper(n) { return n; }"
        " function f(n) { try { return f(n + 1); } catch (error) { if (!(error instanceof RangeError)) throw error;"
        " deepest = Math.max(deepest, n); return helper(n); } }"
        " var result = f(0); return result >= 0 && deepest > 100 ? 1 : 0; })()";
    static const char mixed[] =
        "(function f(n) { return g(n); function g(n) { return h(n); } function h(n) { return [n].map(next)[0]; }"
        " function next(n) { return f(n + 1); } })(0)";
    static const char thrower[] =
        "(function () { function f(n) { if (n === 0) throw new RangeError('Maximum call stack size exceeded'); return f(n - 1) + 1; }"
        " return f(3000); })()";
    static const char fan[] = "(function f(n) { return n < 2 ? n : f(n - 1) + f(n - 2); })(24)";
    Interrupt state = { 0, 2 };
    size_t live, committed, index;
    int depth, fits = 0;
    char source[128];

    check(trim_to(rt, 4 * 1024 * 1024), "an ample frame limit is set for the inline checks");
    JS_UpdateStackTop(rt);
    JS_SetMaxStackSize(rt, 256 * 1024);
    for (index = 0; index < sizeof(deep) / sizeof(deep[0]); index++)
        check(outcome(ctx, deep[index], 6000) == DONE, "a chain far deeper than the native budget allows runs inline");
    usage(rt, &live, &committed);
    check(live == 0, "the deep chains released their frames");

    observe_from_here();
    check(outcome(ctx, unbounded, 0) == REFUSED, "unbounded inline recursion is refused with RangeError");
    usage(rt, &live, &committed);
    check(live == 0 && committed <= segment_charge, "the refused recursion released its frames and all but the spare");
    check(memory.frame_peak <= memory.declared_peak && memory.declared_peak <= 4 * 1024 * 1024, "filling the whole limit never held more than the limit");
    check(memory.declared_peak > 4 * 1024 * 1024 - segment_charge, "the refusal came within one segment of the limit");
    if (segment_charge == PAGE_64K)
        check(memory.declared_peak == 4 * 1024 * 1024, "64 segments of 64 KiB fill the 4 MiB limit exactly");
    check(outcome(ctx, recovering, 1) == DONE, "a handler that calls again after a refusal ends normally");
    check(outcome(ctx, mixed, 0) == REFUSED, "inline frames between native calls are still refused by the native guard");
    usage(rt, &live, &committed);
    check(live == 0, "the mixed recursion released its frames");
    check(outcome(ctx, thrower, 0) == REFUSED, "an exception thrown at depth leaves through every inline frame");
    usage(rt, &live, &committed);
    check(live == 0, "the thrown-through frames are released");

    /* the last depth that fits a small limit, and the first that does not */
    check(trim_to(rt, 3 * PAGE_64K), "a small frame limit is set");
    for (depth = 1; depth < 4000; depth++) {
        snprintf(source, sizeof(source), "(function f(n) { return n === 0 ? 0 : 1 + f(n - 1); })(%d)", depth);
        if (outcome(ctx, source, depth) != DONE)
            break;
        fits = depth;
    }
    check(fits > 50 && fits < 3999, "a small limit has a last depth that fits");
    snprintf(source, sizeof(source), "(function f(n) { return n === 0 ? 0 : 1 + f(n - 1); })(%d)", fits + 1);
    check(outcome(ctx, source, fits + 1) == REFUSED, "one level more is refused with RangeError");
    usage(rt, &live, &committed);
    check(live == 0 && committed <= 3 * PAGE_64K, "the boundary refusal leaves nothing live and stays within the limit");
    snprintf(source, sizeof(source), "(function f(n) { return n === 0 ? 0 : 1 + f(n - 1); })(%d)", fits);
    check(outcome(ctx, source, fits) == DONE, "the last depth that fits still fits after the refusal");

    /* inline calls poll the interrupt handler like any other call */
    check(set_limit(rt, 4 * 1024 * 1024) == 0, "the ample limit is back for the interrupt check");
    JS_SetInterruptHandler(rt, interrupt, &state);
    check(outcome(ctx, fan, 46368) == INTERRUPTED, "an interrupt ends a recursion that makes only inline calls");
    check(state.calls == 2, "the handler was polled from inline calls until it asked to stop");
    JS_SetInterruptHandler(rt, NULL, NULL);
    usage(rt, &live, &committed);
    check(live == 0, "the interrupted recursion released its frames");
    check(outcome(ctx, fan, 46368) == DONE, "the same recursion completes without the handler");

    JS_SetMaxStackSize(rt, AMPLE_STACK);
    check(set_limit(rt, 2 * 1024 * 1024) == 0, "the frame limit is restored after the inline checks");
}

static void continuation_calls(JSRuntime *rt, JSContext *ctx)
{
    static const char *const deep[] = {
        "(function f(n) { return n === 0 ? 0 : 1 + f.call(null, n - 1); })(5000)",
        "(function () { var n = 5000; function f() { return n-- === 0 ? 0 : 1 + f.call(); } return f(); })()",
        "(function f(n, a, b, c, d, e) { return n === 0 ? 0 : 1 + f.call(null, n - 1); })(5000)",
        "(function f(n) { 'use strict'; return n === 0 ? 5000 : f.call(null, n - 1, 1, 2, 3); })(5000)",
    };
    static const char unbounded[] = "(function f() { return 1 + f.call(null); })()";
    static const char fan[] = "(function f(n) { return n < 2 ? n : f.call(null, n - 1) + f.call(null, n - 2); })(24)";
    static const char recover[] =
        "(function () { var token = { self: null }; token.self = token;"
        " function f(n) { try { return 1 + f.call(null, n + 1); } catch (e) {"
        " if (!(e instanceof RangeError)) throw e; return n > 100 ? 1 : 0; } }"
        " var result = f(0); collectGarbage(); return result > 100 && (function (a) { return a.self === a ? 42 : 0; }).call(null, token); })()";
    Interrupt state = { 0, 2 };
    size_t live, committed, index;
    long total, denied = 0, request;

    check(trim_to(rt, 4 * 1024 * 1024), "storage is trimmed before continuation calls");
    JS_UpdateStackTop(rt);
    JS_SetMaxStackSize(rt, 32 * 1024);
    for (index = 0; index < sizeof(deep) / sizeof(deep[0]); index++)
        check(outcome(ctx, deep[index], 5000) == DONE, "CALL forwards deep zero, padded, extra and tail argument shapes in the loop");
    JS_SetMaxStackSize(rt, AMPLE_STACK);
    usage(rt, &live, &committed);
    check(live == 0 && held_agrees(rt), "successful continuations release every live frame");
    check(outcome(ctx, unbounded, 0) == REFUSED, "unbounded CALL is refused by frame storage");
    usage(rt, &live, &committed);
    check(live == 0 && committed <= segment_charge, "refused CALL leaves only permitted spare storage");
    check(outcome(ctx, recover, 42) == DONE, "CALL recovers inside the refusing chain and returns a cyclic argument");

    check(trim_to(rt, 4 * 1024 * 1024), "storage is trimmed before continuation fault counting");
    memory.frame_requests = 0;
    check(outcome(ctx, deep[2], 5000) == DONE, "padded CALL completes before fault injection");
    total = memory.frame_requests;
    for (request = 1; request <= total; request++) {
        check(trim_to(rt, 4 * 1024 * 1024), "storage is trimmed before a continuation fault");
        memory.frame_requests = 0;
        memory.fail_at = request;
        denied += outcome(ctx, deep[2], 5000) == NO_MEMORY;
        memory.fail_at = -1;
        usage(rt, &live, &committed);
        check(live == 0 && held_agrees(rt), "a denied CALL segment leaves no live frame or accounting mismatch");
        check(outcome(ctx, SHALLOW, 42) == DONE, "a clean call works after every denied continuation segment");
    }
    check(total > 1 && denied == total, "every continuation segment denial propagates the allocation exception");

    JS_SetInterruptHandler(rt, interrupt, &state);
    check(outcome(ctx, fan, 46368) == INTERRUPTED, "interrupts unwind active CALL continuations");
    JS_SetInterruptHandler(rt, NULL, NULL);
    check(state.calls == 2, "CALL polls until the interrupt handler requests termination");
    usage(rt, &live, &committed);
    check(live == 0 && held_agrees(rt), "interrupted continuations release every live frame");
    check(outcome(ctx, fan, 46368) == DONE, "the interrupted CALL workload recovers");
    check(trim_to(rt, 2 * 1024 * 1024), "storage is restored after continuation checks");
}

/* A refusal must survive error formatting, which calls back into JavaScript. */
static void continuation_reduces(JSRuntime *rt, JSContext *ctx)
{
    static const char *const deep[] = {
        "(function f(a, n) { return n === 0 ? 0 : 1 + [n - 1].reduce(f, 0); })(0, 5000)",
        "(function f(a, n) { return n === 0 ? 0 : 1 + [n - 1,,].reduceRight(f, 0); })(0, 5000)",
        "(function f(a, n, k, o, x, y) { return x !== undefined || y !== undefined ? -999 : n === 0 ? 0 : 1 + [0,,n - 1].reduce(f); })(0, 5000)",
        "(function f(a, n) { 'use strict'; return n === 0 ? 5000 : [n - 1].reduce(f, 0); })(0, 5000)",
    };
    static const char unbounded[] = "(function f() { return [1].reduce(function (a) { return 1 + f(); }, 0); })()";
    static const char fan[] = "(function f(n) { return n < 2 ? n : [n - 1, n - 2].reduce(function (a, v) { return a + f(v); }, 0); })(24)";
    static const char recover[] =
        "(function () { var token = { self: null }; token.self = token;"
        " function f(n) { try { return [1].reduce(function () { return 1 + f(n + 1); }, token); } catch (e) {"
        " if (!(e instanceof RangeError)) throw e; return n > 100 ? 1 : 0; } }"
        " var result = f(0); collectGarbage(); return result > 100 && [1].reduce(function (a) { return a.self === a ? 42 : 0; }, token); })()";
    static const char *const throws[] = {
        "var o = { get length() { throw 42; }, reduce: Array.prototype.reduce }; o.reduce(function () {});",
        "var o = { length: { valueOf() { throw 42; } }, reduce: Array.prototype.reduce }; o.reduce(function () {}, {});",
        "var o = { length: 1, get 0() { throw 42; }, reduce: Array.prototype.reduce }; o.reduce(function () {});",
        "var o = { length: 2, 0: {}, get 1() { throw 42; }, reduce: Array.prototype.reduce }; o.reduce(function () {}, {});",
        "[1].reduce(function () { throw 42; }, {});",
        "[].reduce(function () {});",
    };
    Interrupt state = { 0, 2 };
    size_t live, committed, index;
    long total, denied = 0, request;

    check(trim_to(rt, 4 * 1024 * 1024), "storage is trimmed before reduce continuations");
    JS_UpdateStackTop(rt);
    JS_SetMaxStackSize(rt, 32 * 1024);
    for (index = 0; index < sizeof(deep) / sizeof(deep[0]); index++)
        check(outcome(ctx, deep[index], 5000) == DONE, "reduce and reduceRight run 5000 sparse, padded, initial-scan and tail callbacks in the loop");
    JS_SetMaxStackSize(rt, AMPLE_STACK);
    usage(rt, &live, &committed);
    check(live == 0 && held_agrees(rt), "successful reduce continuations release every live frame");
    check(outcome(ctx, unbounded, 0) == REFUSED, "unbounded reduce is refused by frame storage");
    usage(rt, &live, &committed);
    check(live == 0 && committed <= segment_charge, "refused reduce leaves only permitted spare storage");
    check(outcome(ctx, recover, 42) == DONE, "reduce recovers inside the refusing chain with a cyclic accumulator");

    check(trim_to(rt, 4 * 1024 * 1024), "storage is trimmed before reduce fault counting");
    memory.frame_requests = 0;
    check(outcome(ctx, deep[2], 5000) == DONE, "padded reduce completes before fault injection");
    total = memory.frame_requests;
    for (request = 1; request <= total; request++) {
        check(trim_to(rt, 4 * 1024 * 1024), "storage is trimmed before a reduce allocation fault");
        memory.frame_requests = 0;
        memory.fail_at = request;
        denied += outcome(ctx, deep[2], 5000) == NO_MEMORY;
        memory.fail_at = -1;
        usage(rt, &live, &committed);
        check(live == 0 && held_agrees(rt), "a denied reduce segment leaves no live frame or accounting mismatch");
        check(outcome(ctx, "[20,22].reduce(function (a, b) { return a + b; }, 0)", 42) == DONE,
              "a clean reduce works after every denied continuation segment");
    }
    check(total > 1 && denied == total, "every reduce segment denial propagates the allocation exception");
    for (index = 0; index < sizeof(throws) / sizeof(throws[0]); index++) {
        JSValue value = JS_Eval(ctx, throws[index], strlen(throws[index]), "reduce-throw.js", JS_EVAL_TYPE_GLOBAL);
        check(JS_IsException(value), "reduce propagates coercion, lookup, callback and empty-input exceptions");
        JS_FreeValue(ctx, value);
        JS_FreeValue(ctx, JS_GetException(ctx));
        usage(rt, &live, &committed);
        check(live == 0 && held_agrees(rt), "every reduce throw releases its owned state");
        check(outcome(ctx, "[20,22].reduceRight(function (a, b) { return a + b; }, 0)", 42) == DONE,
              "reduceRight recovers after every initialization and callback throw");
    }
    JS_SetInterruptHandler(rt, interrupt, &state);
    check(outcome(ctx, fan, 46368) == INTERRUPTED, "interrupts unwind active reduce continuations");
    JS_SetInterruptHandler(rt, NULL, NULL);
    check(state.calls == 2, "reduce polls until the interrupt handler requests termination");
    usage(rt, &live, &committed);
    check(live == 0 && held_agrees(rt), "interrupted reduce continuations release every live frame");
    check(outcome(ctx, fan, 46368) == DONE, "the interrupted reduce workload recovers");
    check(trim_to(rt, 2 * 1024 * 1024), "storage is restored after reduce checks");
}

static void refusal_formatting(JSRuntime *rt, JSContext *ctx)
{
    static const char hook[] =
        "Error.prepareStackTrace = function (error, frames) { return 'hooked ' + frames.length; };"
        "var seen = 0; try { (function f() { return 1 + f(); })(); } catch (error) {"
        " seen = (error instanceof RangeError && error.message === 'Maximum call stack size exceeded') ? 1 : 2; }"
        "Error.prepareStackTrace = undefined; seen";
    size_t live, committed;
    check(trim_to(rt, 2 * PAGE_64K), "a small limit is set for the formatting check");
    check(outcome(ctx, hook, 1) == DONE, "the refusal keeps its class and message through a stack-trace hook");
    usage(rt, &live, &committed);
    check(live == 0, "formatting a refusal leaves no live frame");
    check(set_limit(rt, 2 * 1024 * 1024) == 0 && outcome(ctx, SHALLOW, 42) == DONE, "calls work after the formatted refusal");
}

/* The smallest limit a call fits, to the byte. Starting from 'low', which
   it is known to fit, the limit is lowered to one byte under what the
   call's blocks were declared to cost at their peak, until the call is
   refused. The last limit that ran it then runs it again within that limit,
   one byte less refuses it before the block that does not fit is requested,
   and both leave the allocator holding what is charged. Returns that
   smallest limit. */
static size_t fits_exactly(JSRuntime *rt, JSContext *ctx, const char *source, int expected, size_t low)
{
    size_t live, committed, need = 0, limit = low;
    long requests;
    int steps;

    for (steps = 0; steps < 64 && limit > 0; steps++) {
        if (!trim_to(rt, limit))
            break;
        observe_from_here();
        if (outcome(ctx, source, expected) != DONE)
            break;
        need = memory.declared_peak;
        limit = need - 1;
    }
    check(need > 0 && need <= low && steps < 64, "the call has a smallest limit it fits");

    check(trim_to(rt, need), "the limit is set to exactly that cost");
    observe_from_here();
    check(outcome(ctx, source, expected) == DONE, "a limit of exactly the declared cost runs the call");
    check(memory.declared_peak == need && memory.frame_peak <= need, "its blocks were declared to cost exactly that limit and held no more");
    check(memory.over_declared == 0, "and acquired no more than was declared");
    check(held_agrees(rt), "the spare left behind is charged what it holds");
    usage(rt, &live, &committed);
    check(live == 0 && committed > 0 && committed <= need, "the spare is charged within the limit");

    check(trim_to(rt, need - 1), "the limit is set one byte under that cost");
    observe_from_here();
    requests = memory.frame_requests;
    check(outcome(ctx, source, expected) == REFUSED, "one byte less refuses the call");
    check(memory.declined > 0 && memory.declared_peak < need, "the block that does not fit was priced and never requested");
    check(memory.frame_requests > requests, "the blocks that fit were requested");
    check(held_agrees(rt), "after the refusal the allocator holds what is charged");
    check(set_limit(rt, need) == 0 && outcome(ctx, source, expected) == DONE, "the call runs again at the exact limit");
    check(set_limit(rt, DEFAULT_LIMIT) == 0 && outcome(ctx, SHALLOW, 42) == DONE, "and at the default limit");
    return need;
}

/* "(function () { var a0, a1, ...; aN = 7; return aN; })()": one record of
   about eight bytes per local. */
static char *many_locals(int count)
{
    size_t size = (size_t)count * 12 + 128;
    char *source = malloc(size);
    size_t used = (size_t)snprintf(source, size, "(function () { var a0");
    int i;
    for (i = 1; i < count; i++)
        used += (size_t)snprintf(source + used, size - used, ", a%d", i);
    snprintf(source + used, size - used, "; a%d = 7; return a%d; })()", count - 1, count - 1);
    return source;
}

/* A record of about 200,000 bytes needs a block of its own. Before the
   bound was declared, a 199,968-byte request under a 200,000-byte limit was
   made, came back as 200,688 bytes from glibc and was only then rejected.
   Now a limit that leaves one byte too little never reaches the allocator
   with that request, and a limit that leaves exactly enough is served
   within it. */
static void large_block(JSRuntime *rt, JSContext *ctx)
{
    char *large = many_locals(25000);
    size_t need;

    check(trim_to(rt, DEFAULT_LIMIT), "storage is trimmed before the large frame");
    observe_from_here();
    check(outcome(ctx, large, 7) == DONE, "a 25,000-local frame runs at the default limit");
    check(memory.frame_largest > 200000 && memory.declared_largest >= memory.frame_largest, "it took one block of more than 200,000 bytes");
    check(memory.frame_peak <= memory.declared_peak && memory.over_declared == 0, "the block held and acquired no more than was declared for it");
    check(held_agrees(rt) && memory.frame_live == 1, "the large block is released and only the spare stays");
    need = fits_exactly(rt, ctx, large, 7, memory.declared_peak);
    check(trim_to(rt, need - 1), "the limit again leaves one byte too little");
    observe_from_here();
    check(outcome(ctx, large, 7) == REFUSED, "the large frame is refused");
    check(memory.declined_largest > 200000, "the allocator was asked what the large block would cost");
    check(memory.frame_largest < 200000, "and was never asked for it");
    check(set_limit(rt, DEFAULT_LIMIT) == 0, "the default limit is restored");
    free(large);
}

/* The runtime's own memory limit and count see a frame segment like any
   other block. */
static void memory_limit(JSRuntime *rt, JSContext *ctx)
{
    JSMemoryUsage before, after;
    size_t live, committed;

    check(trim_to(rt, DEFAULT_LIMIT), "storage is trimmed before the memory checks");
    check(outcome(ctx, SHALLOW, 42) == DONE && trim_to(rt, DEFAULT_LIMIT), "the call's own allocations are warmed up");
    JS_ComputeMemoryUsage(rt, &before);
    check(outcome(ctx, SHALLOW, 42) == DONE, "a call leaves one spare segment");
    JS_ComputeMemoryUsage(rt, &after);
    check(after.malloc_size - before.malloc_size >= (int64_t)(PAGE_64K - 256), "the segment counts toward the runtime's malloc size");
    check(trim_to(rt, DEFAULT_LIMIT), "the spare is released");
    JS_ComputeMemoryUsage(rt, &after);
    check(after.malloc_size - before.malloc_size < 32 * 1024, "and its count is taken back");

    JS_SetMemoryLimit(rt, (size_t)before.malloc_size + 32 * 1024);
    check(outcome(ctx, SHALLOW, 42) == NO_MEMORY, "a memory limit too small for a segment fails the call as out of memory");
    usage(rt, &live, &committed);
    check(live == 0 && committed == 0 && held_agrees(rt), "the failed request is charged nothing");
    JS_SetMemoryLimit(rt, 0);
    check(outcome(ctx, SHALLOW, 42) == DONE, "calls work once the memory limit is lifted");
}

/* An allocator that occupies more than it declared is caught when it
   reports the block's size: the block goes back and the call fails loudly. */
static void broken_declaration(JSRuntime *rt, JSContext *ctx)
{
    size_t live, committed;

    check(trim_to(rt, DEFAULT_LIMIT), "storage is trimmed before the allocator starts padding");
    memory.understates = 1;
    check(outcome(ctx, SHALLOW, 42) == BROKEN, "a block larger than its declared bound fails the call");
    usage(rt, &live, &committed);
    check(live == 0 && committed == 0 && memory.frame_live == 0, "the block was returned and nothing is charged");
    memory.understates = 0;
    check(outcome(ctx, SHALLOW, 42) == DONE, "calls work once the allocator keeps its declaration");
}

/* What an allocator may answer instead of a usable bound, and which error
   each answer is. */
static void unusable_declarations(JSRuntime *rt, JSContext *ctx)
{
    long requests;

    check(trim_to(rt, DEFAULT_LIMIT), "storage is trimmed before the declarations change");
    requests = memory.frame_requests;
    memory.declares = DECLARE_ZERO;
    check(outcome(ctx, SHALLOW, 42) == NO_BOUND, "an allocator that cannot bound the block fails the call");
    memory.declares = DECLARE_SHORT;
    check(outcome(ctx, SHALLOW, 42) == NO_BOUND, "a bound below the request itself is no bound");
    memory.declares = DECLARE_HUGE;
    check(outcome(ctx, SHALLOW, 42) == REFUSED, "a bound of SIZE_MAX fits no limit: a stack overflow, not a missing bound");
    check(memory.frame_requests == requests, "none of them requested a block");
    memory.declares = DECLARE_HONEST;
    check(outcome(ctx, SHALLOW, 42) == DONE, "calls work once the bound is usable");

    check(JS_SetMallocBound(rt, NULL) == -1, "the declaration cannot be withdrawn while a spare is charged under it");
    check(trim_to(rt, DEFAULT_LIMIT) && JS_SetMallocBound(rt, NULL) == 0, "it can once the spare is released");
    requests = memory.frame_requests;
    observe_from_here();
    check(outcome(ctx, SHALLOW, 42) == NO_BOUND, "without a declaration no ordinary call runs");
    check(memory.frame_requests == requests && memory.declined == 0, "and the allocator is not asked for anything");
    check(JS_SetMallocBound(rt, declare) == 0 && outcome(ctx, SHALLOW, 42) == DONE, "declaring the bound again restores calls");
}

/* The declaration cannot change under blocks charged by the current one,
   nor from inside the allocator's own callbacks. */
static void declaration_changes(JSRuntime *rt, JSContext *ctx)
{
    size_t live, committed, limit;

    check(trim_to(rt, DEFAULT_LIMIT) && outcome(ctx, SHALLOW, 42) == DONE, "a call leaves a spare behind");
    check(outcome(ctx, "(function () { return redeclare(); })()", -1) == DONE, "changing the declaration while a frame is live is refused");
    check(outcome(ctx, "(function f(n) { return n === 0 ? heldAgrees() : f(n - 1); })(2000)", 1) == DONE, "the refused change left the accounting intact");
    usage(rt, &live, &committed);
    check(committed > 0 && memory.frame_live == 1, "the spare is still held");
    check(JS_SetMallocBound(rt, declare) == -1, "changing the declaration with an idle spare is refused too");
    usage(rt, &live, &committed);
    check(committed > 0 && memory.frame_live == 1, "and the spare is untouched");

    check(trim_to(rt, 2 * 1024 * 1024), "storage is trimmed before the callbacks start meddling");
    memory.meddles = 1;
    check(outcome(ctx, DEEP, 4000) == DONE, "a chain runs while the bound and free callbacks try to change the settings");
    check(trim_to(rt, 2 * 1024 * 1024), "and its segments are released under the same callbacks");
    memory.meddles = 0;
    JS_GetFrameStackUsage(rt, &live, &committed, &limit);
    check(memory.meddled == 0 && limit == 2 * 1024 * 1024, "every change attempted from inside a callback was refused");
    check(JS_SetMallocBound(rt, declare) == 0, "the declaration can change once nothing is charged");
    check(outcome(ctx, SHALLOW, 42) == DONE, "calls work under the new declaration");
}

/* JS_NewRuntime2 declares nothing for custom callbacks. */
static void undeclared_runtime(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_context(&rt, &exact_profile, 0, 0);

    check(outcome(ctx, SHALLOW, 42) == NO_BOUND, "custom callbacks without a declared bound run no ordinary call");
    check(outcome(ctx, "21 * 2", 42) == NO_BOUND, "not even the script's own frame");
    check(memory.frame_requests == 0 && memory.declined == 0, "the allocator is never asked for frame storage");
    check(JS_SetMallocBound(rt, declare) == 0 && outcome(ctx, SHALLOW, 42) == DONE, "declaring the bound makes calls work");
    free_context(rt, ctx);
    check(memory.live == 0, "no allocation outlives the undeclared runtime");
}

/* The two failures the source review reproduced were on callbacks that pass
   every request to glibc's malloc. Nothing can be declared for that
   allocator, so such callbacks now run no ordinary call and malloc is never
   asked for frame storage at all. */
static void libc_callbacks(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_context(&rt, &libc_profile, 1, 0);
    char *large = many_locals(25000);
    size_t live, committed;

    check(set_limit(rt, 1024) == 0 && outcome(ctx, SHALLOW, 42) == NO_BOUND, "under a 1,024-byte limit a small call fails for want of a bound");
    check(set_limit(rt, 200000) == 0 && outcome(ctx, large, 7) == NO_BOUND, "under a 200,000-byte limit a 200,000-byte frame fails the same way");
    check(set_limit(rt, DEFAULT_LIMIT) == 0 && outcome(ctx, SHALLOW, 42) == NO_BOUND, "and so does any call at the default limit");
    usage(rt, &live, &committed);
    check(live == 0 && committed == 0, "nothing was ever charged");
    check(memory.frame_requests == 0 && memory.declined > 0, "malloc was asked for no frame block, only what one would cost");
    free(large);
    free_context(rt, ctx);
    check(memory.live == 0, "no allocation outlives the libc-backed runtime");
}

/* An allocator that reports no block sizes still has its frame segment
   counted by the runtime. */
static void blind_allocator(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_context(&rt, &exact_profile, 1, 1);
    JSMemoryUsage before, after;

    check(outcome(ctx, SHALLOW, 42) == DONE && trim_to(rt, DEFAULT_LIMIT), "a runtime whose allocator reports no sizes runs calls");
    JS_ComputeMemoryUsage(rt, &before);
    check(outcome(ctx, SHALLOW, 42) == DONE, "a call leaves one spare segment");
    JS_ComputeMemoryUsage(rt, &after);
    check(after.malloc_size - before.malloc_size >= (int64_t)(PAGE_64K - 256), "the segment is counted by the bytes requested");
    check(held_agrees(rt), "and charged what the allocator holds for it");
    JS_SetMemoryLimit(rt, (size_t)after.malloc_size + 32 * 1024);
    check(trim_to(rt, DEFAULT_LIMIT) && outcome(ctx, DEEP, 4000) == NO_MEMORY, "so the memory limit still stops the frame stack");
    JS_SetMemoryLimit(rt, 0);
    check(outcome(ctx, DEEP, 4000) == DONE, "and calls work once it is lifted");
    free_context(rt, ctx);
    check(memory.live == 0, "no allocation outlives the blind runtime");
}

static int aligned_as_malloc(const void *p)
{
    return ((uintptr_t)p % _Alignof(max_align_t)) == 0;
}

/* The engine's default callbacks on their own: large blocks are private
   mappings that keep malloc's alignment and the meaning of every callback. */
static void default_callbacks(void)
{
    const JSMallocFunctions *d = JS_GetDefaultMallocFunctions();
    size_t page = (size_t)getpagesize();
    size_t now = mapped_now, ever = mapped_ever;
    size_t bound = JS_DefaultMallocBound(NULL, 70000);
    unsigned char *p = d->js_malloc(NULL, 70000), *q, *small;

    check(bound >= 70000 && bound % page == 0, "a large request is declared as whole pages");
    check(p && aligned_as_malloc(p), "a mapped block is aligned as malloc aligns");
    check(d->js_malloc_usable_size(p) >= 70000 && d->js_malloc_usable_size(p) < bound, "its usable size covers the request and excludes the header");
    if (HOST_WATCH)
        check(mapped_ever - ever == bound && mapped_now - now == bound, "it mapped exactly what its bound declares");
    memset(p, 0xa5, 70000);
    q = d->js_realloc(NULL, p, 200000);
    check(q && aligned_as_malloc(q) && q[0] == 0xa5 && q[69999] == 0xa5, "growing a mapped block keeps its contents and alignment");
    if (HOST_WATCH)
        check(mapped_now - now == JS_DefaultMallocBound(NULL, 200000), "and holds only the new mapping");
    q = d->js_realloc(NULL, q, 100);
    check(q && aligned_as_malloc(q) && q[0] == 0xa5 && q[99] == 0xa5, "shrinking below the threshold moves the contents to a libc block");
    if (HOST_WATCH)
        check(mapped_now == now, "and returns the mapping");
    check(d->js_malloc_usable_size(q) >= 100, "a libc block still reports its size");
    q = d->js_realloc(NULL, q, 80000);
    check(q && aligned_as_malloc(q) && q[0] == 0xa5 && q[99] == 0xa5, "growing across the threshold moves the contents into a mapping");
    d->js_free(NULL, q);
    p = d->js_calloc(NULL, 3, 30000);
    check(p && aligned_as_malloc(p) && p[0] == 0 && p[89999] == 0, "a large calloc is zeroed and aligned");
    d->js_free(NULL, p);
    /* a sanitizer aborts on these two requests instead of returning NULL */
    if (!SANITIZED) {
        check(d->js_calloc(NULL, SIZE_MAX / 2, 4) == NULL, "an overflowing calloc fails");
        check(d->js_malloc(NULL, SIZE_MAX - 4096) == NULL, "a request too large to map has no bound and fails");
    }
    small = d->js_malloc(NULL, 100);
    check(small && aligned_as_malloc(small) && JS_DefaultMallocBound(NULL, 100) == 0, "a small request stays with libc and has no bound");
    check(JS_DefaultMallocBound(NULL, PAGE_64K - 257) == 0, "nor has any request under one frame segment");
    check(JS_DefaultMallocBound(NULL, PAGE_64K - 256) == round_up(PAGE_64K - 256 + 64, page), "a frame segment is declared as its header and pages");
    check(JS_DefaultMallocBound(NULL, SIZE_MAX) == 0 && JS_DefaultMallocBound(NULL, SIZE_MAX - 4096) == 0, "a size whose mapping would wrap has no bound");
    d->js_free(NULL, small);
    d->js_free(NULL, NULL);
    if (!HOST_WATCH)
        return;
    /* a request with a bound is a mapping or nothing: libc never stands in */
    small = d->js_malloc(NULL, 100);
    memset(small, 0x5a, 100);
    mapping_fails = 1;
    check(d->js_malloc(NULL, 70000) == NULL, "a large request fails when its mapping fails");
    check(d->js_calloc(NULL, 2, 40000) == NULL, "and so does a large calloc");
    check(d->js_realloc(NULL, small, 80000) == NULL, "and a realloc across the threshold");
    mapping_fails = 0;
    check(small[0] == 0x5a && small[99] == 0x5a && d->js_malloc_usable_size(small) >= 100, "which leaves the old block as it was");
    d->js_free(NULL, small);
    check(mapped_now == now, "every mapping was returned to the system");
}

/* A segment whose mapping fails is an out-of-memory error with nothing
   charged, and the next call works. */
static void default_mapping_failure(JSRuntime *rt, JSContext *ctx)
{
    size_t live, committed;

    check(trim_to(rt, DEFAULT_LIMIT), "storage is trimmed before mappings start failing");
    mapping_fails = 1;
    check(outcome(ctx, SHALLOW, 42) == NO_MEMORY, "a segment that cannot be mapped fails the call as out of memory");
    mapping_fails = 0;
    usage(rt, &live, &committed);
    check(live == 0 && committed == 0 && memory.frame_live == 0 && held_agrees(rt), "and is charged nothing");
    check(outcome(ctx, SHALLOW, 42) == DONE, "calls work once mappings succeed");
}

/* Large blocks of a default runtime that are not frame storage keep
   working, counted and limited like any other. */
static void default_large_blocks(JSRuntime *rt, JSContext *ctx)
{
    static const char build[] =
        "(function () { var b = new Uint8Array(1 << 20); b[0] = 7; b[1048575] = 9; var s = 'x'.repeat(300000);"
        " var a = []; for (var i = 0; i < 40000; i++) a.push(i); return b[0] + b[1048575] + s.length - 300000 + a[39999] - 39999; })()";
    static const char big[] = "(function () { return new Uint8Array(8 << 20).length >> 20; })()";
    JSMemoryUsage before, after;
    size_t now = mapped_now;

    check(outcome(ctx, build, 16) == DONE, "large typed arrays, strings and growing arrays work on the default callbacks");
    JS_RunGC(rt);
    check(trim_to(rt, DEFAULT_LIMIT), "storage is trimmed");
    now = mapped_now;
    JS_ComputeMemoryUsage(rt, &before);
    check(outcome(ctx, build, 16) == DONE, "the same blocks are built again");
    JS_RunGC(rt);
    check(trim_to(rt, DEFAULT_LIMIT), "and collected");
    JS_ComputeMemoryUsage(rt, &after);
    check(after.malloc_size - before.malloc_size < 64 * 1024, "their bytes leave the runtime's malloc size when freed");
    if (HOST_WATCH)
        check(mapped_now == now, "and their mappings go back to the system");
    JS_SetMemoryLimit(rt, (size_t)before.malloc_size + (1 << 20));
    check(outcome(ctx, big, 8) == NO_MEMORY, "a large block over the memory limit fails as out of memory");
    JS_SetMemoryLimit(rt, 0);
    check(outcome(ctx, big, 8) == DONE, "and succeeds once the limit is lifted");
}

/* Before the page size has ever been read, a failure to read it leaves the
   default callbacks without a bound, and they map nothing. */
static void unreadable_page_size(void)
{
    const JSMallocFunctions *d = JS_GetDefaultMallocFunctions();
    JSRuntime *rt;
    JSContext *ctx;
    size_t ever = mapped_ever;
    void *p;

    page_size_answer = -1;
    check(JS_DefaultMallocBound(NULL, 70000) == 0, "an unreadable page size leaves the default callbacks without a bound");
    p = d->js_malloc(NULL, 70000);
    check(p && mapped_ever == ever && d->js_malloc_usable_size(p) >= 70000, "a large request then stays with libc");
    d->js_free(NULL, p);
    ctx = finish_context(JS_NewRuntime(), &rt);
    check(outcome(ctx, SHALLOW, 42) == NO_BOUND, "and ordinary calls fail instead of guessing");
    page_size_answer = 3000;
    check(JS_DefaultMallocBound(NULL, 70000) == 0, "a page size that is not a power of two is not used");
    check(outcome(ctx, SHALLOW, 42) == NO_BOUND, "and calls still fail");
    page_size_answer = 0;
    check(JS_DefaultMallocBound(NULL, 70000) != 0, "the bound returns with a readable page size");
    check(outcome(ctx, SHALLOW, 42) == DONE, "and so do calls");
    free_context(rt, ctx);
}

static void contract_on(const Profile *chosen)
{
    JSRuntime *rt;
    JSContext *ctx = new_context(&rt, chosen, 1, 0);

    limit_boundaries(rt, ctx);
    chunk_accounting(rt, ctx);
    chunk_faults(rt, ctx);
    native_guard(rt, ctx);
    inline_calls(rt, ctx);
    continuation_calls(rt, ctx);
    continuation_reduces(rt, ctx);
    refusal_formatting(rt, ctx);
    if (chosen->byte_exact)
        fits_exactly(rt, ctx, SHALLOW, 42, segment_charge - 1);
    else
        fits_exactly(rt, ctx, DEEP, 4000, DEFAULT_LIMIT);
    large_block(rt, ctx);
    memory_limit(rt, ctx);
    if (chosen == &exact_profile) {
        broken_declaration(rt, ctx);
        unusable_declarations(rt, ctx);
        declaration_changes(rt, ctx);
    }
    if (chosen == &default_profile)
        default_large_blocks(rt, ctx);
    if (chosen == &default_profile)
        declaration_changes(rt, ctx);
    if (chosen == &default_profile && HOST_WATCH)
        default_mapping_failure(rt, ctx);
    check(memory.over_limit == 0, "no frame block ever left the allocator holding more than the limit");
    check(memory.over_declared == 0, "no frame block made the allocator acquire more than it declared");
    check(memory.untracked == 0, "every frame block was watched");
    memory.meddles = 1;
    free_context(rt, ctx);
    check(memory.meddled == 0, "both setters refuse after backing release during runtime teardown");
    check(memory.live == 0 && memory.frame_live == 0, "no allocation outlives the runtime");
}

static int mode_unmap_failure(void)
{
#if HOST_WATCH
    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);
    const char source[] = "(function () { return 42; })()";
    JSValue value = JS_Eval(ctx, source, strlen(source), "unmap.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(value))
        return 2;
    JS_FreeValue(ctx, value);
    unmapping_fails = 1;
    JS_SetMaxFrameStackSize(rt, 0);
    unmapping_fails = 0;
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return 0;
#else
    return 77;
#endif
}

static int mode_contract(void)
{
    size_t mapped;

    heap_base = mmap(NULL, HEAP_RESERVE, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
    if (heap_base == MAP_FAILED)
        return 2;
    heap_brk = heap_end = heap_base;
    mapped = mapped_now;
    profile = &default_profile;
    if (HOST_WATCH)
        unreadable_page_size();
    default_callbacks();
    contract_on(&exact_profile);
    contract_on(&paged_profile);
    contract_on(&default_profile);
    if (HOST_WATCH)
        check(mapped_now == mapped, "the default callbacks returned every mapping they made");
    if (SANITIZED)
        contract_on(&sanitizer_profile);
    undeclared_runtime();
    libc_callbacks();
    blind_allocator();
    printf("contract checks %d failures %d live %ld\n", checks, failures, memory.live);
    return failures != 0;
}

static void *run_job(void *opaque)
{
    Job *job = opaque;
    const char *mode = job->argc > 1 ? job->argv[1] : "";
    if (!strcmp(mode, "run") && job->argc == 3)
        job->status = mode_run(job->argv + 2);
    else if (!strcmp(mode, "contract") && job->argc == 2)
        job->status = mode_contract();
    else if (!strcmp(mode, "unmap-failure") && job->argc == 2)
        job->status = mode_unmap_failure();
    else
        job->status = 2;
    return NULL;
}

int main(int argc, char **argv)
{
    Job job = { argc, argv, 2 };
    pthread_attr_t attr;
    pthread_t thread;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, THREAD_STACK);
    if (pthread_create(&thread, &attr, run_job, &job))
        return 2;
    pthread_join(thread, NULL);
    if (job.status == 2)
        fprintf(stderr, "usage: run FILE | contract\n");
    return job.status;
}

/* Original direct embedder regression for the frame stack of ordinary bytecode
   calls (docs/bun-patches/quickjs-frame-stack.md). Drives the QuickJS engine
   without the bun-wasm runtime: frame-limit boundaries, physical accounting,
   denied chunk allocations and call semantics.
   scripts/check-quickjs-frame-stack.ts builds and runs it. */
#include "quickjs.h"
#include <malloc.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define THREAD_STACK ((size_t)512 << 20)
#define AMPLE_STACK ((size_t)448 << 20)
/* the allocator charge QuickJS adds per block on this platform */
#if defined(__APPLE__)
#define BLOCK_OVERHEAD 0
#else
#define BLOCK_OVERHEAD 8
#endif

/* watch_size 0 watches nothing. Otherwise blocks whose usable size is exactly
   that are counted, kept in 'watched' while live, and can be denied. The
   usable size is what the engine charges, whatever it asked for. */
typedef struct {
    long live;
    size_t watch_size;
    long watch_calls, fail_at, denied;
    long watched_live, watched_bytes;
    void *watched[4096];
} Allocator;
typedef struct { int argc; char **argv; int status; } Job;

/* Only for taking the semantics golden from the engine before the change,
   which has no frame stack: `run` mode never depends on these values. */
#ifdef QUICKJS_FRAME_STACK_BASELINE
int JS_SetMaxFrameStackSize(JSRuntime *rt, size_t bytes) { return 0; }
void JS_GetFrameStackUsage(JSRuntime *rt, size_t *plive, size_t *pcommitted, size_t *plimit)
{
    *plive = *pcommitted = *plimit = 0;
}
#endif

static Allocator memory = { 0, 0, 0, -1, 0, 0, 0, { 0 } };
static int checks, failures;
static JSContext *other_context;

static void check(int ok, const char *label)
{
    checks++;
    if (ok)
        return;
    failures++;
    fprintf(stderr, "FAIL: %s\n", label);
}

static void *allocate(void *opaque, size_t size)
{
    Allocator *a = opaque;
    void *p = malloc(size);
    int watched;
    if (!p)
        return NULL;
    watched = a->watch_size && malloc_usable_size(p) == a->watch_size;
    if (watched && ++a->watch_calls == a->fail_at) {
        a->denied++;
        free(p);
        return NULL;
    }
    a->live++;
    if (watched && a->watched_live < 4096) {
        a->watched[a->watched_live++] = p;
        a->watched_bytes += (long)malloc_usable_size(p) + BLOCK_OVERHEAD;
    }
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
    long i;
    if (!p)
        return;
    for (i = 0; i < a->watched_live; i++) {
        if (a->watched[i] != p)
            continue;
        a->watched[i] = a->watched[--a->watched_live];
        a->watched_bytes -= (long)malloc_usable_size(p) + BLOCK_OVERHEAD;
        break;
    }
    a->live--;
    free(p);
}

static void *resize(void *opaque, void *p, size_t size)
{
    if (!p)
        return allocate(opaque, size);
    if (!size) {
        release(opaque, p);
        return NULL;
    }
    return realloc(p, size);
}

static size_t usable_size(const void *p)
{
    return malloc_usable_size((void *)p);
}

static const JSMallocFunctions allocator = {
    allocate_zero, allocate, release, resize, usable_size
};

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

/* setFrameLimit(bytes): the setter's return value, callable while frames are live */
static JSValue set_frame_limit(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    int64_t bytes;
    if (JS_ToInt64(ctx, &bytes, argv[0]))
        return JS_EXCEPTION;
    return JS_NewInt32(ctx, JS_SetMaxFrameStackSize(JS_GetRuntime(ctx), (size_t)bytes));
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
    JS_FreeValue(ctx, global);
}

static JSContext *new_context(JSRuntime **prt)
{
    JSRuntime *rt = JS_NewRuntime2(&allocator, &memory);
    JSContext *ctx = JS_NewContext(rt);
    JS_UpdateStackTop(rt);
    JS_SetMaxStackSize(rt, AMPLE_STACK);
    install(ctx);
    other_context = JS_NewContext(rt);
    install(other_context);
    *prt = rt;
    return ctx;
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

/* run FILE: evaluates a script that reports through print(). */
static int mode_run(char **argv)
{
    JSRuntime *rt;
    JSContext *ctx = new_context(&rt);
    size_t len;
    char *text = read_file(argv[0], &len);
    JSValue value = JS_Eval(ctx, text, len, "frames.js", JS_EVAL_TYPE_GLOBAL);
    char description[1024];
    int status = 0;
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

/* 0: evaluated to the int 'expected'; 1: RangeError; 2: out of memory;
   4: interrupted; 3: anything else */
static int outcome(JSContext *ctx, const char *source, int expected)
{
    JSValue value = JS_Eval(ctx, source, strlen(source), "contract.js", JS_EVAL_TYPE_GLOBAL);
    char text[1024];
    int result = 3;
    if (JS_IsException(value)) {
        describe_exception(ctx, text, sizeof(text));
        if (!strcmp(text, "RangeError: Maximum call stack size exceeded"))
            result = 1;
        else if (!strncmp(text, "InternalError: out of memory", 28))
            result = 2;
        else if (!strcmp(text, "InternalError: interrupted"))
            result = 4;
        else
            fprintf(stderr, "unexpected: %.300s\n", text);
    } else if (JS_VALUE_GET_TAG(value) == JS_TAG_INT && JS_VALUE_GET_INT(value) == expected) {
        result = 0;
    } else {
        fprintf(stderr, "unexpected value for %.80s\n", source);
    }
    JS_FreeValue(ctx, value);
    return result;
}

static void usage(JSRuntime *rt, size_t *plive, size_t *pcommitted)
{
    size_t limit;
    JS_GetFrameStackUsage(rt, plive, pcommitted, &limit);
}

#define SHALLOW "(function () { return 21 * 2; })()"
#define DEEP "(function f(n) { return n === 0 ? 0 : 1 + f(n - 1); })(4000)"

/* Zero, tiny, exact and invalid limits, and recovery after each refusal. */
static void limit_boundaries(JSRuntime *rt, JSContext *ctx)
{
    size_t live, committed, chunk_charge, default_limit, ignored;
    JS_GetFrameStackUsage(rt, &live, &committed, &default_limit);
    check(live == 0 && committed == 0, "no frame storage before the first call");
    check(default_limit > 0 && JS_SetMaxFrameStackSize(rt, default_limit * 2 + 1) == -1, "a limit above the supported range is refused");
    JS_GetFrameStackUsage(rt, &live, &committed, &ignored);
    check(ignored == default_limit, "a refused limit changes nothing");

    check(JS_SetMaxFrameStackSize(rt, 0) == 0, "zero is a valid limit");
    check(outcome(ctx, SHALLOW, 42) == 1, "no ordinary call fits a zero limit");
    usage(rt, &live, &committed);
    check(live == 0 && committed == 0, "a refused call leaves no storage behind");
    check(JS_SetMaxFrameStackSize(rt, 1) == 0 && outcome(ctx, SHALLOW, 42) == 1, "a one-byte limit refuses at entry");
    check(JS_SetMaxFrameStackSize(rt, 64) == 0 && outcome(ctx, SHALLOW, 42) == 1, "a limit below one record refuses at entry");

    check(JS_SetMaxFrameStackSize(rt, default_limit) == 0 && outcome(ctx, SHALLOW, 42) == 0, "calls work again once the limit is restored");
    usage(rt, &live, &committed);
    chunk_charge = committed;
    check(live == 0 && chunk_charge > 0, "one emptied small chunk is kept, and it is counted");

    check(JS_SetMaxFrameStackSize(rt, chunk_charge) == 0 && outcome(ctx, SHALLOW, 42) == 0, "a limit of exactly one chunk's charge fits a small call");
    check(JS_SetMaxFrameStackSize(rt, chunk_charge - 1) == 0, "lowering the limit below the idle spare releases it");
    usage(rt, &live, &committed);
    check(committed == 0, "the released spare is no longer counted");
    /* a default chunk no longer fits, so the remaining budget is offered as an exact-fit chunk */
    check(outcome(ctx, SHALLOW, 42) == 0, "one byte under a default chunk's charge still fits a small frame exactly");
    usage(rt, &live, &committed);
    check(committed < chunk_charge, "the exact-fit chunk costs less than a default chunk");
    check(JS_SetMaxFrameStackSize(rt, 1024) == 0 && outcome(ctx, SHALLOW, 42) == 0, "a small limit still fits a small frame exactly");
    usage(rt, &live, &committed);
    check(committed <= 1024, "the committed count never exceeds the limit");
    check(outcome(ctx, DEEP, 4000) == 1, "a deep chain is refused at a small limit");
    check(outcome(ctx, SHALLOW, 42) == 0, "a shallow call works after that refusal");
    check(JS_SetMaxFrameStackSize(rt, default_limit) == 0, "the default limit is restored");
}

/* Chunk growth, release, the spare, and agreement with what the allocator holds. */
static void chunk_accounting(JSRuntime *rt, JSContext *ctx)
{
    static const char probe[] =
        "(function f(n) { if (n === 0) { const u = frameUsage(); return u[1] > 4 * 16384 ? 1 : 0; } return f(n - 1); })(4000)";
    static const char shrink[] =
        "(function f(n) { return n === 0 ? setFrameLimit(0) : f(n - 1); })(50)";
    static const char large[] =
        "(function () { var s = 'var t = 0;'; for (var i = 0; i < 5300; i++) s += 'var v' + i + ' = ' + i + ';';"
        " s += 'return function () { return v0 + v5299; };'; return new Function(s)()(); })()";
    size_t live, committed, spare;

    check(JS_SetMaxFrameStackSize(rt, 0) == 0, "storage is trimmed before the accounting checks");
    check(JS_SetMaxFrameStackSize(rt, 2 * 1024 * 1024) == 0, "a known limit is set");
    check(outcome(ctx, SHALLOW, 42) == 0, "a first call takes one chunk");
    usage(rt, &live, &spare);
    check(outcome(ctx, probe, 1) == 0, "a deep chain commits several chunks while it runs");
    usage(rt, &live, &committed);
    check(live == 0 && committed == spare, "unwinding releases every chunk but one small spare");
    check(outcome(ctx, shrink, -1) == 0, "a limit below what live frames hold is refused and changes nothing");
    check(outcome(ctx, large, 5299) == 0, "a frame larger than a default chunk gets its own chunk");
    usage(rt, &live, &committed);
    check(live == 0 && committed <= spare, "a large emptied chunk is released, not kept as the spare");
    check(outcome(ctx, SHALLOW, 42) == 0, "a small call follows a large one");

    /* watch the default chunk allocation: the frame stack's count must equal what the allocator holds */
    check(JS_SetMaxFrameStackSize(rt, 0) == 0 && JS_SetMaxFrameStackSize(rt, 2 * 1024 * 1024) == 0, "storage is trimmed before watching");
    memory.watch_size = spare - BLOCK_OVERHEAD;
    memory.watched_live = 0;
    memory.watched_bytes = 0;
    check(outcome(ctx, SHALLOW, 42) == 0, "a watched chunk is allocated");
    usage(rt, &live, &committed);
    check(memory.watched_live == 1, "the allocator holds exactly one chunk");
    check((long)committed == memory.watched_bytes, "the committed count equals the allocator's bytes for one chunk");
    check(outcome(ctx, probe, 1) == 0, "a deep chain allocates watched chunks");
    usage(rt, &live, &committed);
    check((long)committed == memory.watched_bytes && memory.watched_live == 1, "after unwinding, the count again equals the allocator's bytes");
    memory.watch_size = 0;
}

/* Denies each chunk allocation of a deep chain in turn. */
static void chunk_faults(JSRuntime *rt, JSContext *ctx)
{
    size_t live, committed, spare;
    long total, index, reported = 0;

    check(JS_SetMaxFrameStackSize(rt, 0) == 0 && JS_SetMaxFrameStackSize(rt, 2 * 1024 * 1024) == 0, "storage is trimmed before the fault sweep");
    check(outcome(ctx, SHALLOW, 42) == 0, "the chunk size is observed");
    usage(rt, &live, &spare);
    check(JS_SetMaxFrameStackSize(rt, 0) == 0 && JS_SetMaxFrameStackSize(rt, 2 * 1024 * 1024) == 0, "storage is trimmed again");
    memory.watch_size = spare - BLOCK_OVERHEAD;
    memory.watch_calls = 0;
    memory.watched_live = 0;
    memory.watched_bytes = 0;
    check(outcome(ctx, DEEP, 4000) == 0, "the deep chain runs without faults");
    total = memory.watch_calls;
    check(total >= 4, "the deep chain needs several chunks");
    for (index = 1; index <= total; index++) {
        check(JS_SetMaxFrameStackSize(rt, 0) == 0 && JS_SetMaxFrameStackSize(rt, 2 * 1024 * 1024) == 0, "storage is trimmed before a fault");
        memory.watch_calls = 0;
        memory.fail_at = index;
        reported += outcome(ctx, DEEP, 4000) == 2;
        memory.fail_at = -1;
        usage(rt, &live, &committed);
        check(live == 0, "a denied chunk leaves no live frame");
        check(outcome(ctx, DEEP, 4000) == 0, "the same chain runs after a denied chunk");
    }
    check(total > 0 && reported == total, "every denied chunk is reported as out of memory");
    printf("faults chunks %ld reported %ld\n", total, reported);
    memory.watch_size = 0;
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
    check(JS_SetMaxFrameStackSize(rt, 4 * 1024 * 1024) == 0, "the frame limit is put out of reach of the native checks");
    JS_UpdateStackTop(rt);
    JS_SetMaxStackSize(rt, 256 * 1024);
    for (index = 0; index < sizeof(unbounded) / sizeof(unbounded[0]); index++) {
        check(outcome(ctx, unbounded[index], 0) == 1, "unbounded native recursion is refused with RangeError");
        usage(rt, &live, &committed);
        check(live == 0, "the refused recursion released its frames");
        check(outcome(ctx, SHALLOW, 42) == 0, "a shallow call works after the refusal");
    }
    JS_SetMaxStackSize(rt, AMPLE_STACK);
    check(JS_SetMaxFrameStackSize(rt, 2 * 1024 * 1024) == 0, "the frame limit is restored");
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

    check(JS_SetMaxFrameStackSize(rt, 0) == 0 && JS_SetMaxFrameStackSize(rt, 4 * 1024 * 1024) == 0, "an ample frame limit is set for the inline checks");
    JS_UpdateStackTop(rt);
    JS_SetMaxStackSize(rt, 256 * 1024);
    for (index = 0; index < sizeof(deep) / sizeof(deep[0]); index++)
        check(outcome(ctx, deep[index], 6000) == 0, "a chain far deeper than the native budget allows runs inline");
    usage(rt, &live, &committed);
    check(live == 0, "the deep chains released their frames");

    check(outcome(ctx, unbounded, 0) == 1, "unbounded inline recursion is refused with RangeError");
    usage(rt, &live, &committed);
    check(live == 0 && committed < 64 * 1024, "the refused recursion released its frames and chunks");
    check(outcome(ctx, recovering, 1) == 0, "a handler that calls again after a refusal ends normally");
    check(outcome(ctx, mixed, 0) == 1, "inline frames between native calls are still refused by the native guard");
    usage(rt, &live, &committed);
    check(live == 0, "the mixed recursion released its frames");
    check(outcome(ctx, thrower, 0) == 1, "an exception thrown at depth leaves through every inline frame");
    usage(rt, &live, &committed);
    check(live == 0, "the thrown-through frames are released");

    /* the last depth that fits a small limit, and the first that does not */
    check(JS_SetMaxFrameStackSize(rt, 0) == 0 && JS_SetMaxFrameStackSize(rt, 48 * 1024) == 0, "a small frame limit is set");
    for (depth = 1; depth < 4000; depth++) {
        snprintf(source, sizeof(source), "(function f(n) { return n === 0 ? 0 : 1 + f(n - 1); })(%d)", depth);
        if (outcome(ctx, source, depth) != 0)
            break;
        fits = depth;
    }
    check(fits > 50 && fits < 3999, "a small limit has a last depth that fits");
    snprintf(source, sizeof(source), "(function f(n) { return n === 0 ? 0 : 1 + f(n - 1); })(%d)", fits + 1);
    check(outcome(ctx, source, fits + 1) == 1, "one level more is refused with RangeError");
    usage(rt, &live, &committed);
    check(live == 0 && committed <= 48 * 1024, "the boundary refusal leaves nothing live and stays within the limit");
    snprintf(source, sizeof(source), "(function f(n) { return n === 0 ? 0 : 1 + f(n - 1); })(%d)", fits);
    check(outcome(ctx, source, fits) == 0, "the last depth that fits still fits after the refusal");

    /* inline calls poll the interrupt handler like any other call */
    check(JS_SetMaxFrameStackSize(rt, 4 * 1024 * 1024) == 0, "the ample limit is back for the interrupt check");
    JS_SetInterruptHandler(rt, interrupt, &state);
    check(outcome(ctx, fan, 46368) == 4, "an interrupt ends a recursion that makes only inline calls");
    check(state.calls == 2, "the handler was polled from inline calls until it asked to stop");
    JS_SetInterruptHandler(rt, NULL, NULL);
    usage(rt, &live, &committed);
    check(live == 0, "the interrupted recursion released its frames");
    check(outcome(ctx, fan, 46368) == 0, "the same recursion completes without the handler");

    JS_SetMaxStackSize(rt, AMPLE_STACK);
    check(JS_SetMaxFrameStackSize(rt, 2 * 1024 * 1024) == 0, "the frame limit is restored after the inline checks");
}

/* A refusal must survive error formatting, which calls back into JavaScript. */
static void refusal_formatting(JSRuntime *rt, JSContext *ctx)
{
    static const char hook[] =
        "Error.prepareStackTrace = function (error, frames) { return 'hooked ' + frames.length; };"
        "var seen = 0; try { (function f() { return 1 + f(); })(); } catch (error) {"
        " seen = (error instanceof RangeError && error.message === 'Maximum call stack size exceeded') ? 1 : 2; }"
        "Error.prepareStackTrace = undefined; seen";
    size_t live, committed;
    check(JS_SetMaxFrameStackSize(rt, 0) == 0 && JS_SetMaxFrameStackSize(rt, 64 * 1024) == 0, "a small limit is set for the formatting check");
    check(outcome(ctx, hook, 1) == 0, "the refusal keeps its class and message through a stack-trace hook");
    usage(rt, &live, &committed);
    check(live == 0, "formatting a refusal leaves no live frame");
    check(JS_SetMaxFrameStackSize(rt, 2 * 1024 * 1024) == 0 && outcome(ctx, SHALLOW, 42) == 0, "calls work after the formatted refusal");
}

static int mode_contract(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_context(&rt);
    limit_boundaries(rt, ctx);
    chunk_accounting(rt, ctx);
    chunk_faults(rt, ctx);
    native_guard(rt, ctx);
    inline_calls(rt, ctx);
    refusal_formatting(rt, ctx);
    free_context(rt, ctx);
    check(memory.live == 0, "no allocation outlives the runtime");
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

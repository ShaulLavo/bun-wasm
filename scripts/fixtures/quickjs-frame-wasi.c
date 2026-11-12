/* Original wasm32 regression for what the frame stack's default bound
   declares about the product's allocator (docs/bun-patches/quickjs-frame-stack.md):
   wasi-libc's dlmalloc of the split profile, growing this module's own
   linear memory. Built for wasm32-wasip1 against the product sysroot and run
   under wasmtime by scripts/check-quickjs-frame-wasi.ts.

   The callbacks pass every request to the engine's default callbacks, which
   are libc's here, and read the linear memory size around each one. What a
   request made the allocator acquire is that growth, never the bound or the
   engine's count. */
#include "quickjs.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PAGE ((size_t)65536)
#define DEFAULT_LIMIT ((size_t)4 << 20)
#define SEGMENT_REQUEST (PAGE - 256)

typedef struct { void *block; size_t declared, grown; } FrameBlock;

typedef struct {
    size_t offered, bound;
    int armed;
    long declined;
    long requests, cold, warm, over_declared, untracked, live;
    size_t held_declared, peak_declared, held_grown, peak_grown;
    FrameBlock blocks[256];
} Watch;

static Watch watch;
static int checks, failures;

static void check(int ok, const char *label)
{
    checks++;
    if (ok)
        return;
    failures++;
    fprintf(stderr, "FAIL: %s\n", label);
}

static size_t memory_bytes(void)
{
    return __builtin_wasm_memory_size(0) * PAGE;
}

static void settle(void)
{
    if (!watch.armed)
        return;
    watch.armed = 0;
    watch.declined++;
}

static size_t declare(void *opaque, size_t size)
{
    settle();
    watch.offered = size;
    watch.bound = JS_DefaultMallocBound(NULL, size);
    watch.armed = 1;
    return watch.bound;
}

static void note_frame(void *p, size_t grown)
{
    FrameBlock *slot;
    watch.requests++;
    if (grown > watch.bound)
        watch.over_declared++;
    if (grown)
        watch.cold++;
    else
        watch.warm++;
    if (watch.live >= 256) {
        watch.untracked++;
        return;
    }
    slot = &watch.blocks[watch.live++];
    slot->block = p;
    slot->declared = watch.bound;
    slot->grown = grown;
    watch.held_declared += slot->declared;
    watch.held_grown += slot->grown;
    if (watch.held_declared > watch.peak_declared)
        watch.peak_declared = watch.held_declared;
    if (watch.held_grown > watch.peak_grown)
        watch.peak_grown = watch.held_grown;
}

static void *allocate(void *opaque, size_t size)
{
    int frame = watch.armed && size == watch.offered;
    size_t before = memory_bytes();
    void *p;
    if (frame)
        watch.armed = 0;
    settle();
    p = JS_GetDefaultMallocFunctions()->js_malloc(NULL, size);
    if (p && frame)
        note_frame(p, memory_bytes() - before);
    return p;
}

static void *allocate_zero(void *opaque, size_t count, size_t size)
{
    settle();
    return JS_GetDefaultMallocFunctions()->js_calloc(NULL, count, size);
}

static void release(void *opaque, void *p)
{
    long i;
    settle();
    for (i = 0; i < watch.live; i++) {
        if (watch.blocks[i].block != p)
            continue;
        watch.held_declared -= watch.blocks[i].declared;
        watch.held_grown -= watch.blocks[i].grown;
        watch.blocks[i] = watch.blocks[--watch.live];
        break;
    }
    JS_GetDefaultMallocFunctions()->js_free(NULL, p);
}

static void *resize(void *opaque, void *p, size_t size)
{
    settle();
    return JS_GetDefaultMallocFunctions()->js_realloc(NULL, p, size);
}

static size_t usable_size(const void *p)
{
    return JS_GetDefaultMallocFunctions()->js_malloc_usable_size(p);
}

static const JSMallocFunctions allocator = {
    allocate_zero, allocate, release, resize, usable_size
};

/* The integer a script evaluates to; -1 for a RangeError, -2 for anything else. */
static int evaluate(JSContext *ctx, const char *source)
{
    JSValue value = JS_Eval(ctx, source, strlen(source), "wasi.js", JS_EVAL_TYPE_GLOBAL);
    JSValue error;
    const char *text;
    int result = -2;
    if (!JS_IsException(value)) {
        JS_ToInt32(ctx, &result, value);
        JS_FreeValue(ctx, value);
        settle();
        return result;
    }
    error = JS_GetException(ctx);
    text = JS_ToCString(ctx, error);
    if (text && !strcmp(text, "RangeError: Maximum call stack size exceeded"))
        result = -1;
    else
        fprintf(stderr, "unexpected: %.200s\n", text ? text : "<unprintable>");
    if (text)
        JS_FreeCString(ctx, text);
    JS_FreeValue(ctx, error);
    settle();
    return result;
}

/* The equation itself, at the sizes where it steps. */
static void declared_values(void)
{
    size_t quanta;
    check(JS_DefaultMallocBound(NULL, 1) == PAGE, "the smallest request can grow memory by one page");
    check(JS_DefaultMallocBound(NULL, 65452) == PAGE, "a 65,452-byte request still fits one page with dlmalloc's padding");
    check(JS_DefaultMallocBound(NULL, 65453) == 2 * PAGE, "one byte more can need two");
    for (quanta = 1; quanta <= 64; quanta++)
        check(JS_DefaultMallocBound(NULL, quanta * PAGE - 256) == quanta * PAGE, "a segment of n quanta is declared n pages");
    check(JS_DefaultMallocBound(NULL, SIZE_MAX) == 0 && JS_DefaultMallocBound(NULL, SIZE_MAX - PAGE) == 0, "a size whose bound would wrap has none");
}

/* libc's own malloc against the bound, with a heap kept fragmented: no
   request grows linear memory by more than is declared for it. */
static void malloc_growth(void)
{
    void *held[97] = { 0 };
    uint32_t state = 12345;
    long cold = 0, over = 0;
    size_t size, before, grown;
    int round, slot;

    for (round = 0; round < 6000; round++) {
        state = state * 1664525u + 1013904223u;
        slot = (int)((state >> 8) % 97);
        size = 1 + (state >> 12) % (round % 7 == 0 ? 300000 : 70000);
        free(held[slot]);
        before = memory_bytes();
        held[slot] = malloc(size);
        grown = memory_bytes() - before;
        cold += grown != 0;
        over += !held[slot] || grown > JS_DefaultMallocBound(NULL, size);
    }
    for (slot = 0; slot < 97; slot++)
        free(held[slot]);
    check(over == 0, "no malloc grew linear memory by more than its declared bound");
    check(cold > 0, "the sweep made the heap grow");
    printf("{\"mallocSweep\":6000,\"grew\":%ld,\"overBound\":%ld}\n", cold, over);
}

#define SHALLOW "(function () { return 21 * 2; })()"
#define DEPTH "var depth = 0; function f() { depth++; return f(); } try { f(); } catch (e) { if (!(e instanceof RangeError)) throw e; } depth"

static void frame_segments(JSRuntime *rt, JSContext *ctx)
{
    size_t live, committed, limit, before;
    int depth, again;

    check(JS_SetMaxFrameStackSize(rt, PAGE - 1) == 0 && evaluate(ctx, SHALLOW) == -1, "a limit under one page refuses every call as a stack overflow");
    check(watch.requests == 0 && watch.declined > 0, "and asks the allocator for nothing");
    check(JS_SetMaxFrameStackSize(rt, PAGE) == 0 && evaluate(ctx, SHALLOW) == 42, "a limit of exactly one page runs a call");
    JS_GetFrameStackUsage(rt, &live, &committed, &limit);
    check(committed == PAGE && watch.held_declared == PAGE, "its segment is charged one page and kept as the spare");
    check(JS_SetMaxFrameStackSize(rt, 0) == 0 && JS_SetMaxFrameStackSize(rt, DEFAULT_LIMIT) == 0, "the spare is released and the default limit set");
    JS_GetFrameStackUsage(rt, &live, &committed, &limit);
    check(committed == 0 && watch.live == 0, "nothing is charged or held after the release");

    watch.peak_declared = watch.peak_grown = 0;
    before = memory_bytes();
    depth = evaluate(ctx, DEPTH);
    check(depth >= 20685, "plain recursion reaches at least 20,685 frames at the 4 MiB limit");
    check(watch.peak_declared == DEFAULT_LIMIT, "64 segments of one page each fill the limit exactly");
    check(watch.peak_grown <= watch.peak_declared && watch.over_declared == 0, "the memory those segments grew is within what was charged for them");
    check(watch.cold > 0, "the first deep run made linear memory grow");
    printf("{\"plainFrames\":%d,\"segments\":%ld,\"chargedPeak\":%zu,\"grownForSegments\":%zu,\"memoryGrowthOfRun\":%zu}\n",
           depth, watch.requests - 1, watch.peak_declared, watch.peak_grown, memory_bytes() - before);

    /* the freed segments went back to dlmalloc's general heap: the same run needs no new memory */
    check(JS_SetMaxFrameStackSize(rt, 0) == 0 && JS_SetMaxFrameStackSize(rt, DEFAULT_LIMIT) == 0, "every segment is given back");
    watch.cold = watch.warm = 0;
    watch.peak_declared = 0;
    before = memory_bytes();
    again = evaluate(ctx, "depth = 0; try { f(); } catch (e) { if (!(e instanceof RangeError)) throw e; } depth");
    check(again == depth, "the same depth is reached again");
    check(watch.cold == 0 && watch.warm == 64 && memory_bytes() == before, "from storage the allocator kept, without growing memory");
    check(watch.peak_declared == DEFAULT_LIMIT, "and every reused segment is still charged in full");
    check(evaluate(ctx, SHALLOW) == 42, "a call works after the refusals");
}

int main(void)
{
    JSRuntime *rt;
    JSContext *ctx;

    declared_values();
    /* the frame stack first, while the heap is still small enough to have to grow */
    rt = JS_NewRuntime2(&allocator, NULL);
    JS_SetMallocBound(rt, declare);
    ctx = JS_NewContext(rt);
    JS_SetMaxStackSize(rt, 1024 * 1024);
    frame_segments(rt, ctx);
    check(watch.untracked == 0, "every frame block was watched");
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    check(watch.live == 0, "no frame block outlives the runtime");
    malloc_growth();
    printf("wasi checks %d failures %d\n", checks, failures);
    return failures != 0;
}

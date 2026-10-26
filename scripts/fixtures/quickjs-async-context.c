/* Original direct embedder regression. No Node context or Promise replacement. */
#include "quickjs.h"
#include <assert.h>
#include <malloc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern JSValue JS_bunwasm_GetAsyncContext(JSContext *ctx);
extern void JS_bunwasm_SetAsyncContext(JSContext *ctx, JSValueConst value);

static int checks, failures;
typedef struct { int live, fail_after, denied, allocations; } Allocator;

static void check(int ok, const char *label)
{
    checks++;
    if (ok)
        return;
    failures++;
    fprintf(stderr, "FAIL: %s\n", label);
}

static int deny(Allocator *a)
{
    a->allocations++;
    if (a->fail_after < 0)
        return 0;
    if (a->fail_after > 0) {
        a->fail_after--;
        return 0;
    }
    a->denied++;
    return 1;
}

static void *allocate(void *opaque, size_t size)
{
    Allocator *a = opaque;
    void *p;
    if (deny(a))
        return NULL;
    p = malloc(size);
    if (p)
        a->live++;
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
    if (!p)
        return;
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
    if (deny(opaque))
        return NULL;
    return realloc(p, size);
}

static size_t usable_size(const void *p)
{
    return malloc_usable_size((void *)p);
}

static const JSMallocFunctions allocator = {
    allocate_zero, allocate, release, resize, usable_size
};

static JSValue get_frame(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    return JS_bunwasm_GetAsyncContext(ctx);
}

static JSValue set_frame(JSContext *ctx, JSValueConst this_val,
                         int argc, JSValueConst *argv)
{
    JS_bunwasm_SetAsyncContext(ctx, argc ? argv[0] : JS_UNDEFINED);
    return JS_UNDEFINED;
}

static void discard_exception(JSContext *ctx)
{
    JS_FreeValue(ctx, JS_GetException(ctx));
}

static int drain(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    JSContext *job_ctx;
    JSValue before, after;
    int ret;
    while (JS_IsJobPending(rt)) {
        before = JS_bunwasm_GetAsyncContext(ctx);
        ret = JS_ExecutePendingJob(rt, &job_ctx);
        after = JS_bunwasm_GetAsyncContext(ctx);
        check(JS_IsStrictEqual(ctx, before, after), "native job restores ambient frame");
        JS_FreeValue(ctx, before);
        JS_FreeValue(ctx, after);
        if (ret < 0) {
            discard_exception(job_ctx);
            return -1;
        }
    }
    return 0;
}

static JSValue drain_nested(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    if (drain(ctx) < 0)
        return JS_ThrowInternalError(ctx, "nested job failed");
    return JS_UNDEFINED;
}

static JSValue print(JSContext *ctx, JSValueConst this_val,
                      int argc, JSValueConst *argv)
{
    const char *text = JS_ToCString(ctx, argv[0]);
    if (!text)
        return JS_EXCEPTION;
    puts(text);
    JS_FreeCString(ctx, text);
    return JS_UNDEFINED;
}

static JSContext *context(JSRuntime *rt)
{
    JSContext *ctx = JS_NewContext(rt);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "nativeGet", JS_NewCFunction(ctx, get_frame, "nativeGet", 0));
    JS_SetPropertyStr(ctx, global, "nativeSet", JS_NewCFunction(ctx, set_frame, "nativeSet", 1));
    JS_SetPropertyStr(ctx, global, "nativeDrain", JS_NewCFunction(ctx, drain_nested, "nativeDrain", 0));
    JS_SetPropertyStr(ctx, global, "print", JS_NewCFunction(ctx, print, "print", 1));
    JS_FreeValue(ctx, global);
    return ctx;
}

static JSValue evaluate(JSContext *ctx, const char *source)
{
    JSValue value = JS_Eval(ctx, source, strlen(source), "quickjs-context-control", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(value)) {
        JSValue error = JS_GetException(ctx);
        const char *text = JS_ToCString(ctx, error);
        fprintf(stderr, "eval exception: %s\n", text ? text : "unprintable");
        JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, error);
        check(0, "evaluation succeeds");
    }
    return value;
}

static void eval_void(JSContext *ctx, const char *source)
{
    JS_FreeValue(ctx, evaluate(ctx, source));
}

static int fault_case(int offset, int enqueue, int use_memory_limit)
{
    Allocator a = { .fail_after = -1 };
    JSRuntime *rt = JS_NewRuntime2(&allocator, &a);
    JSContext *ctx = context(rt), *job_ctx;
    JSValue global, promise, resolver, thenable, before, after, result;
    int allocation_start, allocation_count, job_result = 0;
    eval_void(ctx, "var resolve; var p = new Promise(r => resolve = r);"
                   "var thenable = { then(r) { nativeSet({ changed: true }); r(42); } };"
                   "nativeSet({ captured: true });");
    global = JS_GetGlobalObject(ctx);
    resolver = JS_GetPropertyStr(ctx, global, "resolve");
    thenable = JS_GetPropertyStr(ctx, global, "thenable");
    promise = JS_GetPropertyStr(ctx, global, "p");
    if (!enqueue) {
        result = JS_Call(ctx, resolver, JS_UNDEFINED, 1, &thenable);
        JS_FreeValue(ctx, result);
        eval_void(ctx, "nativeSet({ ambient: true });");
    }
    before = JS_bunwasm_GetAsyncContext(ctx);
    allocation_start = a.allocations;
    if (use_memory_limit)
        JS_SetMemoryLimit(rt, 1);
    else
        a.fail_after = offset;
    if (enqueue) {
        result = JS_Call(ctx, resolver, JS_UNDEFINED, 1, &thenable);
        JS_FreeValue(ctx, result);
    } else {
        job_result = JS_ExecutePendingJob(rt, &job_ctx);
    }
    allocation_count = a.allocations - allocation_start;
    if (use_memory_limit)
        JS_SetMemoryLimit(rt, 0);
    else
        a.fail_after = -1;
    after = JS_bunwasm_GetAsyncContext(ctx);
    check(JS_IsStrictEqual(ctx, before, after), "allocation failure/success restores ambient");
    if (use_memory_limit)
        check(a.denied == 0, "memory limit fails before the backing allocator");
    else if (offset >= 0)
        check(a.denied > 0, "requested allocation failure was reached");
    if (enqueue) {
        check(!JS_IsJobPending(rt), "failed enqueue publishes no job");
        check(JS_PromiseState(ctx, promise) == JS_PROMISE_PENDING, "existing enqueue OOM leaves pending promise");
    }
    if (use_memory_limit && !enqueue) {
        check(job_result < 0, "memory limit fails resolving-function allocation");
        check(JS_PromiseState(ctx, promise) == JS_PROMISE_PENDING, "failed resolving-function allocation leaves pending promise");
    }
    if (offset < 0 && !use_memory_limit) {
        check(job_result >= 0, "allocation calibration completes");
        check(JS_PromiseState(ctx, promise) == JS_PROMISE_FULFILLED, "allocation calibration fulfills promise");
    }
    discard_exception(ctx);
    JS_FreeValue(ctx, before);
    JS_FreeValue(ctx, after);
    JS_FreeValue(ctx, promise);
    JS_FreeValue(ctx, resolver);
    JS_FreeValue(ctx, thenable);
    JS_FreeValue(ctx, global);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    check(a.live == 0, "allocator releases all engine references");
    return allocation_count;
}

static int contracts(const char *path)
{
    Allocator a = { .fail_after = -1 };
    JSRuntime *rt = JS_NewRuntime2(&allocator, &a);
    JSContext *ctx = context(rt);
    FILE *file = fopen(path, "rb");
    char *source;
    long size;
    JSValue ok;
    if (!file)
        return 1;
    fseek(file, 0, SEEK_END);
    size = ftell(file);
    rewind(file);
    source = malloc(size + 1);
    check(fread(source, 1, size, file) == (size_t)size, "read fixture");
    source[size] = 0;
    fclose(file);
    eval_void(ctx, source);
    free(source);
    check(drain(ctx) == 0, "all native jobs execute");
    ok = evaluate(ctx, "globalThis.contractDone === true && globalThis.contractFailures === 0");
    check(JS_ToBool(ctx, ok), "JavaScript contracts finish with zero failures");
    JS_FreeValue(ctx, ok);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    check(a.live == 0, "all contract engine references released");
    return failures != 0;
}

int main(int argc, char **argv)
{
    int i, allocations;
    if (argc != 2)
        return 2;
    if (strcmp(argv[1], "--faults") == 0) {
        fault_case(0, 1, 1);
        fault_case(0, 0, 1);
#ifdef FORCE_GC_AT_MALLOC
        fault_case(0, 1, 0);
        allocations = fault_case(-1, 0, 0);
        printf("{\"thenableJobAllocations\":%d}\n", allocations);
        for (i = 0; i < allocations; i++)
            fault_case(i, 0, 0);
#endif
    } else {
        contracts(argv[1]);
    }
    printf("{\"nativeChecks\":%d,\"failures\":%d}\n", checks, failures);
    return failures != 0;
}

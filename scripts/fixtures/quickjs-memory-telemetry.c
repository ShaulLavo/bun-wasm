#include "quickjs.h"
#include <assert.h>
#include <inttypes.h>
#include <malloc.h>
#include <stdlib.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

extern JSValue JS_bunwasm_NewWasmMemoryBuffer(JSContext *, uint8_t *, size_t);

_Static_assert(sizeof(JSBunwasmMemoryTelemetry) == 128, "telemetry ABI size");
_Static_assert(offsetof(JSBunwasmMemoryTelemetry, failed_size) == 64, "failure offset");
_Static_assert(offsetof(JSBunwasmMemoryTelemetry, counters_valid) == 88, "valid offset");
_Static_assert(offsetof(JSBunwasmMemoryTelemetry, automatic_gc_count) == 96, "automatic GC count offset");
_Static_assert(offsetof(JSBunwasmMemoryTelemetry, malloc_size_after_automatic_gc) == 104, "automatic GC floor offset");
_Static_assert(offsetof(JSBunwasmMemoryTelemetry, malloc_gc_threshold) == 112, "GC threshold offset");
_Static_assert(offsetof(JSBunwasmMemoryTelemetry, current_malloc_size) == 120, "current malloc offset");

static size_t allocation_calls;
static void *counted_malloc(void *opaque, size_t size) { allocation_calls++; return malloc(size); }
static void *counted_calloc(void *opaque, size_t count, size_t size) { allocation_calls++; return calloc(count, size); }
static void *counted_realloc(void *opaque, void *ptr, size_t size) { allocation_calls++; return realloc(ptr, size); }
static void counted_free(void *opaque, void *ptr) { free(ptr); }
static size_t counted_usable(const void *ptr) { return malloc_usable_size((void *)ptr); }

_Static_assert(sizeof(JSMemoryUsage) == 224, "Rust binding size");
_Static_assert(offsetof(JSMemoryUsage, array_buffer_count) == 208, "Rust count offset");
_Static_assert(offsetof(JSMemoryUsage, array_buffer_size) == 216, "Rust size offset");

static JSMemoryUsage sample(JSRuntime *rt, const char *phase)
{
    JSMemoryUsage usage;
    JS_ComputeMemoryUsage(rt, &usage);
    printf("{\"phase\":\"%s\",\"mallocSize\":%" PRId64
           ",\"arrayBufferSize\":%" PRId64 ",\"arrayBufferCount\":%" PRId64 "}\n",
           phase, usage.malloc_size, usage.array_buffer_size, usage.array_buffer_count);
    return usage;
}

static void expect_failure(JSRuntime *rt, uint32_t expected, uint64_t bytes, bool known)
{
    uint64_t size = 0;
    bool size_known = false;
    size_t before = allocation_calls;
    uint32_t category = JS_bunwasm_GetAllocationFailure(rt, &size, &size_known);
    const JSBunwasmMemoryTelemetry *cached = JS_bunwasm_MemoryTelemetry(rt);
    assert(cached->failed_category == expected);
    assert(cached->failed_size_known == known);
    assert(cached->failed_size == (known ? bytes : UINT64_MAX));
    assert(allocation_calls == before);
    assert(category == expected);
    assert(size_known == known);
    if (known)
        assert(size == bytes);
    printf("{\"failureCategory\":%u,\"size\":%" PRIu64 ",\"sizeKnown\":%s}\n",
           category, size, size_known ? "true" : "false");
}

static void allocation_release(JSRuntime *rt, JSContext *ctx)
{
    JSMemoryUsage baseline = sample(rt, "baseline");
    void *block = js_malloc_rt(rt, 1048576);
    assert(block);
    JSMemoryUsage allocated = sample(rt, "malloc-live");
    assert(allocated.malloc_size >= baseline.malloc_size + 1048576);
    js_free_rt(rt, block);
    assert(sample(rt, "malloc-released").malloc_size == baseline.malloc_size);

    JSValue buffer = JS_NewArrayBufferCopy(ctx, NULL, 1048576);
    assert(!JS_IsException(buffer));
    JSMemoryUsage live = sample(rt, "buffer-live");
    assert(live.array_buffer_size == baseline.array_buffer_size + 1048576);
    assert(live.array_buffer_count == baseline.array_buffer_count + 1);
    JS_DetachArrayBuffer(ctx, buffer);
    assert(sample(rt, "buffer-detached").array_buffer_size == baseline.array_buffer_size);
    JS_FreeValue(ctx, buffer);
    assert(sample(rt, "buffer-released").array_buffer_count == baseline.array_buffer_count);

    uint8_t borrowed[4096] = {0};
    buffer = JS_bunwasm_NewWasmMemoryBuffer(ctx, borrowed, sizeof(borrowed));
    assert(!JS_IsException(buffer));
    assert(sample(rt, "wasm-alias").array_buffer_size == baseline.array_buffer_size);
    JS_FreeValue(ctx, buffer);

    const char *source = "(() => { const b = new SharedArrayBuffer(4096); return [b, new Uint8Array(b), new DataView(b)]; })()";
    buffer = JS_Eval(ctx, source, strlen(source), "shared", JS_EVAL_TYPE_GLOBAL);
    assert(!JS_IsException(buffer));
    JSMemoryUsage shared = sample(rt, "shared-with-views");
    assert(shared.array_buffer_size == baseline.array_buffer_size + 4096);
    assert(shared.array_buffer_count == baseline.array_buffer_count + 1);
    JS_FreeValue(ctx, buffer);
    assert(sample(rt, "shared-released").array_buffer_count == baseline.array_buffer_count);
}

static void automatic_gc_state(JSRuntime *rt, JSContext *ctx)
{
    JS_bunwasm_RefreshMemoryTelemetry(rt);
    const JSBunwasmMemoryTelemetry *before = JS_bunwasm_MemoryTelemetry(rt);
    uint64_t gc_before = before->automatic_gc_count;
    for (int i = 0; i < 10000 && before->automatic_gc_count == gc_before; i++) {
        const char *source =
            "(() => { const a = {}; a.self = a; a.payload = 'x'.repeat(4096); return a; })()";
        JSValue value = JS_Eval(ctx, source, strlen(source), "automatic-gc", JS_EVAL_TYPE_GLOBAL);
        assert(!JS_IsException(value));
        JS_FreeValue(ctx, value);
        before = JS_bunwasm_MemoryTelemetry(rt);
    }
    const JSBunwasmMemoryTelemetry *after = JS_bunwasm_MemoryTelemetry(rt);
    assert(after->automatic_gc_count > gc_before);
    assert(after->malloc_size_after_automatic_gc != UINT64_MAX);
    assert(after->malloc_gc_threshold == JS_GetGCThreshold(rt));
    assert(after->current_malloc_size >= after->malloc_size_after_automatic_gc);
    printf("{\"automaticGcCount\":%" PRIu64 ",\"mallocSizeAfterAutomaticGc\":%" PRIu64
           ",\"mallocGcThreshold\":%" PRIu64 ",\"currentMallocSize\":%" PRIu64 "}\n",
           after->automatic_gc_count, after->malloc_size_after_automatic_gc,
           after->malloc_gc_threshold, after->current_malloc_size);
}

static void bounded_failures(JSRuntime *rt, JSContext *ctx)
{
    const size_t request = 1048576;
    JSMemoryUsage usage = sample(rt, "before-failures");
    JS_SetMemoryLimit(rt, usage.malloc_size + 65536);
    JS_bunwasm_ClearAllocationFailure(rt);
    assert(!js_malloc(ctx, request));
    expect_failure(rt, JS_BUNWASM_ALLOC_MALLOC, request, true);
    JS_FreeValue(ctx, JS_GetException(ctx));
    assert(!js_calloc_rt(rt, 1, request + 1));
    expect_failure(rt, JS_BUNWASM_ALLOC_MALLOC, request, true);

    JS_bunwasm_ClearAllocationFailure(rt);
    assert(!js_calloc(ctx, 2, request));
    JS_FreeValue(ctx, JS_GetException(ctx));
    expect_failure(rt, JS_BUNWASM_ALLOC_CALLOC, 2 * request, true);

    JS_bunwasm_ClearAllocationFailure(rt);
    assert(!js_realloc(ctx, NULL, 2 * request));
    JS_FreeValue(ctx, JS_GetException(ctx));
    expect_failure(rt, JS_BUNWASM_ALLOC_REALLOC, 2 * request, true);

    JS_bunwasm_ClearAllocationFailure(rt);
    void *block = js_malloc_rt(rt, 4096);
    assert(block);
    assert(!js_realloc(ctx, block, request));
    JS_FreeValue(ctx, JS_GetException(ctx));
    expect_failure(rt, JS_BUNWASM_ALLOC_REALLOC, request, true);
    js_free_rt(rt, block);

    JS_bunwasm_ClearAllocationFailure(rt);
    JSValue failed = JS_NewArrayBufferCopy(ctx, NULL, request);
    assert(JS_IsException(failed));
    JS_FreeValue(ctx, JS_GetException(ctx));
    expect_failure(rt, JS_BUNWASM_ALLOC_ARRAY_BUFFER, request, true);

    JS_bunwasm_ClearAllocationFailure(rt);
    const char *resize = "new ArrayBuffer(1, {maxByteLength:2097152}).resize(2097152)";
    failed = JS_Eval(ctx, resize, strlen(resize), "failed-resize", JS_EVAL_TYPE_GLOBAL);
    assert(JS_IsException(failed));
    JS_FreeValue(ctx, JS_GetException(ctx));
    expect_failure(rt, JS_BUNWASM_ALLOC_ARRAY_BUFFER, 2 * request, true);

    JS_bunwasm_ClearAllocationFailure(rt);
    assert(!js_calloc_rt(rt, SIZE_MAX, 2));
    expect_failure(rt, JS_BUNWASM_ALLOC_CALLOC, 0, false);
    JS_SetMemoryLimit(rt, 0);
    JS_bunwasm_ClearAllocationFailure(rt);
    expect_failure(rt, 0, 0, false);
}

static void cached_readout(JSRuntime *rt)
{
    const JSBunwasmMemoryTelemetry *cached = JS_bunwasm_MemoryTelemetry(rt);
    assert(cached->abi_version == 1 && cached->byte_size == 128);
    assert(cached->refresh_sequence == 0 && cached->counters_valid == 0);
    assert(cached->malloc_size == UINT64_MAX);
    cached = JS_bunwasm_RefreshMemoryTelemetry(rt);
    uint64_t baseline = cached->malloc_size;
    uint64_t sequence = cached->refresh_sequence;
    void *block = js_malloc_rt(rt, 1048576);
    assert(block);
    size_t before = allocation_calls;
    for (int i = 0; i < 1000; i++) {
        cached = JS_bunwasm_MemoryTelemetry(rt);
        assert(cached->malloc_size == baseline);
        assert(cached->refresh_sequence == sequence);
    }
    assert(allocation_calls == before);
    cached = JS_bunwasm_RefreshMemoryTelemetry(rt);
    assert(cached->malloc_size >= baseline + 1048576);
    js_free_rt(rt, block);
    JS_bunwasm_RefreshMemoryTelemetry(rt);
    printf("{\"cachedReads\":1000,\"allocatorCalls\":0,\"abiBytes\":128,\"automaticGcCount\":%" PRIu64 ",\"mallocGcThreshold\":%" PRIu64 ",\"currentMallocSize\":%" PRIu64 "}\n", cached->automatic_gc_count, cached->malloc_gc_threshold, cached->current_malloc_size);
}

int main(void)
{
    const JSMallocFunctions functions = {
        counted_calloc, counted_malloc, counted_free, counted_realloc, counted_usable
    };
    JSRuntime *rt = JS_NewRuntime2(&functions, NULL);
    assert(rt);
    JSContext *ctx = JS_NewContext(rt);
    assert(ctx);
    cached_readout(rt);
    allocation_release(rt, ctx);
    automatic_gc_state(rt, ctx);
    bounded_failures(rt, ctx);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    puts("QuickJS telemetry controls passed without forced GC");
    return 0;
}

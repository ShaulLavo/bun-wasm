/* Original direct embedder regression for the iterative statement parser.
   Drives the QuickJS compiler without the bun-wasm runtime: compile-only output
   hashes, script runs, stack sweeps, allocation faults and record-limit contracts.
   scripts/check-quickjs-parser-stack.ts builds and runs it. */
#include "quickjs.h"
#include <malloc.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define THREAD_STACK ((size_t)512 << 20)
#define AMPLE_STACK ((size_t)448 << 20)
#define RECORD_LIMIT 10000

/* watch_size 0 counts every allocation; otherwise only allocations of that
   exact size are counted and can be denied. */
typedef struct { long live; long live_bytes; long calls; long fail_at; long denied; size_t watch_size; } Allocator;
typedef struct { int argc; char **argv; int status; } Job;
typedef struct { size_t size; long count; } SizeCount;

#define HISTOGRAM_SIZES 8192
static Allocator memory = { 0, 0, 0, -1, 0, 0 };
static SizeCount histogram[HISTOGRAM_SIZES];
static int histogram_on;
static int checks, failures;
static long probed_bytes;

static void check(int ok, const char *label)
{
    checks++;
    if (ok)
        return;
    failures++;
    fprintf(stderr, "FAIL: %s\n", label);
}

static void record_size(size_t size)
{
    size_t slot = size % HISTOGRAM_SIZES;
    int probes;
    for (probes = 0; probes < HISTOGRAM_SIZES; probes++, slot = (slot + 1) % HISTOGRAM_SIZES) {
        if (histogram[slot].count && histogram[slot].size != size)
            continue;
        histogram[slot].size = size;
        histogram[slot].count++;
        return;
    }
}

static long recorded(size_t size)
{
    size_t slot = size % HISTOGRAM_SIZES;
    int probes;
    for (probes = 0; probes < HISTOGRAM_SIZES; probes++, slot = (slot + 1) % HISTOGRAM_SIZES) {
        if (!histogram[slot].count)
            return 0;
        if (histogram[slot].size == size)
            return histogram[slot].count;
    }
    return 0;
}

static int deny(Allocator *a, size_t size)
{
    if (histogram_on)
        record_size(size);
    if (a->watch_size && size != a->watch_size)
        return 0;
    a->calls++;
    if (a->fail_at < 0 || a->calls != a->fail_at)
        return 0;
    a->denied++;
    return 1;
}

/* Every request goes unchanged to the engine's default callbacks, so these
   callbacks may declare the default bound for the frame stack. */
#define backing() JS_GetDefaultMallocFunctions()

static void *allocate(void *opaque, size_t size)
{
    Allocator *a = opaque;
    void *p;
    if (deny(a, size))
        return NULL;
    p = backing()->js_malloc(NULL, size);
    if (!p)
        return NULL;
    a->live++;
    a->live_bytes += (long)backing()->js_malloc_usable_size(p);
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
    a->live_bytes -= (long)backing()->js_malloc_usable_size(p);
    backing()->js_free(NULL, p);
}

static void *resize(void *opaque, void *p, size_t size)
{
    Allocator *a = opaque;
    void *q;
    if (!p)
        return allocate(opaque, size);
    if (!size) {
        release(opaque, p);
        return NULL;
    }
    if (deny(a, size))
        return NULL;
    a->live_bytes -= (long)backing()->js_malloc_usable_size(p);
    q = backing()->js_realloc(NULL, p, size);
    a->live_bytes += (long)backing()->js_malloc_usable_size(q ? q : p);
    return q;
}

static size_t usable_size(const void *p)
{
    return backing()->js_malloc_usable_size(p);
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

static JSValue probe(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv)
{
    probed_bytes = memory.live_bytes;
    return JS_UNDEFINED;
}

static int stub_init(JSContext *ctx, JSModuleDef *m)
{
    return 0;
}

/* Closed dependency graph: every import resolves to an empty native module. */
static JSModuleDef *stub_loader(JSContext *ctx, const char *name, void *opaque)
{
    return JS_NewCModule(ctx, name, stub_init);
}

static JSContext *new_context(JSRuntime **prt, size_t stack)
{
    JSRuntime *rt = JS_NewRuntime2(&allocator, &memory);
    JSContext *ctx;
    JSValue global;
    JS_SetMallocBound(rt, JS_DefaultMallocBound);
    ctx = JS_NewContext(rt);
    global = JS_GetGlobalObject(ctx);
    JS_UpdateStackTop(rt);
    JS_SetMaxStackSize(rt, stack);
    JS_SetModuleLoaderFunc(rt, NULL, stub_loader, NULL);
    JS_SetPropertyStr(ctx, global, "print", JS_NewCFunction(ctx, print, "print", 1));
    JS_SetPropertyStr(ctx, global, "probe", JS_NewCFunction(ctx, probe, "probe", 0));
    JS_FreeValue(ctx, global);
    *prt = rt;
    return ctx;
}

static void free_context(JSRuntime *rt, JSContext *ctx)
{
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
}

/* Formats the pending exception as "Name: message | stack" on one line. */
static void describe_exception(JSContext *ctx, char *out, size_t size)
{
    JSValue error = JS_GetException(ctx);
    JSValue stack = JS_GetPropertyStr(ctx, error, "stack");
    const char *text = JS_ToCString(ctx, error);
    const char *trace = JS_IsUndefined(stack) ? NULL : JS_ToCString(ctx, stack);
    char *p;
    snprintf(out, size, "%s | %s", text ? text : "<unprintable>", trace ? trace : "");
    for (p = out; *p; p++) {
        if (*p == '\n')
            *p = '|';
    }
    if (text)
        JS_FreeCString(ctx, text);
    if (trace)
        JS_FreeCString(ctx, trace);
    JS_FreeValue(ctx, stack);
    JS_FreeValue(ctx, error);
}

typedef struct { char *text; size_t len; int flags; int line; } Source;

/* MODE is script, module or cjs. cjs applies the runtime's CommonJS wrapper
   (crates/bunwasm-runtime/src/modules.rs, cjs_wrapper) and its first line. */
static Source load_source(const char *mode, const char *path)
{
    static const char prefix[] = "(function __bunwasm_cjs__(exports, require, module, __filename, __dirname) {\n\n";
    Source source = { NULL, 0, JS_EVAL_TYPE_GLOBAL, 1 };
    size_t len;
    char *body = read_file(path, &len);
    if (!strcmp(mode, "module"))
        source.flags = JS_EVAL_TYPE_MODULE;
    if (strcmp(mode, "cjs")) {
        source.text = body;
        source.len = len;
        return source;
    }
    source.text = malloc(len + sizeof(prefix) + 4);
    source.len = (size_t)sprintf(source.text, "%s", prefix);
    memcpy(source.text + source.len, body, len);
    memcpy(source.text + source.len + len, "\n})", 4);
    source.len += len + 3;
    source.line = -1;
    free(body);
    return source;
}

static JSValue compile(JSContext *ctx, const Source *source, const char *filename)
{
    JSEvalOptions options = { JS_EVAL_OPTIONS_VERSION, source->flags | JS_EVAL_FLAG_COMPILE_ONLY, filename, source->line };
    return JS_Eval2(ctx, source->text, source->len, &options);
}

static uint64_t fnv1a(const uint8_t *data, size_t len)
{
    uint64_t hash = 0xcbf29ce484222325ull;
    size_t i;
    for (i = 0; i < len; i++)
        hash = (hash ^ data[i]) * 0x100000001b3ull;
    return hash;
}

/* compile MODE FILE FILENAME: prints "ok <bytes> <hash>" for the serialized
   bytecode with debug tables and source, or "error <description>". */
static int mode_compile(char **argv)
{
    JSRuntime *rt;
    JSContext *ctx = new_context(&rt, AMPLE_STACK);
    Source source = load_source(argv[0], argv[1]);
    JSValue value = compile(ctx, &source, argv[2]);
    char text[4096];
    uint8_t *bytes;
    size_t size;
    if (JS_IsException(value)) {
        describe_exception(ctx, text, sizeof(text));
        printf("error %s\n", text);
        free_context(rt, ctx);
        free(source.text);
        return 0;
    }
    bytes = JS_WriteObject(ctx, &size, value, JS_WRITE_OBJ_BYTECODE);
    if (!bytes) {
        describe_exception(ctx, text, sizeof(text));
        printf("unserializable %s\n", text);
    } else {
        printf("ok %zu %016llx\n", size, (unsigned long long)fnv1a(bytes, size));
        js_free(ctx, bytes);
    }
    JS_FreeValue(ctx, value);
    free_context(rt, ctx);
    free(source.text);
    return 0;
}

/* batch LIST: one "MODE<tab>FILE<tab>FILENAME" per line, one compile result
   line each, every input in a fresh runtime. */
static int mode_batch(char **argv)
{
    FILE *list = fopen(argv[0], "r");
    char line[8192];
    if (!list)
        return 2;
    while (fgets(line, sizeof(line), list)) {
        char *fields[3];
        fields[0] = strtok(line, "\t\n");
        fields[1] = strtok(NULL, "\t\n");
        fields[2] = strtok(NULL, "\t\n");
        if (!fields[0] || !fields[1] || !fields[2])
            return 2;
        mode_compile(fields);
    }
    fclose(list);
    return memory.live != 0;
}

static int drain(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    JSContext *job_ctx;
    char text[4096];
    while (JS_IsJobPending(rt)) {
        if (JS_ExecutePendingJob(rt, &job_ctx) >= 0)
            continue;
        describe_exception(job_ctx, text, sizeof(text));
        printf("job error %s\n", text);
        return -1;
    }
    return 0;
}

/* run FILE [stack bytes]: evaluates a script that reports through print(). */
static int mode_run(int argc, char **argv)
{
    JSRuntime *rt;
    JSContext *ctx = new_context(&rt, argc > 1 ? (size_t)atol(argv[1]) : AMPLE_STACK);
    size_t len;
    char *text = read_file(argv[0], &len);
    JSValue value = JS_Eval(ctx, text, len, argv[0], JS_EVAL_TYPE_GLOBAL);
    char description[4096];
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

static int sweep_exception_replaced(long size, const char *text)
{
    if (!strncmp(text, "RangeError: Maximum call stack size exceeded", 44))
        return 0;
    printf("replaced at %ld: %s\n", size, text);
    return 1;
}

/* sweep MODE FILE LOW HIGH STEP: compiles valid input at each stack limit. A
   valid input may only compile or refuse with RangeError; anything else means
   a pending overflow was replaced. */
static int mode_sweep(char **argv)
{
    Source source = load_source(argv[0], argv[1]);
    long low = atol(argv[2]), high = atol(argv[3]), step = atol(argv[4]), size;
    long compiled = 0, refused = 0, replaced = 0;
    char text[4096];
    for (size = low; size <= high; size += step) {
        JSRuntime *rt;
        JSContext *ctx = new_context(&rt, (size_t)size);
        JSValue value = compile(ctx, &source, "sweep.js");
        JSValue again;
        if (!JS_IsException(value)) {
            compiled++;
        } else {
            int wrong;
            describe_exception(ctx, text, sizeof(text));
            wrong = sweep_exception_replaced(size, text);
            replaced += wrong;
            refused += !wrong;
        }
        JS_FreeValue(ctx, value);
        JS_SetMaxStackSize(rt, AMPLE_STACK);
        again = JS_Eval(ctx, "21 * 2", 6, "recover.js", JS_EVAL_TYPE_GLOBAL);
        if (JS_VALUE_GET_TAG(again) != JS_TAG_INT || JS_VALUE_GET_INT(again) != 42) {
            replaced++;
            printf("no recovery at %ld\n", size);
        }
        JS_FreeValue(ctx, again);
        free_context(rt, ctx);
    }
    free(source.text);
    printf("sweep compiled %ld refused %ld replaced %ld live %ld\n", compiled, refused, replaced, memory.live);
    return replaced != 0 || memory.live != 0;
}

static int recovers(JSContext *ctx);

typedef struct { char *text; size_t len, cap; } Text;

static void put(Text *t, const char *piece, int count)
{
    size_t piece_len = strlen(piece);
    int i;
    if (t->len + piece_len * (size_t)count + 1 > t->cap) {
        t->cap = (t->len + piece_len * (size_t)count + 1) * 2;
        t->text = realloc(t->text, t->cap);
    }
    for (i = 0; i < count; i++) {
        memcpy(t->text + t->len, piece, piece_len);
        t->len += piece_len;
    }
    t->text[t->len] = 0;
}

static long count_size(JSContext *ctx, size_t size, int depth)
{
    Text t = { NULL, 0, 0 };
    JSValue value;
    put(&t, "{", depth);
    put(&t, ";", 1);
    put(&t, "}", depth);
    memset(histogram, 0, sizeof(histogram));
    histogram_on = 1;
    value = JS_Eval(ctx, t.text, t.len, "size.js", JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
    histogram_on = 0;
    JS_FreeValue(ctx, value);
    free(t.text);
    return recorded(size);
}

/* The record pool grows by one chunk of 16 records at a time. Its chunk is
   the one allocation size requested once for 1 nested block, twice for 17
   and three times for 33. Returns 0 unless exactly one size fits. */
static size_t find_chunk_size(JSContext *ctx)
{
    static SizeCount deep[HISTOGRAM_SIZES];
    size_t found = 0;
    int matches = 0, i;
    count_size(ctx, 0, 33);
    memcpy(deep, histogram, sizeof(deep));
    for (i = 0; i < HISTOGRAM_SIZES; i++) {
        size_t size = deep[i].size;
        if (deep[i].count != 3)
            continue;
        if (count_size(ctx, size, 17) != 2 || count_size(ctx, size, 1) != 1 || count_size(ctx, size, 0) != 0)
            continue;
        found = size;
        matches++;
    }
    return matches == 1 ? found : 0;
}

static int deny_record_chunk(JSContext *ctx, const Source *source, long index)
{
    char description[4096];
    int reported = 0;
    JSValue value;
    memory.calls = 0;
    memory.fail_at = index;
    value = compile(ctx, source, "faults.js");
    memory.fail_at = -1;
    if (JS_IsException(value)) {
        describe_exception(ctx, description, sizeof(description));
        reported = !strncmp(description, "InternalError: out of memory", 28);
    }
    JS_FreeValue(ctx, value);
    check(recovers(ctx), "engine usable after a denied record chunk");
    return reported;
}

/* faults MODE FILE: denies each record-pool allocation of one compile in
   turn, with the input shifted to every position inside a chunk so the
   denied push lands on every suspended statement kind. Each denial must
   surface as an error, leave the engine usable and leak nothing. Failures
   of other allocations belong to upstream paths this check does not own. */
static int mode_faults(char **argv)
{
    Source source = load_source(argv[0], argv[1]);
    JSRuntime *rt;
    JSContext *ctx = new_context(&rt, AMPLE_STACK);
    size_t chunk = find_chunk_size(ctx);
    long denied = 0, reported = 0;
    int pad;
    check(chunk != 0, "record pool chunk size identified");
    for (pad = 0; chunk && pad < 16; pad++) {
        Text t = { NULL, 0, 0 };
        Source shifted = source;
        long index, total;
        JSValue value;
        put(&t, "{", pad);
        put(&t, source.text, 1);
        put(&t, "}", pad);
        shifted.text = t.text;
        shifted.len = t.len;
        memory.watch_size = chunk;
        memory.calls = 0;
        value = compile(ctx, &shifted, "faults.js");
        total = memory.calls;
        check(!JS_IsException(value), "fault input compiles without faults");
        check(total >= 2, "fault input needs more than one record chunk");
        JS_FreeValue(ctx, value);
        for (index = 1; index <= total; index++) {
            denied++;
            reported += deny_record_chunk(ctx, &shifted, index);
        }
        memory.watch_size = 0;
        free(t.text);
    }
    check(denied > 0 && reported == denied, "every denied record chunk is reported as out of memory");
    free_context(rt, ctx);
    free(source.text);
    check(memory.live == 0, "no allocation leaked across faults");
    printf("faults chunk bytes %zu denied %ld reported %ld live %ld checks %d failures %d\n", chunk, denied, reported, memory.live, checks, failures);
    return failures != 0;
}

/* time MODE FILE COUNT: nanoseconds per successful compile, one line each. */
static int mode_time(char **argv)
{
    Source source = load_source(argv[0], argv[1]);
    int count = atoi(argv[2]), i;
    for (i = 0; i < count; i++) {
        JSRuntime *rt;
        JSContext *ctx = new_context(&rt, AMPLE_STACK);
        struct timespec start, end;
        JSValue value;
        clock_gettime(CLOCK_MONOTONIC, &start);
        value = compile(ctx, &source, "time.js");
        clock_gettime(CLOCK_MONOTONIC, &end);
        if (JS_IsException(value))
            return 1;
        printf("%lld\n", (long long)(end.tv_sec - start.tv_sec) * 1000000000ll + (end.tv_nsec - start.tv_nsec));
        JS_FreeValue(ctx, value);
        free_context(rt, ctx);
    }
    return 0;
}

/* Like put, but a "%d" in the piece becomes the level number: labels must differ. */
static void put_levels(Text *t, const char *piece, int count)
{
    char numbered[64];
    int i;
    if (!strstr(piece, "%d")) {
        put(t, piece, count);
        return;
    }
    for (i = 0; i < count; i++) {
        snprintf(numbered, sizeof(numbered), piece, i);
        put(t, numbered, 1);
    }
}

/* 0 compiled, 1 RangeError, 2 any other error. */
static int outcome(JSContext *ctx, const Text *t)
{
    JSValue value = JS_Eval(ctx, t->text, t->len, "contract.js", JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
    char text[4096];
    int result = 0;
    if (JS_IsException(value)) {
        describe_exception(ctx, text, sizeof(text));
        result = strncmp(text, "RangeError: Maximum call stack size exceeded", 44) ? 2 : 1;
        if (result == 2)
            fprintf(stderr, "unexpected: %.300s\n", text);
    }
    JS_FreeValue(ctx, value);
    return result;
}

static int recovers(JSContext *ctx)
{
    JSValue value = JS_Eval(ctx, "21 * 2", 6, "recover.js", JS_EVAL_TYPE_GLOBAL);
    int ok = JS_VALUE_GET_TAG(value) == JS_TAG_INT && JS_VALUE_GET_INT(value) == 42;
    JS_FreeValue(ctx, value);
    return ok;
}

/* Each shape states how many statement records it keeps suspended at its
   deepest point. The limit is RECORD_LIMIT records per parse. */
static void boundary(JSContext *ctx, const char *label, const char *open, const char *inner,
                     const char *close, int per_level, int wrapper_records)
{
    int accepted = (RECORD_LIMIT - wrapper_records) / per_level;
    int depths[3] = { accepted - 1, accepted, accepted + 1 };
    int expected[3] = { 0, 0, 1 };
    char name[160];
    int i;
    for (i = 0; i < 3; i++) {
        Text t = { NULL, 0, 0 };
        /* the only wrapped shape puts its nest inside one braced loop: two records */
        put(&t, "while(0){", wrapper_records / 2);
        put_levels(&t, open, depths[i]);
        put(&t, inner, 1);
        put(&t, close, depths[i]);
        put(&t, "}", wrapper_records / 2);
        snprintf(name, sizeof(name), "%s at depth %d (%d records)", label, depths[i], depths[i] * per_level + wrapper_records);
        check(outcome(ctx, &t) == expected[i], name);
        check(recovers(ctx), "shallow eval after boundary case");
        free(t.text);
    }
}

static void reentry_boundary(JSContext *ctx)
{
    /* outer blocks stay suspended while the nested function body is parsed:
       outer + inner block records, the function body loop adds none. */
    int inner[3] = { 3999, 4000, 4001 };
    int expected[3] = { 0, 0, 1 };
    int i;
    for (i = 0; i < 3; i++) {
        Text t = { NULL, 0, 0 };
        put(&t, "{", 6000);
        put(&t, "(function(){", 1);
        put(&t, "{", inner[i]);
        put(&t, ";", 1);
        put(&t, "}", inner[i]);
        put(&t, "});", 1);
        put(&t, "}", 6000);
        check(outcome(ctx, &t) == expected[i], "function reentry counts outer and inner records");
        check(recovers(ctx), "shallow eval after reentry case");
        free(t.text);
    }
}

static void refusal(JSContext *ctx, const char *label, const char *open, const char *inner, const char *close)
{
    Text t = { NULL, 0, 0 };
    put(&t, open, 200000);
    put(&t, inner, 1);
    put(&t, close, 200000);
    check(outcome(ctx, &t) == 1, label);
    check(recovers(ctx), "shallow eval after depth 200000");
    free(t.text);
}

static void nested_failure(JSContext *ctx)
{
    /* a syntax error inside a function parsed from a loop header, with labels,
       iterators and blocks suspended in both drivers */
    static const char source[] =
        "a: for (const x of [1]) { b: { try { for (var i = (function () { c: while (1) { { @ } } })(); ; ) ; } finally { } } }";
    JSValue value = JS_Eval(ctx, source, sizeof(source) - 1, "nested.js", JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_COMPILE_ONLY);
    char text[4096];
    check(JS_IsException(value), "nested driver failure is reported");
    describe_exception(ctx, text, sizeof(text));
    check(!strncmp(text, "SyntaxError", 11), "nested driver failure stays a SyntaxError");
    JS_FreeValue(ctx, value);
    check(recovers(ctx), "shallow eval after nested driver failure");
}

/* The record pool of a finished parse must be gone before the program runs. */
static void pool_released_before_execution(JSContext *ctx)
{
    long shallow, deep;
    JSValue value;
    Text t = { NULL, 0, 0 };
    value = JS_Eval(ctx, "{ ; } probe();", 14, "pool.js", JS_EVAL_TYPE_GLOBAL);
    JS_FreeValue(ctx, value);
    shallow = probed_bytes;
    put(&t, "{", 9000);
    put(&t, ";", 1);
    put(&t, "}", 9000);
    put(&t, " probe();", 1);
    probed_bytes = -1;
    value = JS_Eval(ctx, t.text, t.len, "pool.js", JS_EVAL_TYPE_GLOBAL);
    check(!JS_IsException(value), "deep program runs");
    JS_FreeValue(ctx, value);
    deep = probed_bytes;
    check(deep >= 0, "deep program reached its probe");
    printf("pool shallow %ld deep %ld\n", shallow, deep);
    check(deep - shallow < 512 * 1024, "statement records are released before execution");
    free(t.text);
}

static int mode_contract(void)
{
    JSRuntime *rt;
    JSContext *ctx = new_context(&rt, AMPLE_STACK);
    boundary(ctx, "unbraced if", "if(0)", ";", "", 1, 0);
    boundary(ctx, "braced if", "if(0){", ";", "}", 2, 0);
    boundary(ctx, "block", "{", ";", "}", 1, 0);
    boundary(ctx, "labelled statement", "l%d:", ";", "", 1, 0);
    boundary(ctx, "labelled loop shares a record", "l%d:while(0)", ";", "", 1, 0);
    boundary(ctx, "labelled block", "l%d:{", ";", "}", 2, 0);
    boundary(ctx, "braced loop", "while(0){", ";", "}", 2, 0);
    boundary(ctx, "try body", "try{", ";", "}finally{}", 2, 0);
    boundary(ctx, "block inside one braced loop", "{", ";", "}", 1, 2);
    reentry_boundary(ctx);
    refusal(ctx, "block refuses at depth 200000", "{", "", "}");
    refusal(ctx, "statement refuses at depth 200000", "if(0)", ";", "");
    nested_failure(ctx);
    pool_released_before_execution(ctx);
    free_context(rt, ctx);
    check(memory.live == 0, "no allocation outlives the runtime");
    printf("contract checks %d failures %d live %ld\n", checks, failures, memory.live);
    return failures != 0;
}

static void *run_job(void *opaque)
{
    Job *job = opaque;
    const char *mode = job->argc > 1 ? job->argv[1] : "";
    char **rest = job->argv + 2;
    if (!strcmp(mode, "compile") && job->argc == 5)
        job->status = mode_compile(rest);
    else if (!strcmp(mode, "batch") && job->argc == 3)
        job->status = mode_batch(rest);
    else if (!strcmp(mode, "run") && job->argc >= 3)
        job->status = mode_run(job->argc - 2, rest);
    else if (!strcmp(mode, "sweep") && job->argc == 7)
        job->status = mode_sweep(rest);
    else if (!strcmp(mode, "faults") && job->argc == 4)
        job->status = mode_faults(rest);
    else if (!strcmp(mode, "time") && job->argc == 5)
        job->status = mode_time(rest);
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
        fprintf(stderr, "usage: compile MODE FILE NAME | batch LIST | run FILE [STACK] | sweep MODE FILE LOW HIGH STEP | faults MODE FILE | time MODE FILE COUNT | contract\n");
    return job.status;
}

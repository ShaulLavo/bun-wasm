#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <assert.h>
#include <sys/resource.h>

typedef struct { size_t live; } Counts;
static Counts counts;
#define backing() JS_GetDefaultMallocFunctions()

static void *allocate(void *opaque, size_t size)
{
    void *p = backing()->js_malloc(NULL, size);
    counts.live += p != NULL;
    return p;
}

static void *allocate_zero(void *opaque, size_t count, size_t size)
{
    void *p = allocate(opaque, count * size);
    if (p) memset(p, 0, count * size);
    return p;
}

static void release(void *opaque, void *p)
{
    counts.live -= p != NULL;
    backing()->js_free(NULL, p);
}

static void *resize(void *opaque, void *p, size_t size)
{
    if (!p) return allocate(opaque, size);
    if (!size) { release(opaque, p); return NULL; }
    return backing()->js_realloc(NULL, p, size);
}

static size_t usable_size(const void *p)
{
    return backing()->js_malloc_usable_size(p);
}

static JSValue print(JSContext *ctx, JSValueConst receiver, int argc, JSValueConst *argv)
{
    const char *text = JS_ToCString(ctx, argv[0]);
    if (!text) return JS_EXCEPTION;
    puts(text);
    JS_FreeCString(ctx, text);
    return JS_UNDEFINED;
}

static JSValue evaluate(JSContext *ctx, const char *source)
{
    return JS_Eval(ctx, source, strlen(source), "regexp-native-control", JS_EVAL_TYPE_GLOBAL);
}

static void expect_true(JSContext *ctx, const char *source)
{
    JSValue result = evaluate(ctx, source);
    if (JS_IsException(result) || JS_ToBool(ctx, result) != 1)
        fprintf(stderr, "native control failed: %s\n", source);
    assert(!JS_IsException(result));
    assert(JS_ToBool(ctx, result) == 1);
    JS_FreeValue(ctx, result);
}

static int interrupt(JSRuntime *rt, void *opaque)
{
    int *calls = opaque;
    ++*calls;
    return 1;
}

static JSValue limit_stack(JSContext *ctx, JSValueConst receiver, int argc, JSValueConst *argv)
{
    JS_SetMaxStackSize(JS_GetRuntime(ctx), 1);
    return JS_UNDEFINED;
}

static void native_checks(JSContext *ctx)
{
    JSRuntime *rt = JS_GetRuntime(ctx);
    JSContext *other = JS_NewContext(rt);
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue result, exception, function;
    int calls = 0;

    JS_SetPropertyStr(ctx, global, "foreignExec", evaluate(other, "RegExp.prototype.exec"));
    JS_SetPropertyStr(ctx, global, "foreignTypeError", evaluate(other, "TypeError"));
    JS_SetPropertyStr(ctx, global, "limitStack", JS_NewCFunction(ctx, limit_stack, "limitStack", 0));
    JS_FreeValue(ctx, global);
    expect_true(ctx, "(()=>{try { RegExp.prototype.test.call({exec:foreignExec}, 'a'); } catch(e) { return e instanceof foreignTypeError && !(e instanceof TypeError); }})()");
    expect_true(ctx, "(()=>{const re=/a/g; re.exec=foreignExec; return re.test('ba') && re.lastIndex===2 && !re.test('x') && re.lastIndex===0;})()");
    expect_true(ctx, "(()=>{let stack;const re=/a/;re.test({toString(){stack=new Error().stack;return 'a'}});return stack.includes('at exec (native)');})()");
    result = evaluate(ctx, "(()=>{const re=/a/;Object.defineProperty(re,'exec',{get(){limitStack();return RegExp.prototype.exec}});return re.test('a');})()");
    JS_SetMaxStackSize(rt, 4 * 1024 * 1024);
    assert(JS_IsException(result));
    exception = JS_GetException(ctx);
    JS_FreeValue(ctx, exception);
    JS_FreeValue(ctx, result);
    JS_SetInterruptHandler(rt, interrupt, &calls);
    result = evaluate(ctx, "/(a+)+$/.test('a'.repeat(128)+'b')");
    assert(JS_IsException(result));
    assert(calls > 0);
    JS_SetInterruptHandler(rt, NULL, NULL);
    exception = JS_GetException(ctx);
    assert(JS_IsUncatchableError(exception));
    JS_FreeValue(ctx, exception);
    JS_FreeValue(ctx, result);
    function = evaluate(ctx, "(()=>/a/.test('a'))");
    assert(!JS_IsException(function));
    JS_SetMemoryLimit(rt, 1);
    result = JS_Call(ctx, function, JS_UNDEFINED, 0, NULL);
    JS_SetMemoryLimit(rt, 0);
    assert(JS_IsException(result));
    exception = JS_GetException(ctx);
    JS_FreeValue(ctx, exception);
    JS_FreeValue(ctx, result);
    JS_FreeValue(ctx, function);
    expect_true(ctx, "/a/.test('a') && !/a/.test('b')");
    JS_FreeContext(other);
    puts("native realm, frame, stack, interrupt, allocation failure and recovery: passed");
}

static int run_file(JSContext *ctx, const char *path)
{
    FILE *input = fopen(path, "rb");
    long length;
    char *source;
    JSValue result;
    int failed;
    if (!input) return 2;
    fseek(input, 0, SEEK_END);
    length = ftell(input);
    rewind(input);
    source = malloc(length + 1);
    if (!source) return 2;
    if (fread(source, 1, length, input) != (size_t)length) return 2;
    fclose(input);
    source[length] = 0;
    result = JS_Eval(ctx, source, length, path, JS_EVAL_TYPE_GLOBAL);
    free(source);
    failed = JS_IsException(result);
    if (failed) {
        JSValue exception = JS_GetException(ctx);
        const char *text = JS_ToCString(ctx, exception);
        fprintf(stderr, "%s\n", text);
        JS_FreeCString(ctx, text);
        JS_FreeValue(ctx, exception);
    }
    JS_FreeValue(ctx, result);
    return failed;
}

int main(int argc, char **argv)
{
    const JSMallocFunctions allocator = { allocate_zero, allocate, release, resize, usable_size };
    const struct rlimit no_core = { 0, 0 };
    JSRuntime *rt;
    JSContext *ctx;
    JSValue global;
    int failed = 0;
    if (argc != 2) return 2;
    setrlimit(RLIMIT_CORE, &no_core);
    rt = JS_NewRuntime2(&allocator, NULL);
    JS_SetMallocBound(rt, JS_DefaultMallocBound);
    JS_SetMaxStackSize(rt, 4 * 1024 * 1024);
    ctx = JS_NewContext(rt);
    global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "print", JS_NewCFunction(ctx, print, "print", 1));
    JS_FreeValue(ctx, global);
    if (strcmp(argv[1], "--native") == 0)
        native_checks(ctx);
    else
        failed = run_file(ctx, argv[1]);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    fprintf(stderr, "live allocations after teardown: %zu\n", counts.live);
    return failed || counts.live != 0;
}

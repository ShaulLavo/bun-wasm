// What the JSC C API does not expose: an ES module loader, microtask draining, promise state,
// Proxy detection. Compiled against JSC's private headers with the flags the jsc shell uses
// (build.rs). The module hooks follow jsc.cpp's GlobalObject, reduced to what bun-jsc needs:
// module sources come from a JS function (the prelude's fetchModule), keys are file:// URLs for
// files and node:<name> for builtins.
#include "config.h"

#include "APICast.h"
#include "JSContextRef.h"
#include "JSObjectRef.h"
#include "JSValueRef.h"
#include "Completion.h"
#include "Identifier.h"
#include "JSCInlines.h"
#include "GlobalObjectMethodTable.h"
#include "InitializeThreading.h"
#include "JSGlobalObject.h"
#include "ObjectConstructor.h"
#include "JSLock.h"
#include "JSModuleLoader.h"
#include "JSPromise.h"
#include "JSSourceCode.h"
#include "ProxyObject.h"
#include "TopExceptionScope.h"
#include "SourceProvider.h"
#include "VM.h"
#include <wtf/URL.h>

using namespace JSC;

// (key: string) => source string. Protected for the life of the process.
static JSObjectRef s_fetchHook;
// (meta: object, key: string) => void: adds import.meta.resolve and friends in JS.
static JSObjectRef s_metaHook;
// The entry module's key: import.meta.main is true only there.
static String s_mainKey;

static bool isBuiltinKey(const String& key)
{
    return key.startsWith("node:"_s);
}

static Identifier resolveModule(JSGlobalObject* globalObject, JSModuleLoader*, JSValue keyValue, JSValue referrerValue, RefPtr<ScriptFetcher>, bool)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    const Identifier key = keyValue.toPropertyKey(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    if (key.isSymbol())
        return key;
    String specifier = key.impl();
    if (specifier.startsWith("file://"_s) || isBuiltinKey(specifier))
        return key;
    if (specifier.startsWith('/'))
        return Identifier::fromString(vm, URL::fileURLWithFileSystemPath(specifier).string());
    if (specifier.startsWith("./"_s) || specifier.startsWith("../"_s)) {
        String referrer = referrerValue.isString() ? asString(referrerValue)->value(globalObject).data : String();
        RETURN_IF_EXCEPTION(scope, { });
        URL base = referrer.startsWith("file://"_s) ? URL({ }, referrer) : URL::fileURLWithFileSystemPath("/"_s);
        return Identifier::fromString(vm, URL(base, specifier).string());
    }
    // Bare specifiers left in a bundle are externals: Node/Bun builtins.
    return Identifier::fromString(vm, specifier.startsWith("bun:"_s) ? specifier : makeString("node:"_s, specifier));
}

static JSPromise* fetchModule(JSGlobalObject* globalObject, JSModuleLoader*, JSValue key, const String&, RefPtr<ScriptFetchParameters>, RefPtr<ScriptFetcher>)
{
    VM& vm = globalObject->vm();
    JSPromise* promise = JSPromise::create(vm, globalObject->promiseStructure());
    auto scope = DECLARE_THROW_SCOPE(vm);
    String moduleKey = key.toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, promise->rejectWithCaughtException(vm, scope));

    JSContextRef ctx = toRef(globalObject);
    JSValueRef arg = toRef(globalObject, key);
    JSValueRef exception = nullptr;
    JSValueRef result = JSObjectCallAsFunction(ctx, s_fetchHook, nullptr, 1, &arg, &exception);
    if (exception) {
        scope.release();
        promise->reject(vm, toJS(globalObject, exception));
        return promise;
    }
    String source = toJS(globalObject, result).toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, promise->rejectWithCaughtException(vm, scope));

    URL url({ }, moduleKey);
    // Errors print file paths, not file:// URLs.
    String displayName = url.protocolIsFile() ? url.fileSystemPath() : moduleKey;
    auto provider = StringSourceProvider::create(source, SourceOrigin { url }, WTF::move(displayName), SourceTaintedOrigin::Untainted, TextPosition(), SourceProviderSourceType::Module);
    auto* sourceCode = JSSourceCode::create(vm, SourceCode(WTF::move(provider)));
    scope.release();
    promise->resolve(globalObject, vm, sourceCode);
    return promise;
}

static JSPromise* importModule(JSGlobalObject* globalObject, JSModuleLoader* loader, JSString* moduleNameValue, RefPtr<ScriptFetchParameters> fetchParams, const SourceOrigin& sourceOrigin, bool deferred)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto specifier = moduleNameValue->value(globalObject);
    if (scope.exception()) [[unlikely]] {
        auto* promise = JSPromise::create(vm, globalObject->promiseStructure());
        return promise->rejectWithCaughtException(vm, scope);
    }
    // Scripts (no URL) import relative to the cwd root, like a file at "/".
    String referrer = sourceOrigin.url().isValid() ? sourceOrigin.url().string() : URL::fileURLWithFileSystemPath("/"_s).string();
    auto referrerKey = Identifier::fromString(vm, referrer);
#if USE(BUN_JSC_ADDITIONS)
    auto* result = loader->requestImportModule(globalObject, Identifier::fromString(vm, specifier), referrerKey, WTF::move(fetchParams), nullptr, deferred, loader->asyncEvaluationOrderForKey(referrerKey));
#else
    auto* result = loader->requestImportModule(globalObject, Identifier::fromString(vm, specifier), referrerKey, WTF::move(fetchParams), nullptr, deferred);
#endif
    if (scope.exception()) [[unlikely]] {
        auto* promise = JSPromise::create(vm, globalObject->promiseStructure());
        return promise->rejectWithCaughtException(vm, scope);
    }
    return result;
}

// import.meta: url, path/filename, dir/dirname, main, and Bun's require.
static JSObject* createImportMeta(JSGlobalObject* globalObject, JSModuleLoader*, JSValue key, JSModuleRecord*, RefPtr<ScriptFetcher>)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    JSObject* meta = constructEmptyObject(vm, globalObject->nullPrototypeObjectStructure());
    String keyString = key.toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, nullptr);
    meta->putDirect(vm, Identifier::fromString(vm, "url"_s), key);
    URL url({ }, keyString);
    if (url.protocolIsFile()) {
        String path = url.fileSystemPath();
        size_t slash = path.reverseFind('/');
        String dir = slash == notFound || !slash ? "/"_s : path.left(slash);
        meta->putDirect(vm, Identifier::fromString(vm, "path"_s), jsString(vm, path));
        meta->putDirect(vm, Identifier::fromString(vm, "filename"_s), jsString(vm, path));
        meta->putDirect(vm, Identifier::fromString(vm, "dir"_s), jsString(vm, dir));
        meta->putDirect(vm, Identifier::fromString(vm, "dirname"_s), jsString(vm, dir));
    }
    meta->putDirect(vm, Identifier::fromString(vm, "main"_s), jsBoolean(keyString == s_mainKey));
    JSValue require = globalObject->get(globalObject, Identifier::fromString(vm, "require"_s));
    RETURN_IF_EXCEPTION(scope, nullptr);
    meta->putDirect(vm, Identifier::fromString(vm, "require"_s), require);
    if (s_metaHook) {
        JSValueRef args[] = { toRef(globalObject, meta), toRef(globalObject, key) };
        JSValueRef exception = nullptr;
        JSObjectCallAsFunction(toRef(globalObject), s_metaHook, nullptr, 2, args, &exception);
        if (exception) {
            throwException(globalObject, scope, toJS(globalObject, exception));
            return nullptr;
        }
    }
    return meta;
}

extern "C" {

// A global context whose global object has the module loader hooks above.
JSGlobalContextRef bunjsc_create_context()
{
    JSC::initialize();
    Ref<VM> vm = VM::createContextGroup();
    JSLockHolder locker(vm.ptr());
    // The default method table (private to JSGlobalObject), read off a plain global object,
    // with the module loader hooks filled in.
    static GlobalObjectMethodTable table = [&] {
        JSGlobalObject* plain = JSGlobalObject::create(vm.get(), JSGlobalObject::createStructure(vm.get(), jsNull()));
        GlobalObjectMethodTable t = *plain->globalObjectMethodTable();
        t.moduleLoaderImportModule = importModule;
        t.moduleLoaderResolve = resolveModule;
        t.moduleLoaderFetch = fetchModule;
        t.moduleLoaderCreateImportMetaProperties = createImportMeta;
        return t;
    }();
    JSGlobalObject* globalObject = JSGlobalObject::createWithCustomMethodTable(vm.get(), JSGlobalObject::createStructure(vm.get(), jsNull()), &table);
    return JSGlobalContextRetain(toGlobalRef(globalObject));
}

void bunjsc_set_module_hooks(JSContextRef ctx, JSObjectRef fetch, JSObjectRef importMeta)
{
    JSValueProtect(ctx, fetch);
    JSValueProtect(ctx, importMeta);
    s_fetchHook = fetch;
    s_metaHook = importMeta;
}

// Fetches and parses the module graph of `key` (a file:// URL). The returned promise settles
// as microtasks run; then bunjsc_evaluate_module runs the module body.
JSValueRef bunjsc_load_module(JSContextRef ctx, const char* key)
{
    JSGlobalObject* globalObject = toJS(ctx);
    VM& vm = globalObject->vm();
    JSLockHolder lock(vm);
    s_mainKey = String::fromUTF8(key);
    JSPromise* promise = loadModule(globalObject, Identifier::fromString(vm, s_mainKey), nullptr, nullptr);
    return toRef(globalObject, promise);
}

// Links and evaluates a loaded module. The body runs synchronously, as a task of its own (so
// the nextTick queue runs after it, before promise jobs); the promise covers top-level await.
JSValueRef bunjsc_evaluate_module(JSContextRef ctx, const char* key)
{
    JSGlobalObject* globalObject = toJS(ctx);
    VM& vm = globalObject->vm();
    JSLockHolder lock(vm);
    auto scope = DECLARE_TOP_EXCEPTION_SCOPE(vm);
    JSPromise* promise = linkAndEvaluateModule(globalObject, Identifier::fromString(vm, String::fromUTF8(key)), nullptr);
    if (Exception* exception = scope.exception()) {
        // A synchronous throw from the body (or linking): report it like a rejection.
        JSValue error = exception->value();
        scope.clearException();
        promise = JSPromise::create(vm, globalObject->promiseStructure());
        promise->reject(vm, error);
    }
    return toRef(globalObject, promise);
}

// Takes the VM's API lock for the rest of the process. Every C API call takes it too, and JSC
// drains the microtask queue whenever the outermost holder releases it, i.e. after every
// top-level API call. Holding it here makes those calls nested, so microtasks run only when
// bunjsc_drain_microtasks says so (after the nextTick queue, as in Bun).
void bunjsc_enter(JSContextRef ctx)
{
    toJS(ctx)->vm().apiLock().lock();
}

// Runs queued promise jobs until the queue is empty.
void bunjsc_drain_microtasks(JSContextRef ctx)
{
    JSGlobalObject* global = toJS(ctx);
    VM& vm = global->vm();
    JSLockHolder lock(vm);
    vm.drainMicrotasks();
}

// -1: not a promise, 0: pending, 1: fulfilled, 2: rejected.
int bunjsc_promise_state(JSContextRef ctx, JSValueRef value)
{
    JSGlobalObject* global = toJS(ctx);
    JSLockHolder lock(global->vm());
    auto* promise = dynamicDowncast<JSPromise>(toJS(global, value));
    if (!promise)
        return -1;
    switch (promise->status()) {
    case JSPromise::Status::Pending:
        return 0;
    case JSPromise::Status::Fulfilled:
        return 1;
    case JSPromise::Status::Rejected:
        return 2;
    }
    return 0;
}

JSValueRef bunjsc_promise_result(JSContextRef ctx, JSValueRef value)
{
    JSGlobalObject* global = toJS(ctx);
    JSLockHolder lock(global->vm());
    auto* promise = dynamicDowncast<JSPromise>(toJS(global, value));
    if (!promise || promise->status() == JSPromise::Status::Pending)
        return toRef(global, jsUndefined());
    return toRef(global, promise->result());
}

// The Proxy's target, or null if the value is not a Proxy.
JSValueRef bunjsc_proxy_target(JSContextRef ctx, JSValueRef value)
{
    JSGlobalObject* global = toJS(ctx);
    JSLockHolder lock(global->vm());
    auto* proxy = dynamicDowncast<ProxyObject>(toJS(global, value));
    if (!proxy)
        return nullptr;
    return toRef(global, proxy->target());
}

}

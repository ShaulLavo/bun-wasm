// What the JSC C API does not expose, for bunwasm-runtime's JSC engine
// (crates/bunwasm-runtime/src/engine_jsc.rs): an ES module loader whose
// resolve/fetch/import.meta steps call back into the runtime per file,
// script evaluation with a file name and a first line, microtask draining,
// promise state, Proxy and Error detection. Compiled against JSC's private
// headers with the flags the jsc shell uses (build.rs).
//
// Module keys are what the runtime's resolver returns: absolute file paths,
// or built-in names like `node:fs` and `bun`.
#include "config.h"

#include "APICast.h"
#include "JSContextRef.h"
#include "JSObjectRef.h"
#include "JSValueRef.h"
#include "Completion.h"
#include "ErrorInstance.h"
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
#include "MicrotaskQueue.h"
#include "ProxyObject.h"
#include "TopExceptionScope.h"
#include "SourceProvider.h"
#include "VM.h"
#include <wtf/URL.h>
#include <string>

using namespace JSC;

extern "C" {
// Implemented in Rust (engine_jsc.rs). Each returns a malloc'd UTF-8 string
// (resolve: the module key; fetch: the module source) or null with
// *exception set.
char* bunjsc_host_resolve(const char* specifier, const char* referrer, JSValueRef* exception);
char* bunjsc_host_fetch(const char* key, JSValueRef* exception);
void bunjsc_host_init_meta(JSValueRef meta, const char* key, JSValueRef* exception);
void bunjsc_host_free(char*);
}

static std::string utf8(const String& s)
{
    auto bytes = s.utf8();
    return std::string(reinterpret_cast<const char*>(bytes.data()), bytes.length());
}

// The URL a module or script's SourceOrigin gets: file URLs for paths (so
// referrers round-trip), otherwise the name as a URL (`node:fs`), if valid.
static URL originURL(const String& name)
{
    if (name.startsWith('/'))
        return URL::fileURLWithFileSystemPath(name);
    return URL({ }, name);
}

// The module key / file name of a source origin (the inverse of originURL).
static String originName(const SourceOrigin& origin)
{
    const URL& url = origin.url();
    if (!url.isValid())
        return String();
    if (url.protocolIsFile())
        return url.fileSystemPath();
    return url.string();
}

static Identifier resolveModule(JSGlobalObject* globalObject, JSModuleLoader*, JSValue keyValue, JSValue referrerValue, RefPtr<ScriptFetcher>, bool)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    const Identifier key = keyValue.toPropertyKey(globalObject);
    RETURN_IF_EXCEPTION(scope, { });
    if (key.isSymbol())
        return key;
    String referrer;
    if (referrerValue.isString()) {
        referrer = asString(referrerValue)->value(globalObject).data;
        RETURN_IF_EXCEPTION(scope, { });
    }
    JSValueRef exception = nullptr;
    char* resolved = bunjsc_host_resolve(utf8(key.impl()).c_str(), utf8(referrer).c_str(), &exception);
    if (!resolved) {
        throwException(globalObject, scope, toJS(globalObject, exception));
        return { };
    }
    Identifier result = Identifier::fromString(vm, String::fromUTF8(resolved));
    bunjsc_host_free(resolved);
    return result;
}

static JSPromise* fetchModule(JSGlobalObject* globalObject, JSModuleLoader*, JSValue key, const String&, RefPtr<ScriptFetchParameters>, RefPtr<ScriptFetcher>)
{
    VM& vm = globalObject->vm();
    JSPromise* promise = JSPromise::create(vm, globalObject->promiseStructure());
    auto scope = DECLARE_THROW_SCOPE(vm);
    String moduleKey = key.toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, promise->rejectWithCaughtException(vm, scope));

    JSValueRef exception = nullptr;
    char* text = bunjsc_host_fetch(utf8(moduleKey).c_str(), &exception);
    if (!text) {
        scope.release();
        promise->reject(vm, toJS(globalObject, exception));
        return promise;
    }
    String source = String::fromUTF8(text);
    bunjsc_host_free(text);
    auto provider = StringSourceProvider::create(source, SourceOrigin { originURL(moduleKey) }, String(moduleKey), SourceTaintedOrigin::Untainted, TextPosition(), SourceProviderSourceType::Module);
    auto* sourceCode = JSSourceCode::create(vm, SourceCode(WTF::move(provider)));
    scope.release();
    promise->resolve(globalObject, vm, sourceCode);
    return promise;
}

static JSPromise* requestImport(JSGlobalObject* globalObject, JSModuleLoader* loader, const String& specifier, const String& referrer, RefPtr<ScriptFetchParameters> fetchParams, bool deferred)
{
    VM& vm = globalObject->vm();
    auto referrerKey = Identifier::fromString(vm, referrer);
#if USE(BUN_JSC_ADDITIONS)
    return loader->requestImportModule(globalObject, Identifier::fromString(vm, specifier), referrerKey, WTF::move(fetchParams), nullptr, deferred, loader->asyncEvaluationOrderForKey(referrerKey));
#else
    return loader->requestImportModule(globalObject, Identifier::fromString(vm, specifier), referrerKey, WTF::move(fetchParams), nullptr, deferred);
#endif
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
    auto* result = requestImport(globalObject, loader, specifier, originName(sourceOrigin), WTF::move(fetchParams), deferred);
    if (scope.exception()) [[unlikely]] {
        auto* promise = JSPromise::create(vm, globalObject->promiseStructure());
        return promise->rejectWithCaughtException(vm, scope);
    }
    return result;
}

// import.meta: an empty object the runtime fills in (url, dir, path, main,
// require, resolve; wrapper modules get their exports handoff).
static JSObject* createImportMeta(JSGlobalObject* globalObject, JSModuleLoader*, JSValue key, JSModuleRecord*, RefPtr<ScriptFetcher>)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    JSObject* meta = constructEmptyObject(globalObject);
    String keyString = key.toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, nullptr);
    JSValueRef exception = nullptr;
    bunjsc_host_init_meta(toRef(globalObject, meta), utf8(keyString).c_str(), &exception);
    if (exception) {
        throwException(globalObject, scope, toJS(globalObject, exception));
        return nullptr;
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

// `import(specifier)` from the top level (referrer: none); a promise of the
// module namespace.
JSValueRef bunjsc_import(JSContextRef ctx, const char* specifier, JSValueRef* exception)
{
    JSGlobalObject* globalObject = toJS(ctx);
    VM& vm = globalObject->vm();
    JSLockHolder lock(vm);
    auto scope = DECLARE_TOP_EXCEPTION_SCOPE(vm);
    JSPromise* promise = requestImport(globalObject, globalObject->moduleLoader(), String::fromUTF8(specifier), String(), nullptr, false);
    if (Exception* e = scope.exception()) {
        *exception = toRef(globalObject, e->value());
        scope.clearException();
        return nullptr;
    }
    return toRef(globalObject, promise);
}

// Evaluate a classic script named `filename` whose first line is
// `firstLine` (may be <= 0 for wrappers placed above the file's line 1).
JSValueRef bunjsc_evaluate_script(JSContextRef ctx, const char* source, const char* filename, int firstLine, JSValueRef* exception)
{
    JSGlobalObject* globalObject = toJS(ctx);
    VM& vm = globalObject->vm();
    JSLockHolder lock(vm);
    String name = String::fromUTF8(filename);
    TextPosition start(OrdinalNumber::fromZeroBasedInt(firstLine - 1), OrdinalNumber());
    SourceCode code = makeSource(String::fromUTF8(source), SourceOrigin { originURL(name) }, SourceTaintedOrigin::Untainted, name, start);
    NakedPtr<Exception> returned;
    JSValue result = JSC::evaluate(globalObject, code, JSValue(), returned);
    if (returned) {
        *exception = toRef(globalObject, returned->value());
        return nullptr;
    }
    return toRef(globalObject, result);
}

// Takes the VM's API lock for the rest of the process. Every C API call takes it too, and JSC
// drains the microtask queue whenever the outermost holder releases it, i.e. after every
// top-level API call. Holding it here makes those calls nested, so microtasks run only when
// bunjsc_drain_microtasks says so (after the nextTick queue, as in Bun).
void bunjsc_enter(JSContextRef ctx)
{
    toJS(ctx)->vm().apiLock().lock();
}

// Runs queued promise jobs until the queue is empty; returns whether any were queued.
bool bunjsc_drain_microtasks(JSContextRef ctx)
{
    JSGlobalObject* global = toJS(ctx);
    VM& vm = global->vm();
    JSLockHolder lock(vm);
    bool pending = !vm.defaultMicrotaskQueue().isEmpty();
    vm.drainMicrotasks();
    return pending;
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

bool bunjsc_is_error(JSContextRef ctx, JSValueRef value)
{
    JSGlobalObject* global = toJS(ctx);
    JSLockHolder lock(global->vm());
    return dynamicDowncast<ErrorInstance>(toJS(global, value));
}

}

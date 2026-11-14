extern "C" size_t bunsm_test_interpreter_frames(JSContext* cx);
bool collectBeforeGetter = false;
bool failGetterPrologue = false;
bool failNextPrologue = false;
size_t deferredGetters = 0;
size_t getterCollections = 0;

extern "C" void bunsm_test_deferred_getter(JSContext* cx) {
  deferredGetters++;
  if (failGetterPrologue) {
    failGetterPrologue = false;
    failNextPrologue = true;
  }
  if (!collectBeforeGetter) return;
  collectBeforeGetter = false;
  JS::PrepareForFullGC(cx);
  JS::NonIncrementalGC(cx, JS::GCOptions::Shrink, JS::GCReason::API);
  getterCollections++;
}

extern "C" bool bunsm_test_inline_prologue(JSContext* cx) {
  if (!failNextPrologue) return true;
  failNextPrologue = false;
  JS_ReportOutOfMemory(cx);
  return false;
}

struct LoopStack {
  uint32_t depth;
  size_t frames;
};
LoopStack loop_stack() {
  return {JS::RootingContext::get(context)->wasiRecursionDepth,
          bunsm_test_interpreter_frames(context)};
}
void balanced(LoopStack entry, const char* label) {
  auto after = loop_stack();
  check(after.depth == entry.depth && after.frames == entry.frames, label);
}

bool stack_stats(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  auto stack = loop_stack();
  args.rval().setNumber(stack.depth);
  return true;
}

void loop_success(const char* source) {
  auto entry = loop_stack();
  { Value result(script(source, "getter-control.js")); }
  balanced(entry, "stack balanced after successful evaluation");
}

void loop_failure(const char* source) {
  auto entry = loop_stack();
  bsm_handle out = 0;
  check(!bsm_eval_script(source, strlen(source), "getter-control.js", 1, &out), "expected failure");
  bsm_release(out);
  balanced(entry, "stack balanced after failed evaluation");
}

void moving_getter_gc() {
  for (const char* source : {
      "if (({ marker: 42, get value() { return this.marker; } }).value !== 42) throw 1;",
      "Object.defineProperty(Number.prototype, 'value', {configurable:true, get:function(){'use strict'; return this;}}); if ((7).value !== 7) throw 2; delete Number.prototype.value;",
      "var base = {get value(){return this.marker;}}; var derived = {__proto__:base, get result(){return super.value;}}; if (Object.assign(Object.create(derived), {marker:42}).result !== 42) throw 3;"}) {
    collectBeforeGetter = true;
    auto before = getterCollections;
    loop_success(source);
    check(!collectBeforeGetter && getterCollections == before + 1, "shrinking GC between deferral and entry");
  }
  puts("ok moving GC before getter frame publication");
}

void debugger_evaluate(const char* source) {
  auto entry = loop_stack();
  {
    JS::RealmOptions options;
    options.creationOptions().setNewCompartmentAndZone();
    JS::RootedObject debuggerGlobal(context, JS_NewGlobalObject(context, &globalClass, nullptr, JS::FireOnNewGlobalHook, options));
    check(debuggerGlobal != nullptr, "debugger global");
    JSAutoRealm realm(context, debuggerGlobal);
    check(JS::InitRealmStandardClasses(context), "debugger standard classes");
    check(JS_DefineDebuggerObject(context, debuggerGlobal), "Debugger class");
    JS::RootedObject debuggee(context, global->get());
    check(JS_WrapObject(context, &debuggee), "wrapped debuggee");
    check(JS_DefineProperty(context, debuggerGlobal, "debuggee", debuggee, 0), "debuggee reference");
    JS::CompileOptions compile(context);
    compile.setFileAndLine("debugger-control.js", 1);
    JS::SourceText<mozilla::Utf8Unit> text;
    check(text.init(context, source, strlen(source), JS::SourceOwnership::Borrowed), "debugger source");
    JS::RootedValue out(context);
    bool ok = JS::Evaluate(context, compile, text, &out);
    if (!ok && JS_IsExceptionPending(context)) {
      JS::RootedValue error(context);
      JS_GetPendingException(context, &error);
      JS_ClearPendingException(context);
      JS::RootedString message(context, JS::ToString(context, error));
      JS::UniqueChars bytes = message ? JS_EncodeStringToUTF8(context, message) : nullptr;
      fprintf(stderr, "Debugger failure: %s\n", bytes ? bytes.get() : "unknown");
    }
    check(ok, "Debugger evaluation");
  }
  bsm_gc();
  balanced(entry, "stack balanced after Debugger evaluation");
}

void debugger_getters() {
  debugger_evaluate(R"JS(
    function assert(v, label) { if (!v) throw new Error(label); }
    var dbg = new Debugger(debuggee);
    var g = dbg.makeGlobalObjectReference(debuggee);
    var entered = 0, left = 0, exceptions = 0;
    dbg.onEnterFrame = frame => {
      if (frame.callee?.name !== 'getter') return;
      entered++;
      frame.onPop = completion => { left++; };
    };
    dbg.onExceptionUnwind = (frame, value) => {
      if (frame.callee?.name === 'getter') exceptions++;
    };
    var result = g.executeInGlobal("var obj = {get value(){return 42;}}; Object.defineProperty(obj,'value',{get:function getter(){return 42;}}); obj.value;", {url:'getter-site.js'});
    assert(result.return === 42 && entered === 1 && left === 1, 'one enter and leave');
    dbg.onEnterFrame = frame => {
      if (frame.callee?.name !== 'getter') return;
      frame.onPop = completion => { left++; };
      return {return: 73};
    };
    result = g.executeInGlobal('obj.value;', {url:'getter-forced.js'});
    assert(result.return === 73 && left === 2, 'forced getter return');
    dbg.onEnterFrame = undefined;
    result = g.executeInGlobal("var token={}; Object.defineProperty(obj,'value',{get:function getter(){throw token;}}); try {obj.value;} catch(e) {e===token;}", {url:'getter-throw.js'});
    assert(result.return === true && exceptions === 1, 'exception hook and identity');
    dbg.onExceptionUnwind = undefined;
    var locations = [], stacks = [];
    dbg.onEnterFrame = frame => {
      if (frame.callee?.name !== 'getter') return;
      var caller = frame.older;
      var location = caller.script.getOffsetLocation(caller.offset);
      locations.push(JSON.stringify([location.lineNumber, location.columnNumber]));
    };
    var source = 'function getter(){return new Error().stack;}\nObject.defineProperty(obj,"value",{get:getter});\nfunction caller(){return obj.value;}\ncaller();';
    stacks.push(g.executeInGlobal(source, {url:'getter-location.js'}).return);
    dbg.onNativeCall = () => {};
    stacks.push(g.executeInGlobal(source, {url:'getter-location.js'}).return);
    assert(locations.length === 2 && locations[0] === locations[1], 'caller line and column');
    assert(stacks[0] === stacks[1], 'saved getter stack');
    dbg.onNativeCall = undefined;
    dbg.onEnterFrame = undefined;
    debuggee.crossGetter = function crossGetter() { return this.marker; };
    result = g.executeInGlobal("var foreign={marker:42}; Object.defineProperty(foreign,'value',{get:crossGetter}); foreign.value;", {url:'getter-realm.js'});
    assert(result.return === 42, 'cross-realm getter receiver');
    dbg.removeAllDebuggees();
  )JS");
  puts("ok Debugger hooks, forced return, exception, caller PC, saved stack and realm");
}

void native_observer_exclusion() {
  size_t before = deferredGetters;
  debugger_evaluate(R"JS(
    var dbg = new Debugger(debuggee);
    var g = dbg.makeGlobalObjectReference(debuggee);
    dbg.onNativeCall = () => {};
    var result = g.executeInGlobal('({get value(){return 42;}}).value;');
    if (result.return !== 42) throw new Error('observed getter');
    dbg.removeAllDebuggees();
  )JS");
  check(deferredGetters == before, "native observer excludes deferred getters");
  loop_success("({get value(){return 42;}}).value;");
  check(deferredGetters > before, "getter defers after native observer removed");
  puts("ok native-call observer keeps generic lookup");
}

void async_getter_stacks() {
  auto entry = loop_stack();
  {
    Value parent(script("function asyncParent(){return new Error().stack;} asyncParent();", "async-parent.js"));
    Value saved(script("new Error()", "async-parent.js"));
    JS::RootedObject error(context, object(saved.handle));
    JS::RootedObject stack(context, JS::ExceptionStackOrNull(error));
    check(stack != nullptr, "async parent saved frame");
    JS::AutoSetAsyncStackForNewCalls async(context, stack, "getter-parent", JS::AutoSetAsyncStackForNewCalls::AsyncCallKind::EXPLICIT);
    debugger_evaluate(R"JS(
      var dbg = new Debugger(debuggee), g = dbg.makeGlobalObjectReference(debuggee);
      var source = 'var asyncObject={get value(){return new Error().stack;}}; asyncObject.value;';
      var loop = g.executeInGlobal(source, {url:'async-getter.js'}).return;
      dbg.onNativeCall = () => {};
      var generic = g.executeInGlobal(source, {url:'async-getter.js'}).return;
      if (loop !== generic || !loop.includes('getter-parent')) throw new Error('async parent stack');
      dbg.removeAllDebuggees();
    )JS");
  }
  balanced(entry, "stack balanced after async parent");
  puts("ok async getter parent stack");
}

void loop_controls() {
  bool pbl = getenv("BUN_WASM_SPIDERMONKEY_TIER") && !strcmp(getenv("BUN_WASM_SPIDERMONKEY_TIER"), "pbl");
  {
    JSAutoRealm realm(context, global->get());
    check(JS_DefineFunction(context, global->get(), "stackUnits", stack_stats, 0, 0), "stack unit accessor");
  }
  loop_success("var units=stackUnits(); var left=48; var o={get value(){if(left--)return this.value; return stackUnits();}}; if(!(" 
               "o.value >= units))throw 1;");
  loop_success("var token={}; var left=48; var o={get value(){try{if(left--)return this.value;throw token;}finally{}}};try{o.value;}catch(e){if(e!==token)throw 1;}");
  loop_failure("var o={get value(){throw 0;}};o.value;");
  loop_failure("var token={};var o={get value(){throw token;}};o.value;");
  loop_success("var o={get value(){return this.value;}};try{o.value;throw 1;}catch(e){if(!(e instanceof RangeError))throw e;}");
  if (!pbl) {
    loop_success("var units=stackUnits();var left=128;var o={get value(){return left--?this.value:stackUnits();}};if(o.value!==units)throw 1;");
    moving_getter_gc();
    failGetterPrologue = true;
    loop_failure("({get value(){return 42;}}).value;");
    check(!failGetterPrologue && !failNextPrologue, "prologue failure reached");
    native_observer_exclusion();
  }
  debugger_getters();
  async_getter_stacks();
  puts("ok frame and recursion-unit balance on success, throw, exhaustion and prologue failure");
  interruptAt = 1;
  loop_failure("var o={get value(){return this.value;}};o.value;");
  check(bsm_terminated(), "getter interruption terminates");
  puts("ok frame and recursion-unit balance on interruption");
}

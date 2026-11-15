void filename_error(const std::string& name, int32_t line) {
  JSAutoRealm realm(context, global->get());
  JS::RootedObject target(context, global->get());
  JS::RootedValue error(context);
  check(JS_GetProperty(context, target, "filenameError", &error), "read filename error");
  JS::RootedObject errorObject(context, &error.toObject());
  JS::RootedObject frame(context, JS::ExceptionStackOrNull(errorObject));
  check(frame != nullptr, "virtual script has saved frame");
  JS::RootedObject item(context, saved_frame_object(context, frame, JS::SavedFrameSelfHosted::Exclude));
  check(item != nullptr, "virtual saved frame decoded");
  JS::RootedValue file(context);
  check(JS_GetProperty(context, item, "file", &file), "read saved frame filename");
  std::string actual;
  check(to_utf8(file, &actual) && actual == name, "saved frame preserves exact source-map key");
  const bunsm::DiagnosticFilename diagnostic(name);
  Value label(bsm_string(diagnostic.c_str(), strlen(diagnostic.c_str())));
  install("filenameLabel", label.handle);
  JS::RootedValue lineNumber(context);
  check(JS_GetProperty(context, item, "line", &lineNumber), "read saved frame line");
  check(lineNumber.toNumber() == line, "saved frame keeps original line");
  Value stack(script("if (!filenameError.stack.includes(filenameLabel + ':')) throw new Error(filenameError.stack);"));
}

void filename_script(const std::string& name, int32_t line) {
  const char* body = "globalThis.filenameError = new Error('filename'); import('filename-child');";
  std::string source = line < 0
      ? std::string("(function __bunwasm_cjs__(exports, require, module, __filename, __dirname) {\n\n") + body + "\n})"
      : body;
  bsm_handle out = 0;
  check(bsm_eval_script(source.data(), source.size(), name.data(), name.size(), line, &out), "virtual script compiles");
  Value result(out);
  if (line < 0) {
    Value receiver(bsm_undefined());
    bsm_handle called = 0;
    check(bsm_call(result.handle, receiver.handle, nullptr, 0, &called), "virtual CommonJS executes");
    bsm_release(called);
  }
  jobs();
  check(lastReferrer == name, "script private preserves exact dynamic-import referrer");
  filename_error(name, line < 0 ? 1 : line);
}

void filename_module(const std::string& name) {
  constexpr const char source[] = "import 'filename-child'; export const identity = {}; export const again = () => import('filename-child'); export const error = new Error('module filename');";
  bsm_handle out = 0;
  check(bsm_eval_module(source, sizeof(source) - 1, name.data(), name.size(), &out), "virtual module compiles");
  Value evaluation(out);
  jobs();
  check(lastReferrer == name, "module private preserves static-import referrer");
  bsm_handle imported = 0;
  check(bsm_import(name.data(), name.size(), &imported), "virtual module imports by full ID");
  Value promise(imported);
  jobs();
  check(bsm_promise_state(promise.handle) == 1, "virtual module import fulfills");
  Value ns(bsm_promise_result(promise.handle));
  bsm_handle required = 0;
  check(bsm_require(name.data(), name.size(), &required), "virtual module requires by full ID");
  Value requirePromise(required);
  jobs();
  Value requiredNamespace(bsm_promise_result(requirePromise.handle));
  check(bsm_same_value(ns.handle, requiredNamespace.handle), "require and import preserve module identity");
  install("filenameNamespace", ns.handle);
  Value capture(script("globalThis.filenameError = filenameNamespace.error;"));
  filename_error(name, 1);
  Value dynamic(script("globalThis.filenameAgain = filenameNamespace.again();"));
  jobs();
  check(lastReferrer == name, "module dynamic import retains original referrer");
}

void filename_controls() {
  sources["filename-child"] = "export const child = 42;";
  const std::vector<std::string> names = {
      "ordinary-filename.ts", "C:\\project\\file.ts", "日本語/🦀.ts", "%00",
      std::string("\0plugin-vue:export-helper", 25),
      std::string("/home/user/\0plugin-vue:export-helper", 36), std::string("\0a\0b\0", 5), std::string("日本語\0🦀%00\\.ts", 21)};
  JSObject* previous = nullptr;
  for (const auto& name : names) {
    filename_script(name, 17);
    filename_script(name, -1);
    filename_module(name);
    const auto found = modules.find(name);
    check(found != modules.end(), "full module cache key exists");
    check(found->second->record != previous, "different virtual IDs do not alias");
    previous = found->second->record;
  }
  puts("SpiderMonkey virtual filename controls passed");
}

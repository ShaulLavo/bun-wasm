void completion_cases() {
  const struct { const char* source; const char* expected; } cases[] = {
      {"11; if (0) { 12; }", "void 0"},
      {"var c = false; 11; if (c) { 12; }", "void 0"},
      {"13; if (1) { }", "void 0"},
      {"var c = true; 13; if (c) { }", "void 0"},
      {"13; if (0) { 14; } else { }", "void 0"},
      {"var c = false; 13; if (c) { 14; } else { }", "void 0"},
      {"while (true) { 16; if (1) break; }", "void 0"},
      {"var c = true; while (c) { 16; if (c) break; }", "void 0"},
      {"while (true) { 17; if (1) break; else 18; }", "void 0"},
      {"var c = true; while (c) { 17; if (c) break; else 18; }", "void 0"},
      {"for (var i = 0; i < 2; i++) { 19; if (1) continue; }", "void 0"},
      {"var c = true; for (var i = 0; i < 2; i++) { 19; if (c) continue; }", "void 0"},
      {"X: { 9; if (1) { break X; } 10; }", "void 0"},
      {"var c = true; X: { 9; if (c) { break X; } 10; }", "void 0"},
      {"21; if (0) { 22; } else if (1) { }", "void 0"},
      {"var c = false; 21; if (c) { 22; } else if (!c) { }", "void 0"},
      {"21; if (1) { 22; if (0) { 23; } }", "void 0"},
      {"13; if (1) { } else { var hoisted; }", "void 0"},
      {"let undefined = 99; 11; if (0) { 12; }", "void 0"},
      {"13; { }", "13"},
      {"while (true) { 16; break; }", "16"},
      {"for (var i = 0; i < 2; i++) { 19; continue; }", "19"},
      {"13; if (1) { 14; }", "14"},
      {"var c = true; 13; if (c) { 14; }", "14"},
      {"13; if (0) { 14; } else { 15; }", "15"},
      {"X: { 9; if (1) { 10; break X; } }", "10"},
      {"21; if (0) { 22; } else if (0) { 23; } else { 24; }", "24"},
  };
  for (const auto& test : cases) {
    Value expected(script(test.expected));
    Value classic(script(test.source));
    check(bsm_same_value(classic.handle, expected.handle), test.source);
    const std::string direct = std::string("(function () { return eval(\"") + test.source + "\"); })()";
    Value nested(script(direct.c_str()));
    check(bsm_same_value(nested.handle, expected.handle), direct.c_str());
    const std::string indirect = std::string("(0, eval)(\"") + test.source + "\")";
    Value global(script(indirect.c_str()));
    check(bsm_same_value(global.handle, expected.handle), indirect.c_str());
  }
}

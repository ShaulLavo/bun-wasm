#include "../cpp/filename.h"

#include <cassert>
#include <cstring>
#include <iostream>
#include <vector>

int main() {
  const std::vector<std::string> names = {
      "", "ordinary.ts", "C:\\project\\file.ts", "日本語/🦀.ts", "%00", "%25",
      std::string("\0plugin-vue:export-helper", 25),
      std::string("/home/user/\0plugin-vue:export-helper", 36),
      std::string("\0a\0b\0", 5), std::string("日本語\0🦀%00\\.ts", 21)};
  std::vector<std::string> labels;
  for (const auto& name : names) {
    const bunsm::DiagnosticFilename label(name);
    assert(strlen(label.c_str()) >= name.size());
    assert(bunsm::original_filename(label.c_str()) == name);
    if (name.find_first_of(std::string_view("\0%", 2)) == std::string::npos) {
      assert(label.c_str() == name.c_str());
    }
    for (const auto& previous : labels) assert(previous != label.c_str());
    labels.emplace_back(label.c_str());
  }
  const std::string nuxt("/home/user/\0plugin-vue:export-helper", 36);
  assert(std::string(bunsm::DiagnosticFilename(nuxt).c_str()) == "/home/user/%00plugin-vue:export-helper");
  assert(bunsm::original_filename("unchanged%xy%0%") == "unchanged%xy%0%");
  std::cout << "SpiderMonkey filename boundary controls passed\n";
}

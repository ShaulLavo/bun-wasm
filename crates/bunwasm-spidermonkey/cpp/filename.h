#pragma once

#include <string>
#include <string_view>

namespace bunsm {

// JSAPI diagnostic labels are C strings; loader identities are length-delimited UTF-8.
class DiagnosticFilename {
 public:
  explicit DiagnosticFilename(const std::string& name) : original(name) {
    if (name.find_first_of(std::string_view("\0%", 2)) == std::string::npos) return;
    for (char byte : name) {
      if (byte == '\0') encoded += "%00";
      else if (byte == '%') encoded += "%25";
      else encoded += byte;
    }
  }

  const char* c_str() const { return encoded.empty() ? original.c_str() : encoded.c_str(); }

 private:
  const std::string& original;
  std::string encoded;
};

inline std::string original_filename(std::string_view label) {
  std::string name;
  name.reserve(label.size());
  for (size_t i = 0; i < label.size(); ++i) {
    const auto escape = label.substr(i, 3);
    if (escape == "%00" || escape == "%25") {
      name += escape == "%00" ? '\0' : '%';
      i += 2;
      continue;
    }
    name += label[i];
  }
  return name;
}

}  // namespace bunsm

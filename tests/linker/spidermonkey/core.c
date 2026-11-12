// VM-only bootstrap for Bun's real linked-program loader, not a Bun runtime.
#include <stdint.h>
#include <stdlib.h>
typedef int32_t (*run_fn)(uint32_t);
static run_fn run;
void bun_core_bind_engine(run_fn callback) { run = callback; }
void* bun_core_alloc(uint32_t bytes, uint32_t alignment) {
  void* result = 0;
  if (posix_memalign(&result, alignment < 16 ? 16 : alignment, bytes)) return 0;
  return result;
}
int main(void) { return run ? run(0) : 1; }

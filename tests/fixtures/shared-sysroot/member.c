#include <errno.h>
#include <malloc.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

__attribute__((import_module("j2_probe"), import_name("block")))
extern void check_block(uintptr_t addr, size_t size);

static int private_counter = 7;
static char *volatile greeting = "hello";
static int (*op)(int);
static int twice(int x) { return 2 * x; }
static int thrice(int x) { return 3 * x; }

__attribute__((export_name("member_init"))) int member_init(int id) {
  private_counter += id;
  op = id == 1 ? twice : thrice;
  return private_counter;
}
__attribute__((export_name("member_counter"))) int member_counter(void) { return private_counter; }
__attribute__((export_name("member_counter_addr"))) uintptr_t member_counter_addr(void) { return (uintptr_t)&private_counter; }
__attribute__((export_name("member_greeting_ok"))) int member_greeting_ok(void) { return strcmp(greeting, "hello") == 0; }
__attribute__((export_name("member_call_op"))) int member_call_op(int x) { return op(x); }
__attribute__((export_name("member_errno_addr"))) uintptr_t member_errno_addr(void) { return (uintptr_t)&errno; }
__attribute__((export_name("member_break"))) uintptr_t member_break(void) { return (uintptr_t)sbrk(0); }
__attribute__((export_name("member_grow"))) uintptr_t member_grow(void) { return (uintptr_t)sbrk(65536); }
__attribute__((export_name("member_growth_failure"))) int member_growth_failure(void) {
  uintptr_t before = (uintptr_t)sbrk(0);
  errno = 0;
  return sbrk(65536) == (void *)-1 && errno == ENOMEM && (uintptr_t)sbrk(0) == before;
}

static int verify_block(unsigned char *block, size_t size, int id) {
  for (size_t j = 0; j < size; j++) {
    if (block[j] != (unsigned char)id) return -2;
  }
  return 0;
}

__attribute__((export_name("member_churn"))) int member_churn(int id, int rounds) {
  enum { N = 512 };
  static unsigned char *blocks[N];
  static size_t sizes[N];
  for (int r = 0; r < rounds; r++) {
    for (int i = 0; i < N; i++) {
      size_t n = 16 + ((i * 7919u + r * 104729u) % 70000u);
      blocks[i] = malloc(n);
      if (!blocks[i]) return -1;
      sizes[i] = n;
      check_block((uintptr_t)blocks[i], n);
      memset(blocks[i], id, n);
    }
    for (int i = 0; i < N; i++) {
      if (verify_block(blocks[i], sizes[i], id)) return -2;
      if (malloc_usable_size(blocks[i]) < sizes[i]) return -3;
      free(blocks[i]);
    }
  }
  return 0;
}

__attribute__((export_name("member_wait32"))) int member_wait32(int32_t *addr, int32_t expected, int64_t timeout_ns) {
  return __builtin_wasm_memory_atomic_wait32(addr, expected, timeout_ns);
}
__attribute__((export_name("member_notify"))) int member_notify(int32_t *addr, int count) {
  return __builtin_wasm_memory_atomic_notify(addr, count);
}
__attribute__((export_name("member_add"))) int member_add(int32_t *addr, int32_t v) {
  return __atomic_fetch_add(addr, v, __ATOMIC_SEQ_CST);
}
__attribute__((export_name("member_load"))) int member_load(int32_t *addr) {
  return __atomic_load_n(addr, __ATOMIC_SEQ_CST);
}
__attribute__((noinline)) static int sum(volatile int *v, int n) {
  int s = 0;
  for (int i = 0; i < n; i++) s += v[i];
  return s;
}
__attribute__((export_name("member_stack"))) int member_stack(int id) {
  volatile int local[64];
  for (int i = 0; i < 64; i++) local[i] = id;
  return sum(local, 64);
}
__attribute__((export_name("member_stack_addr"))) uintptr_t member_stack_addr(void) {
  volatile int x = 0;
  volatile uintptr_t a = (uintptr_t)&x;
  return a;
}

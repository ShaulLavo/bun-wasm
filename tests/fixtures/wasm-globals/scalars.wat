(module
  (import "e" "callback" (func))
  (import "e" "a" (global $a i32))
  (import "e" "memory" (memory 1))
  (import "e" "b" (global $b i32))
  (global $defined i32 (global.get $a))
  (export "a" (global $a)) (export "alias" (global $a))
  (export "b" (global $b)) (export "defined" (global $defined)))

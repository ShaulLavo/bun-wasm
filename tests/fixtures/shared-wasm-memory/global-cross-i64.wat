(module
  (import "env" "memory" (memory 1 2 shared))
  (import "env" "g" (global i64))
  (func $start i32.const 0 i32.const 99 i32.store8)
  (start $start))

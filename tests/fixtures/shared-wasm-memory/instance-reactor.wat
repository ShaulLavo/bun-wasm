(module
  (import "env" "memory" (memory 1 3 shared))
  (export "memory" (memory 0))
  (func (export "_initialize")
    i32.const 0 i32.const 42 i32.atomic.store))

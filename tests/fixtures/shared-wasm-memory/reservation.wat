(module
  (import "env" "memory" (memory 1 65536 shared))
  (func (export "pages") (result i32) memory.size)
  (func (export "grow") (param i32) (result i32) local.get 0 memory.grow)
  (func (export "read") (param i32) (result i32) local.get 0 i32.atomic.load))

(module
  (memory (export "memory") 1 2 shared)
  (data (i32.const 0) "\2a\00\00\00")
  (func (export "read") (result i32) i32.const 0 i32.atomic.load)
  (func (export "grow") (param i32) (result i32) local.get 0 memory.grow))

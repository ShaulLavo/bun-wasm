(module
  (type $unary (func (param i32) (result i32)))
  (import "env" "callback" (func $callback (type $unary)))
  (memory (export "memory") 1 3)
  (table (export "table") 2 4 funcref)
  (func $write (export "write") (type $unary)
    i32.const 0 local.get 0 i32.store8
    local.get 0 call $callback)
  (func $grow (export "grow") (type $unary) local.get 0 memory.grow)
  (elem (i32.const 0) $write)
  (func (export "read") (result i32) i32.const 0 i32.load8_u))

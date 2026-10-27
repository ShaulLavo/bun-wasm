(module
 (memory (export "memory") 1 3)
 (func (export "read") (result i32) i32.const 0 i32.load8_u)
 (func (export "write") (param i32) i32.const 0 local.get 0 i32.store8)
 (func (export "grow") (param i32) (result i32) local.get 0 memory.grow))

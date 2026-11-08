(module
  (memory 1 2 shared)
  (func (export "ok") (result i32) i32.const 1)
  (func (export "parameter") (param v128) (result i32) i32.const 2)
  (func (export "result") (result v128) v128.const i32x4 1 2 3 4))

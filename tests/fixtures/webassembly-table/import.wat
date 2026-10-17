(module
  (type $unary (func (param i32) (result i32)))
  (import "env" "table" (table 2 5 funcref))
  (export "table" (table 0))
  (func (export "invoke") (param i32 i32) (result i32)
    (local.get 1) (local.get 0) (call_indirect (type $unary)))
)

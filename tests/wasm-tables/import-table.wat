(module
  (type $unary (func (param i32) (result i32)))
  (import "env" "callback" (func (type $unary)))
  (import "env" "table" (table 2 4 funcref))
  (export "table" (table 0))
  (func (export "call") (param i32 i32) (result i32)
    local.get 0 local.get 1 call_indirect (type $unary)))

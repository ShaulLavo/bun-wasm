(module
  (type $unary (func (param i32) (result i32)))
  (import "env" "callback" (func $callback (type $unary)))
  (table (export "table") (export "alias") 2 4 funcref)
  (func $inc (export "inc") (type $unary) local.get 0 i32.const 1 i32.add)
  (func (export "call") (param i32 i32) (result i32)
    local.get 0 local.get 1 call_indirect (type $unary))
  (elem (i32.const 0) $inc $callback))

(module
  (type $unary (func (param i32) (result i32)))
  (table (export "table") (export "alias") 2 5 funcref)
  (func $add (export "add") (type $unary) (local.get 0) (i32.const 1) (i32.add))
  (elem (i32.const 0) $add)
  (func (export "invoke") (param i32 i32) (result i32)
    (local.get 1) (local.get 0) (call_indirect (type $unary)))
)

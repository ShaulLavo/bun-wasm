;; A second module that imports another instance's function and keeps it in its own table.
(module
  (type $binary (func (param i32 i32) (result i32)))
  (type $unary (func (param i32) (result i32)))
  (import "peer" "add" (func $add (type $binary)))
  (table $table 3 funcref)
  (elem (i32.const 0) $add $double)
  (func $double (type $unary) local.get 0 i32.const 2 i32.mul)
  (export "table" (table $table)))

;; Exports its function table and no global, as an emnapi binding does.
(module
  (type $binary (func (param i32 i32) (result i32)))
  (type $wide (func (param i64 i32) (result i64)))
  (type $callback (func (param f64) (result f64)))
  (import "env" "memory" (memory 1 2 shared))
  (import "env" "first" (func $first (type $binary)))
  (import "env" "callback" (func $callback (type $callback)))
  (table $table 6 8 funcref)
  (elem (i32.const 0) $add $hidden $callback $wide $first)
  (func $add (type $binary) local.get 0 local.get 1 i32.add)
  (func $hidden (type $binary) local.get 0 local.get 1 i32.sub)
  (func $wide (type $wide) local.get 0 local.get 1 i64.extend_i32_s i64.add)
  (func (export "call") (param i32 i32 i32) (result i32)
    local.get 1
    local.get 2
    local.get 0
    call_indirect (type $binary))
  (func (export "clearEntry") (param i32) local.get 0 ref.null func table.set $table)
  (func (export "storeHidden") (param i32) local.get 0 ref.func $hidden table.set $table)
  (func (export "touch") (param i32) (result i32) local.get 0 i32.load8_u)
  (export "add" (func $add))
  (export "table" (table $table))
  (export "__indirect_function_table" (table $table)))

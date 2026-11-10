;; Tables as the Browser nested host sees them. Assemble with `wasm-tools parse`.
(module
  (type $binary (func (param i32 i32) (result i32)))
  (type $wide (func (param i64 i32) (result i64)))
  (type $callback (func (param f64) (result f64)))
  (type $reference (func (param funcref) (result i32)))
  (import "env" "first" (func $first (type $binary)))
  (import "env" "callback" (func $callback (type $callback)))
  (table $table 7 9 funcref)
  (table $loose 1 funcref)
  (table $externs 1 externref)
  (elem (table $table) (i32.const 0) func $add $hidden $callback $wide $takesReference $first)
  (func $add (type $binary) local.get 0 local.get 1 i32.add)
  (func $hidden (type $binary) local.get 0 local.get 1 i32.sub)
  (func $wide (type $wide) local.get 0 local.get 1 i64.extend_i32_s i64.add)
  (func $takesReference (type $reference) local.get 0 ref.is_null)
  (func (export "call") (param i32 i32 i32) (result i32)
    local.get 1
    local.get 2
    local.get 0
    call_indirect $table (type $binary))
  (func (export "clear") (param i32) local.get 0 ref.null func table.set $table)
  (func (export "store") (param i32) local.get 0 ref.func $hidden table.set $table)
  (func (export "size") (result i32) table.size $table)
  (export "add" (func $add))
  (export "table" (table $table))
  (export "__indirect_function_table" (table $table))
  (export "loose" (table $loose))
  (export "externs" (table $externs)))

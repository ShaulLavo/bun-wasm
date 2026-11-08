(module
  (import "env" "memory" (memory 1 2 shared))
  (import "env" "echo" (func $echo (param i64 f32 f64) (result i64 f32 f64)))
  (import "env" "value" (global $value i64))
  (func (export "echo") (param i64 f32 f64) (result i64 f32 f64)
    local.get 0 local.get 1 local.get 2 call $echo)
  (func (export "value") (result i64) global.get $value))

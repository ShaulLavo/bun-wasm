(module
  (import "env" "memory" (memory 1 2 shared))
  (import "env" "value" (func $one (param i32) (result i32)))
  (import "env" "value" (func $two (param i32) (result i32)))
  (func (export "first") (result i32) i32.const 1 call $one)
  (func (export "second") (result i32) i32.const 2 call $two))

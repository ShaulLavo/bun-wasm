(module
  (import "env" "memory" (memory 1 2 shared))
  (import "env" "observe" (func))
  (import "env" "peer" (func $peer (param i64) (result i64)))
  (func (export "go") (param i64) (result i64) local.get 0 call $peer))

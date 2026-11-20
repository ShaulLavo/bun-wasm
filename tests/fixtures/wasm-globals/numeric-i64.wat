(module
  (import "e" "g" (global $g (mut i64)))
  (export "g" (global $g))
  (func (export "get") (result i64) global.get $g)
  (func (export "set") (param i64) local.get 0 global.set $g))

(module
  (import "e" "g" (global $g (mut i32)))
  (export "g" (global $g))
  (func (export "get") (result i32) global.get $g)
  (func (export "set") (param i32) local.get 0 global.set $g))

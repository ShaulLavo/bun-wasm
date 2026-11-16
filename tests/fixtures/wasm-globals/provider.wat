(module
  (global $g (export "g") (export "alias") (mut i32) (i32.const 7))
  (global (export "equal") (mut i32) (i32.const 7))
  (global (export "immutable") i32 (i32.const 7))
  (func (export "get") (result i32) global.get $g)
  (func (export "set") (param i32) local.get 0 global.set $g))

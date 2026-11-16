(module
  (import "e" "g" (global $g (mut i32)))
  (func $start i32.const 23 global.set $g)
  (start $start) (export "g" (global $g)))

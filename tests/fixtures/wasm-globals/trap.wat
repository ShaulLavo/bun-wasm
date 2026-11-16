(module
  (import "e" "g" (global $g (mut i32)))
  (func $start i32.const 31 global.set $g unreachable)
  (start $start) (export "g" (global $g)))

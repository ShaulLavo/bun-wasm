(module
  (global (export "i") i32 (i32.const 7))
  (global (export "mutable") (mut i32) (i32.const 9))
  (global (export "f") f64 (f64.const 1.25)))

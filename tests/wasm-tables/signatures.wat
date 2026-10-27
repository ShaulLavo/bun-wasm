(module
  (import "env" "callback" (func $integer (param i32) (result i32)))
  (import "env" "callback" (func $reference (param externref) (result externref)))
  (export "integer" (func $integer))
  (export "reference" (func $reference)))
